import { INSTANCE_PARAM_DESCRIPTION, instanceArgs, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ServiceId, serviceOf } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { NextStep } from '../core/nextStep.ts';
import {
    hasBookMetadata,
    hasMediaAdd,
    hasMediaUpdate,
    hasMetadataProfiles,
    type ArtistMonitorNewItems,
    type BookField,
    type BookFields,
    type BookMetadataCapable,
    type MediaAddCapable,
    type MediaUpdateCapable,
    type QualityProfile,
    type ServiceAdapter
} from '../services/types.ts';
import { describeBookChange, diffBookFields } from './bookMetadata.ts';
import { chooseOne, freeSpace, FOLDER_MATCH, PROFILE_MATCH, TAG_MATCH } from './chooseOne.ts';
import { NO_ALBUMS_PROFILE, SEARCH_AFTER_REFRESH } from './lidarrProfiles.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';

/**
 * `add_media`'s counterpart, and the only way to change a **Radarr** item's
 * monitoring at all — `set_monitoring` covers series and artists, never films.
 *
 * Safe tier. Every field here is one the same tool can set back, and the one
 * that touches disk — a root folder change — asks the service to *move* the
 * files, which loses nothing and is undone by moving them back. `add_media`,
 * which starts multi-gigabyte downloads, is safe on the same reasoning. The
 * preview still spells the move out, because "change the root folder" reads
 * cheaper than it is. A Lidarr metadata profile is the exception, and the one
 * field that makes the call destructive: switching to a narrower profile lets
 * the next refresh delete the albums it leaves out, and switching back brings
 * them in again as new albums, without their old flags (see
 * `metadataProfileEffect`). The same tool cannot set that back.
 *
 * A Lidarr `move_files: false` change stays safe. It can leave the track files'
 * recorded paths at the new root folder (see `pointedWithoutMoving`), which the
 * preview names, and moving the files there with `move_files: true` and back
 * sets them right again.
 */

/** What each of Lidarr's rules for new albums does with the albums a broader profile brings in. */
const BROUGHT_IN: Readonly<Record<ArtistMonitorNewItems, string>> = {
    all: `Albums it brings in are monitored (\`monitor_new_items\` is \`all\`). ${SEARCH_AFTER_REFRESH}`,
    new: `Albums it brings in are monitored when released on or after the newest dated album the artist already has that the new profile also lists, and every one when there is none (\`monitor_new_items\` is \`new\`). ${SEARCH_AFTER_REFRESH}`,
    none: 'Albums it brings in are not monitored (`monitor_new_items` is `none`).'
};

/**
 * A metadata profile switch, which the Artist Editor does not apply: Lidarr
 * does at the artist's next refresh (`ArtistService.UpdateArtists` publishes no
 * `ArtistEditedEvent`). That refresh removes the albums the new profile leaves
 * out unless they have files or were added by hand
 * (`RefreshAlbumService.ShouldDelete`), and a switch back brings them in again
 * as new albums, flagged by the artist's `monitorNewItems` rather than with
 * their old flags (`RefreshArtistService.ProcessChildren`). So the same tool
 * cannot always set this field back. The albums it brings in are flagged by
 * that rule; `new` compares them with the artist's dated albums that the new
 * profile also lists (`children.Updated`), and monitors every one when there
 * is none (`MonitorNewAlbumService`).
 *
 * The next refresh may not come until the artist changes upstream. Lidarr's
 * daily `RefreshArtist` takes only the artists its metadata server lists as
 * changed since the last run (`GetChangedArtists`). It goes by age instead
 * (`ShouldRefreshArtist`: an active artist two days after its last refresh,
 * an ended one 30 days after, or 12 hours after when its newest album came out
 * in the last 30 days or is still to come) only when that list is empty or
 * marked limited, or was not asked for because the previous run started over
 * 14 days ago. Before 3.1.5.5066 it goes by age only when the list is marked
 * limited, and after such a gap refreshes no artist at all
 * (`RefreshArtistService`). So the preview says so, and an applied switch
 * offers `trigger_scan` on the artist, which refreshes it now.
 */
function metadataProfileEffect(
    from: string,
    to: QualityProfile,
    rule: ArtistMonitorNewItems | undefined,
    offered: boolean
): string {
    const head = `Switches the metadata profile from ${from} to ${to.display} (id ${to.id}). Lidarr applies it at the artist's next refresh, which this does not start and which may not come until the artist changes upstream: Lidarr's daily refresh takes only the artists its metadata server lists as changed, and goes by age (an active artist two days after its last refresh, an ended one 30 days after, or 12 hours after when its newest album came out in the last 30 days or is still to come) only when that list is empty or marked limited, or the previous run started over 14 days ago (before Lidarr 3.1.5.5066, only when the list is marked limited). trigger_scan with the artist's \`id\` refreshes it now${offered ? ', and is offered once this is applied' : '; it is not offered here, since it also rescans the root folders: run it once the files are in the new root folder'}.`;
    if (to.name === NO_ALBUMS_PROFILE) {
        return `${head} None lists no albums for the artist, so that refresh removes every album without files that was not added by hand, and switching back later brings them in again as new albums, flagged by \`monitor_new_items\` rather than as they are now.`;
    }
    const brought = rule === undefined ? "Albums it brings in are flagged by the artist's rule for new albums, `monitor_new_items`." : BROUGHT_IN[rule];
    return `${head} Any album the new profile leaves out is removed then, unless it has files or was added by hand, and switching back later brings it in again as a new album, without its old flag. ${brought}`;
}

/**
 * `move_files: false`. The files stay where they are. On Lidarr, when the
 * artist's current folder is still on disk, the editor's `BulkMoveArtist`
 * still publishes `ArtistMovedEvent`, whose handler rewrites every track
 * file's recorded path, which Lidarr keeps whole, into the new root folder
 * (`MediaFileService.Handle(ArtistMovedEvent)`), under the artist folder its
 * naming scheme gives (`MoveArtistService` builds it with `GetArtistFolder`,
 * while the artist keeps its own folder name: `ArtistPathBuilder.BuildPath`).
 * Nothing checks those paths outside a scan, so the tracks still count as
 * having files (`ArtistStatisticsRepository` counts `TrackFileId`), and a scan
 * can drop the records it cannot find (`MediaFileTableCleanupService.Clean`).
 * A switch back does not undo the rewrite: `MoveArtistService.MoveSingleArtist`
 * returns before the event when the folder it moves from is not on disk. When
 * the folder is already gone (the files were moved by hand), nothing is
 * rewritten.
 */
function pointedWithoutMoving(service: string, folder: string, lidarr: boolean): string {
    const head = `Points ${service} at ${folder} without moving anything.`;
    if (!lidarr) return `${head} The files stay where they are, so ${service} reports them missing until they are moved and rescanned.`;
    return `${head} If the artist's current folder is still on disk, Lidarr also rewrites every track file's recorded path to the new root folder while the files stay where they are. It keeps counting them as present, and a library scan before they are moved there can drop their records. Switching back restores the artist's folder but not those paths, since Lidarr skips the move when the folder it moves from is not on disk.`;
}

/**
 * The artist flag is not the album flag: an artist grabs only for its
 * monitored albums, and this changes none of them. RSS sync and Lidarr's own
 * searches skip an unmonitored artist, but `trigger_search` does not
 * (`MonitoredAlbumSpecification`). That holds under `None` too: the editor
 * starts no refresh, and a refresh keeps the albums with files or added by
 * hand, so an artist on it can still have monitored albums.
 */
function artistMonitoredEffect(service: string, label: string, monitored: boolean): string {
    if (monitored) {
        return `${service} grabs automatically for ${label}, for the albums that are monitored. The albums keep their own flags; set_monitoring with \`level: "album"\` changes those.`;
    }
    return `${service} stops grabbing automatically for ${label}: RSS sync and its own searches skip it. The albums keep their own flags, trigger_search can still grab the monitored ones, and files already on disk are untouched.`;
}

const findAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & MediaUpdateCapable & MediaAddCapable => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasMediaUpdate(adapter) || !hasMediaAdd(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot update media`, {
            remedy: 'Only radarr (films), sonarr (series) and lidarr (artists) manage what a library item is set to.'
        });
    }
    return adapter;
};

/** The book fields `update_media` can lock or unlock, by the name a caller uses. */
const LOCKABLE = ['title', 'authors', 'series', 'series_number', 'tags'] as const;
type Lockable = (typeof LOCKABLE)[number];
const BOOK_FIELD_OF: Record<Lockable, BookField> = {
    title: 'title',
    authors: 'authors',
    series: 'seriesName',
    series_number: 'seriesNumber',
    tags: 'categories'
};
const NAME_OF: Partial<Record<BookField, Lockable>> = Object.fromEntries(
    Object.entries(BOOK_FIELD_OF).map(([name, field]) => [field, name])
);
const nameOf = (field: BookField): string => NAME_OF[field] ?? field;

const BOOK_ONLY = 'Grimmory books only. ';

/** The book library `service`/`instance` names, or undefined when it is not one. */
const bookLibrary = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): (ServiceAdapter & BookMetadataCapable) | undefined => {
    const adapter = resolveInstance(adapters, service, instance);
    return hasBookMetadata(adapter) ? adapter : undefined;
};

type BookArgs = {
    title?: string | undefined;
    authors?: string[] | undefined;
    series?: string | undefined;
    series_number?: number | undefined;
    tags?: string[] | undefined;
    lock_fields?: Lockable[] | undefined;
    unlock_fields?: Lockable[] | undefined;
};

/**
 * A hand edit to one book. Only the fields named are sent, and a field is
 * blanked only by an explicit `series: ""` or `tags: []`, never by leaving it
 * out. A locked field is refused here rather than skipped by the server, so
 * the preview never promises a change that will not land.
 */
async function planBook(book: ServiceAdapter & BookMetadataCapable, rawId: string, args: BookArgs): Promise<WritePlan> {
    // `58` or `grimmory:58`; anything else is refused before a request is made.
    const id = rawId.replace(/^grimmory:/, '');
    if (!/^\d+$/.test(id)) {
        throw new ServiceError('NotFound', book.type, `"${rawId}" is not a Grimmory book id`, {
            remedy: 'Pass the book id as digits, as in 58 or grimmory:58: `acquisition.id` on a get_library record.'
        });
    }
    const { title, authors, series, series_number, tags } = args;
    const lock = [...new Set(args.lock_fields ?? [])].map(n => BOOK_FIELD_OF[n]);
    const unlock = [...new Set(args.unlock_fields ?? [])].map(n => BOOK_FIELD_OF[n]);

    if (
        title === undefined &&
        authors === undefined &&
        series === undefined &&
        series_number === undefined &&
        tags === undefined &&
        lock.length === 0 &&
        unlock.length === 0
    ) {
        throw new Error('Nothing to change. Name at least one of title, authors, series, series_number, tags, lock_fields or unlock_fields.');
    }
    const both = lock.filter(f => unlock.includes(f));
    if (both.length > 0) {
        throw new Error(`Cannot lock and unlock the same field in one call: ${both.map(nameOf).join(', ')} is in both lock_fields and unlock_fields.`);
    }
    if (tags?.some(t => t.trim() === '')) {
        throw new Error('A tag cannot be blank. Pass [] to clear the categories.');
    }
    if (title !== undefined && title.trim() === '') throw new Error('The title cannot be blank.');
    if (authors?.some(a => a.trim() === '')) throw new Error('An author cannot be blank.');
    if (series !== undefined && series !== '' && series.trim() === '') {
        throw new Error('The series cannot be blank. Pass "" to clear it.');
    }

    const state = await book.readBookMetadata(id);
    const wanted: BookFields = {
        ...(title === undefined ? {} : { title }),
        ...(authors === undefined ? {} : { authors }),
        ...(series === undefined || series === '' ? {} : { seriesName: series }),
        ...(series_number === undefined ? {} : { seriesNumber: series_number }),
        ...(tags === undefined || tags.length === 0 ? {} : { categories: tags })
    };
    // Explicit blanking, and only where there is something to blank.
    const clear: BookField[] = [
        ...(series === '' && state.fields.seriesName !== undefined ? (['seriesName'] as const) : []),
        ...(tags?.length === 0 && (state.fields.categories?.length ?? 0) > 0 ? (['categories'] as const) : [])
    ];

    const stillLocked = state.locked.filter(f => !unlock.includes(f));
    const { changes, keptLocked } = diffBookFields(state.fields, wanted, stillLocked, Object.keys(wanted) as BookField[]);
    const blocked = [...keptLocked, ...clear.filter(f => stillLocked.includes(f))];
    if (blocked.length > 0) {
        const it = blocked.length === 1 ? 'it' : 'them';
        throw new ServiceError('NotFound', book.type, `${blocked.map(nameOf).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} locked in Grimmory`, {
            remedy: `Add ${it} to unlock_fields in this same call to edit ${it}, or leave ${it} out.`
        });
    }
    const changed = [...(Object.keys(changes) as BookField[]), ...clear];
    if (changed.length > 0 && state.allLocked) {
        throw new ServiceError('NotFound', book.type, `${state.label} has every metadata field locked in Grimmory`, {
            remedy: 'Unlock the book in Grimmory first; unlock_fields only releases single fields.'
        });
    }

    // A lock already in the wanted state is not a change.
    const lockNow = lock.filter(f => !state.locked.includes(f));
    const unlockNow = unlock.filter(f => state.locked.includes(f));

    const target = `grimmory:${id}`;
    if (changed.length === 0 && lockNow.length === 0 && unlockNow.length === 0) {
        return { target, summary: `${state.label} already has those values and locks in Grimmory.`, effects: [], noop: true };
    }

    const effects = [
        ...(Object.keys(changes) as BookField[]).map(f => describeBookChange(f, state.fields[f], changes[f])),
        ...clear.map(f => describeBookChange(f, state.fields[f], undefined)),
        ...(unlockNow.length === 0 ? [] : [`Unlocks ${unlockNow.map(nameOf).join(', ')} first, so the edit can land.`]),
        ...(lockNow.length === 0
            ? []
            : [`Locks ${lockNow.map(nameOf).join(', ')} afterwards, so a later metadata refresh leaves ${lockNow.length === 1 ? 'it' : 'them'} alone.`]),
        ...(changed.length === 0
            ? []
            : ['Grimmory may also write the new metadata into the book file, and move it to match its naming pattern, when its metadata settings say so.'])
    ];
    const parts = [...(changed.length === 0 ? [] : [changed.map(nameOf).join(', ')]), ...(lockNow.length + unlockNow.length === 0 ? [] : ['field locks'])];

    return {
        target,
        summary: `Change the ${parts.join(' and ')} of ${state.label} in Grimmory.`,
        effects,
        // The changes themselves are bound, not the strings that were asked for.
        args: { service: 'grimmory', id, fields: changes, clear, lock: lockNow, unlock: unlockNow }
    };
}

export function registerUpdateMedia(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'update_media',
        title: 'Change what a library item is set to',
        description:
            'Changes settings on an item already in Radarr[[lidarr: , Lidarr]] or Sonarr (quality profile, root folder, monitoring, tags, Radarr\'s minimum availability, Sonarr\'s series type[[lidarr: , Lidarr\'s metadata profile]]), or edits a Grimmory book\'s title, authors, series, series number and tags, with `lock_fields` or `unlock_fields`. The only way to change a Radarr item\'s monitoring. [[lidarr: On Lidarr, `id` is an artist, `monitor_new_items` stays with set_monitoring, and a new metadata profile applies at the artist\'s next refresh, which can remove albums.]] Takes `service` and `id`. Changing `root_folder` **moves the files on disk** unless `move_files: false`. `tags` replaces the whole set and an unknown tag is refused; stack_health at `detail: "full"` lists profiles, folders and tags. [[grimmory: A locked book field is refused unless the same call unlocks it, and Grimmory may write the change into the book file and rename it.]] Previews first; confirm to apply. Field reference: arr://docs/update_media.',
        inputSchema: z.object({
            service: serviceOf(['radarr', 'sonarr', 'lidarr', 'grimmory']).describe('radarr for a film, sonarr for a series, lidarr for an artist, grimmory for a book.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z
                .string()
                .min(1)
                .describe("The item's id within that service — `acquisition.id` on a get_library or get_media_details record."),
            quality_profile: z.string().optional().describe('Profile name or id to switch to.'),
            root_folder: z
                .string()
                .optional()
                .describe('Root folder path, or any distinctive part of it. Moves the files there unless move_files is false.'),
            monitored: z
                .boolean()
                .optional()
                .describe('Monitor it, or stop. Works on Radarr, Sonarr and Lidarr, where it is the artist’s own flag and the albums keep theirs.'),
            minimum_availability: z
                .enum(['announced', 'inCinemas', 'released'])
                .optional()
                .describe('Radarr only: how early it may grab.'),
            series_type: z
                .enum(['standard', 'daily', 'anime'])
                .optional()
                .describe('Sonarr only: the numbering scheme.'),
            metadata_profile: z
                .string()
                .optional()
                .describe(
                    'Lidarr only: metadata profile name or id to switch to, which decides the album types and release statuses the artist gets. It applies at the artist’s next refresh, which this does not start and which may not come until the artist changes upstream; trigger_scan with the artist’s `id` refreshes it now. A name that matches none is refused, listing the ones the instance has.'
                ),
            tags: z
                .array(z.string())
                .optional()
                .describe(
                    'Tag labels or ids that already exist. Replaces the whole set — pass [] to clear it. On a Grimmory book these are its categories: free text that need not exist yet, replacing the set.'
                ),
            title: z.string().min(1).optional().describe(`${BOOK_ONLY}The new title.`),
            authors: z.array(z.string().min(1)).min(1).optional().describe(`${BOOK_ONLY}The authors; replaces the list.`),
            series: z.string().optional().describe(`${BOOK_ONLY}The series name. "" clears it.`),
            series_number: z.number().positive().optional().describe(`${BOOK_ONLY}The book's number in its series.`),
            lock_fields: z
                .array(z.enum(LOCKABLE))
                .min(1)
                .optional()
                .describe(`${BOOK_ONLY}Fields to lock after writing, so a metadata refresh leaves them alone.`),
            unlock_fields: z
                .array(z.enum(LOCKABLE))
                .min(1)
                .optional()
                .describe(`${BOOK_ONLY}Fields to unlock before writing. A locked field is refused unless this call unlocks it.`),
            move_files: z
                .boolean()
                .default(true)
                .describe(
                    'With root_folder: whether the service moves the files to the new folder. Defaults to true. False only when you have already moved them yourself.'
                )
        }),
        // The resolved instance id, not the bare type — permissions are
        // granted per instance.
        service: ({ service, instance }) => (bookLibrary(adapters, service, instance) ?? findAdapter(adapters, service, instance)).id,
        operation: 'update_media',
        tier: ({ metadata_profile }) => (metadata_profile === undefined ? 'safe' : 'destructive'),

        async plan({
            service,
            instance,
            id,
            quality_profile,
            root_folder,
            monitored,
            minimum_availability,
            series_type,
            tags,
            move_files,
            title,
            authors,
            series,
            series_number,
            lock_fields,
            unlock_fields,
            metadata_profile
        }): Promise<WritePlan> {
            const books = bookLibrary(adapters, service, instance);
            if (books !== undefined) {
                if (
                    quality_profile !== undefined ||
                    root_folder !== undefined ||
                    monitored !== undefined ||
                    minimum_availability !== undefined ||
                    series_type !== undefined ||
                    metadata_profile !== undefined
                ) {
                    throw new ServiceError('NotFound', service, 'a book has no film, series or artist settings', {
                        remedy: 'Drop quality_profile, root_folder, monitored, minimum_availability, series_type and metadata_profile. A book takes title, authors, series, series_number, tags, lock_fields and unlock_fields.'
                    });
                }
                return planBook(books, id, { title, authors, series, series_number, tags, lock_fields, unlock_fields });
            }
            if (
                title !== undefined ||
                authors !== undefined ||
                series !== undefined ||
                series_number !== undefined ||
                lock_fields !== undefined ||
                unlock_fields !== undefined
            ) {
                throw new ServiceError('NotFound', service, 'title, authors, series, series_number and the field locks are Grimmory options', {
                    remedy: 'Films, series and artists are not edited by hand here. Drop them, or name a Grimmory book.'
                });
            }
            const adapter = findAdapter(adapters, service, instance);
            const lidarr = adapter.type === 'lidarr';

            if (
                quality_profile === undefined &&
                root_folder === undefined &&
                monitored === undefined &&
                minimum_availability === undefined &&
                series_type === undefined &&
                tags === undefined &&
                metadata_profile === undefined
            ) {
                throw new Error(
                    'Nothing to change. Name at least one of quality_profile, root_folder, monitored, tags, minimum_availability, series_type or metadata_profile.'
                );
            }

            // Refused rather than dropped, and named for the service that does
            // have the option — same rule as add_media.
            if (series_type !== undefined && adapter.type !== 'sonarr') {
                throw new ServiceError('NotFound', service, 'series_type is a Sonarr option', {
                    remedy: lidarr ? 'An artist has no numbering scheme. Drop it.' : 'Films have no numbering scheme. Drop it.'
                });
            }
            if (minimum_availability !== undefined && adapter.type !== 'radarr') {
                throw new ServiceError('NotFound', service, 'minimum_availability is a Radarr option', {
                    remedy: lidarr
                        ? 'Lidarr has no availability threshold. Use set_monitoring to choose which albums.'
                        : 'Sonarr grabs each episode as it airs. Use set_monitoring to choose which seasons.'
                });
            }
            if (metadata_profile !== undefined && !lidarr) {
                throw new ServiceError('NotFound', service, 'metadata_profile is a Lidarr option', {
                    remedy: 'Only an artist has a metadata profile. Use quality_profile for a film or series.'
                });
            }

            // Only the lists this call actually needs: an update of monitoring
            // alone must not fail because the tag endpoint is down.
            const [current, profiles, folders, knownTags, metadataProfiles] = await Promise.all([
                adapter.readForUpdate(id),
                quality_profile === undefined ? Promise.resolve([]) : adapter.listQualityProfiles(),
                root_folder === undefined ? Promise.resolve([]) : adapter.listRootFolders(),
                tags === undefined ? Promise.resolve([]) : adapter.listTags(),
                metadata_profile === undefined || !hasMetadataProfiles(adapter) ? Promise.resolve([]) : adapter.listMetadataProfiles()
            ]);

            const label = titled(current.title, current.year);
            const profile =
                quality_profile === undefined
                    ? undefined
                    : chooseOne(profiles, quality_profile, PROFILE_MATCH, p => `${p.display} (id ${p.id})`, 'quality profile', service);
            const folder =
                root_folder === undefined
                    ? undefined
                    : chooseOne(folders, root_folder, FOLDER_MATCH, f => `${f.display} (${freeSpace(f)})`, 'root folder', service);
            const metadataProfile =
                metadata_profile === undefined
                    ? undefined
                    : chooseOne(
                          metadataProfiles,
                          metadata_profile,
                          PROFILE_MATCH,
                          p => `${p.display} (id ${p.id})`,
                          'metadata profile',
                          service
                      );
            const resolvedTags =
                tags === undefined
                    ? undefined
                    : tags.map(requested =>
                          chooseOne(knownTags, requested, TAG_MATCH, t => `${t.display} (id ${t.id})`, 'tag', service)
                      );

            const effects: string[] = [];
            const changes: string[] = [];

            if (profile !== undefined && profile.id !== current.qualityProfileId) {
                const from =
                    current.qualityProfileId === undefined
                        ? 'its current profile'
                        : (profiles.find(p => p.id === current.qualityProfileId)?.display ??
                          `profile id ${current.qualityProfileId}`);
                effects.push(
                    `Switches the quality profile from ${from} to ${profile.display} (id ${profile.id}). Existing files are left alone; the profile decides what is grabbed or upgraded next.`
                );
                changes.push('quality profile');
            }

            if (metadataProfile !== undefined && metadataProfile.id !== current.metadataProfileId) {
                const from =
                    current.metadataProfileId === undefined
                        ? 'its current profile'
                        : (metadataProfiles.find(p => p.id === current.metadataProfileId)?.display ??
                          `profile id ${current.metadataProfileId}`);
                effects.push(metadataProfileEffect(from, metadataProfile, current.monitorNewItems, folder === undefined || move_files));
                changes.push('metadata profile');
            }

            if (folder !== undefined) {
                effects.push(
                    move_files
                        ? `Moves the files from ${current.path ?? 'their current folder'} into ${folder.display} (${freeSpace(folder)}). ${service} does the move itself; on a large item it takes a while and the files are unavailable until it finishes.`
                        : pointedWithoutMoving(service, folder.display, lidarr)
                );
                changes.push('root folder');
            }

            if (monitored !== undefined && monitored !== current.monitored) {
                effects.push(
                    lidarr
                        ? artistMonitoredEffect(service, label, monitored)
                        : monitored
                          ? `${service} will search for anything missing from ${label}.`
                          : `${service} will stop searching for ${label}. Files already on disk are untouched.`
                );
                changes.push('monitoring');
            }

            if (minimum_availability !== undefined && minimum_availability !== current.minimumAvailability) {
                effects.push(`Will not grab anything until the film is ${minimum_availability}.`);
                changes.push('minimum availability');
            }

            if (series_type !== undefined && series_type !== current.seriesType) {
                effects.push(`Treats it as ${series_type} numbering, which changes how episodes are matched.`);
                changes.push('series type');
            }

            const tagIds = resolvedTags?.map(t => t.id);
            const tagsChanged =
                tagIds !== undefined &&
                (tagIds.length !== current.tagIds.length || tagIds.some(t => !current.tagIds.includes(t)));
            if (tagsChanged) {
                effects.push(
                    tagIds.length === 0
                        ? 'Removes every tag.'
                        : `Sets the tags to ${resolvedTags?.map(t => t.display).join(', ')}, replacing whatever it had.`
                );
                changes.push('tags');
            }

            const target = `${adapter.id}:${id}`;

            // A folder change is never a no-op even when the path looks the
            // same: `root_folder` is matched loosely, and the service decides
            // where inside it the item lands.
            if (effects.length === 0) {
                return {
                    target,
                    summary: `${label} is already set that way in ${service}.`,
                    effects: [],
                    noop: true
                };
            }

            return {
                target,
                summary: `Change the ${changes.join(', ')} of ${label} in ${service}.`,
                effects,
                // The resolved ids and raw paths, never the requested strings:
                // the token has to commit to what was previewed, and a fenced
                // display path is not a directory.
                args: {
                    service,
                    id,
                    ...(profile === undefined ? {} : { qualityProfileId: profile.id }),
                    ...(folder === undefined ? {} : { rootFolderPath: folder.path, moveFiles: move_files }),
                    ...(monitored === undefined ? {} : { monitored }),
                    ...(minimum_availability === undefined ? {} : { minimumAvailability: minimum_availability }),
                    ...(series_type === undefined ? {} : { seriesType: series_type }),
                    ...(tagIds === undefined ? {} : { tagIds }),
                    ...(metadataProfile === undefined || metadataProfile.id === current.metadataProfileId
                        ? {}
                        : { metadataProfileId: metadataProfile.id })
                }
            };
        },

        // A new metadata profile waits for the artist's next refresh, which may
        // not come until the artist changes upstream (see
        // `metadataProfileEffect`), so the refresh is offered.
        // Not after a `move_files: false` change in the same call: the refresh
        // rescans every root folder, which can drop the track records whose
        // files have not reached the new root folder yet.
        followUps(_outcome, { service, instance, id }, plan): NextStep[] {
            const a = plan.args as { metadataProfileId?: number; rootFolderPath?: string; moveFiles?: boolean };
            if (a.metadataProfileId === undefined) return [];
            if (a.rootFolderPath !== undefined && a.moveFiles === false) return [];
            return [
                {
                    tool: 'trigger_scan',
                    arguments: { ...instanceArgs(findAdapter(adapters, service, instance).id), id },
                    why: "Refreshes the artist now, and rescans every root folder unless Lidarr's 'Rescan Artist Folder after Refresh' is set to Never, so Lidarr applies the new metadata profile, with the album changes the preview described."
                }
            ];
        },

        async apply(plan, { service, instance, id }) {
            const books = bookLibrary(adapters, service, instance);
            if (books !== undefined) {
                // From the plan the token was verified against. Unlock first so
                // the write can land, lock last so the new values are kept.
                const bound = plan.args as { fields: BookFields; clear: BookField[]; lock: BookField[]; unlock: BookField[] };
                if (bound.unlock.length > 0) await books.setBookFieldLocks(id, bound.unlock, false);
                if (Object.keys(bound.fields).length > 0 || bound.clear.length > 0) await books.writeBookMetadata(id, bound.fields, bound.clear);
                if (bound.lock.length > 0) await books.setBookFieldLocks(id, bound.lock, true);
                return { changed: [...Object.keys(bound.fields), ...bound.clear] };
            }
            const a = plan.args as {
                qualityProfileId?: number;
                rootFolderPath?: string;
                moveFiles?: boolean;
                monitored?: boolean;
                minimumAvailability?: string;
                seriesType?: string;
                tagIds?: number[];
                metadataProfileId?: number;
            };

            // From the plan rather than re-resolved: re-running `chooseOne`
            // here could land on a profile added in between, and the token
            // guaranteed the one that was previewed.
            const state = await findAdapter(adapters, service, instance).updateMedia(id, {
                ...(a.qualityProfileId === undefined ? {} : { qualityProfileId: a.qualityProfileId }),
                ...(a.rootFolderPath === undefined ? {} : { rootFolderPath: a.rootFolderPath }),
                ...(a.monitored === undefined ? {} : { monitored: a.monitored }),
                ...(a.minimumAvailability === undefined ? {} : { minimumAvailability: a.minimumAvailability }),
                ...(a.seriesType === undefined ? {} : { seriesType: a.seriesType }),
                ...(a.tagIds === undefined ? {} : { tagIds: a.tagIds }),
                ...(a.metadataProfileId === undefined ? {} : { metadataProfileId: a.metadataProfileId }),
                moveFiles: a.moveFiles ?? false
            });

            return state;
        }
    });
}
