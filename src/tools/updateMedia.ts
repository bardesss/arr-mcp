import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import {
    hasBookMetadata,
    hasMediaAdd,
    hasMediaUpdate,
    type BookField,
    type BookFields,
    type BookMetadataCapable,
    type MediaAddCapable,
    type MediaUpdateCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { describeBookChange, diffBookFields } from './bookMetadata.ts';
import { chooseOne, freeSpace, FOLDER_MATCH, PROFILE_MATCH, TAG_MATCH } from './chooseOne.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * `add_media`'s counterpart, and the only way to change a **Radarr** item's
 * monitoring at all — `set_monitoring` is Sonarr's per-season tool and has
 * never covered films.
 *
 * Safe tier. Every field here is one the same tool can set back, and the one
 * that touches disk — a root folder change — asks the service to *move* the
 * files, which loses nothing and is undone by moving them back. `add_media`,
 * which starts multi-gigabyte downloads, is safe on the same reasoning. The
 * preview still spells the move out, because "change the root folder" reads
 * cheaper than it is.
 */

const findAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & MediaUpdateCapable & MediaAddCapable => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasMediaUpdate(adapter) || !hasMediaAdd(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot update media`, {
            remedy: 'Only radarr (films) and sonarr (series) manage what a library item is set to.'
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
async function planBook(book: ServiceAdapter & BookMetadataCapable, id: string, args: BookArgs): Promise<WritePlan> {
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
            'Changes settings on something already in Radarr or Sonarr, or edits a Grimmory book by hand: quality profile, root folder, monitoring, tags, Radarr’s minimum availability, Sonarr’s series type. The counterpart to add_media, which only ever adds — and the only way to change a **Radarr** item’s monitoring, since set_monitoring is Sonarr’s per-season tool. Takes `service` and `id`, never a title: take `id` from `acquisition.id` on a get_library or get_media_details record. Changing `root_folder` asks the service to **move the files on disk**; pass `move_files: false` to leave them where they are, which reports them missing until the next scan. `tags` replaces the whole tag set rather than adding to it, and an unknown label is refused — nothing here creates a tag. `stack_health` at `detail: "full"` lists the profiles, root folders and tags each instance actually has. A Grimmory book takes `title`, `authors`, `series` (`""` clears the series name), `series_number` and `tags` (which sets its categories; `[]` clears them), and optionally `lock_fields` or `unlock_fields`. Only the fields named are sent; a locked field is refused unless the same call unlocks it. Grimmory may also write the change into the book file and rename it to its naming pattern. Previews by default — call again with the returned `confirm` token to apply.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr for a film, sonarr for a series, grimmory for a book.'),
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
            monitored: z.boolean().optional().describe('Monitor it, or stop. Works on Radarr as well as Sonarr.'),
            minimum_availability: z
                .enum(['announced', 'inCinemas', 'released'])
                .optional()
                .describe('Radarr only: how early it may grab.'),
            series_type: z
                .enum(['standard', 'daily', 'anime'])
                .optional()
                .describe('Sonarr only: the numbering scheme.'),
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
        tier: 'safe',

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
            unlock_fields
        }): Promise<WritePlan> {
            const books = bookLibrary(adapters, service, instance);
            if (books !== undefined) {
                if (
                    quality_profile !== undefined ||
                    root_folder !== undefined ||
                    monitored !== undefined ||
                    minimum_availability !== undefined ||
                    series_type !== undefined
                ) {
                    throw new ServiceError('NotFound', service, 'a book has no film or series settings', {
                        remedy: 'Drop quality_profile, root_folder, monitored, minimum_availability and series_type. A book takes title, authors, series, series_number, tags, lock_fields and unlock_fields.'
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
                    remedy: 'Films and series are not edited by hand here. Drop them, or name a Grimmory book.'
                });
            }
            const adapter = findAdapter(adapters, service, instance);

            if (
                quality_profile === undefined &&
                root_folder === undefined &&
                monitored === undefined &&
                minimum_availability === undefined &&
                series_type === undefined &&
                tags === undefined
            ) {
                throw new Error(
                    'Nothing to change. Name at least one of quality_profile, root_folder, monitored, tags, minimum_availability or series_type.'
                );
            }

            // Refused rather than dropped, and named for the service that does
            // have the option — same rule as add_media.
            if (series_type !== undefined && adapter.type !== 'sonarr') {
                throw new ServiceError('NotFound', service, 'series_type is a Sonarr option', {
                    remedy: 'Films have no numbering scheme. Drop it.'
                });
            }
            if (minimum_availability !== undefined && adapter.type !== 'radarr') {
                throw new ServiceError('NotFound', service, 'minimum_availability is a Radarr option', {
                    remedy: 'Sonarr grabs each episode as it airs. Use set_monitoring to choose which seasons.'
                });
            }

            // Only the lists this call actually needs: an update of monitoring
            // alone must not fail because the tag endpoint is down.
            const [current, profiles, folders, knownTags] = await Promise.all([
                adapter.readForUpdate(id),
                quality_profile === undefined ? Promise.resolve([]) : adapter.listQualityProfiles(),
                root_folder === undefined ? Promise.resolve([]) : adapter.listRootFolders(),
                tags === undefined ? Promise.resolve([]) : adapter.listTags()
            ]);

            const label = `${current.title}${current.year === undefined ? '' : ` (${current.year})`}`;
            const profile =
                quality_profile === undefined
                    ? undefined
                    : chooseOne(profiles, quality_profile, PROFILE_MATCH, p => `${p.display} (id ${p.id})`, 'quality profile', service);
            const folder =
                root_folder === undefined
                    ? undefined
                    : chooseOne(folders, root_folder, FOLDER_MATCH, f => `${f.display} (${freeSpace(f)})`, 'root folder', service);
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

            if (folder !== undefined) {
                effects.push(
                    move_files
                        ? `Moves the files from ${current.path ?? 'their current folder'} into ${folder.display} (${freeSpace(folder)}). ${service} does the move itself; on a large item it takes a while and the files are unavailable until it finishes.`
                        : `Points ${service} at ${folder.display} without moving anything. The files stay where they are, so ${service} reports them missing until they are moved and rescanned.`
                );
                changes.push('root folder');
            }

            if (monitored !== undefined && monitored !== current.monitored) {
                effects.push(
                    monitored
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
                    ...(tagIds === undefined ? {} : { tagIds })
                }
            };
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
                moveFiles: a.moveFiles ?? false
            });

            return state;
        }
    });
}
