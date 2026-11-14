import { instanceArgs, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import type { NextStep } from '../core/nextStep.ts';
import {
    hasArtistMonitor,
    hasMediaAdd,
    hasMediaUpdate,
    hasMetadataProfiles,
    type ArtistMonitorNewItems,
    type MediaAddCapable,
    type MediaUpdateCapable,
    type QualityProfile,
    type ServiceAdapter
} from '../services/types.ts';
import { applyArtistPolicy, planArtistPolicy } from './artistPolicy.ts';
import { chooseOne, freeSpace, FOLDER_MATCH, PROFILE_MATCH, TAG_MATCH } from './chooseOne.ts';
import { NO_ALBUMS_PROFILE, SEARCH_AFTER_REFRESH } from './lidarrProfiles.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';

/**
 * `add_media`'s counterpart, and the only way to change a **Radarr** item's
 * monitoring at all; `set_monitoring` covers series and artists, never films.
 *
 * Safe tier. Every field here is one the same tool can set back, and the one
 * that touches disk (a root folder change) asks the service to *move* the
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
 * (`RefreshArtistService`). The preview gives only the outcome (the rules are
 * in `docs/tools.md`), and an applied switch offers `trigger_scan` on the
 * artist, which refreshes it now.
 */
function metadataProfileEffect(
    from: string,
    to: QualityProfile,
    rule: ArtistMonitorNewItems | undefined,
    offered: boolean
): string {
    const head = `Switches the metadata profile from ${from} to ${to.display} (id ${to.id}). Lidarr applies it at the artist's next refresh, which this does not start and which may not come until the artist changes upstream; trigger_scan with its \`id\` refreshes it now${offered ? ', and is offered once this is applied' : ', but is not offered here, since it also rescans the root folders: run it once the files are in the new root folder'}.`;
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

type Updatable = ServiceAdapter & MediaUpdateCapable & MediaAddCapable;

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'lidarr'],
    can: (a): a is Updatable => hasMediaUpdate(a) && hasMediaAdd(a),
    cannot: 'cannot update media',
    hint: 'Radarr manages films, Sonarr series and Lidarr artists.'
});

const UpdateMediaInput = z.object({
    ...targetInput(TARGET, '{{or: radarr=radarr for a film; sonarr=sonarr for a series; lidarr=lidarr for an artist}}.'),
    id: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The item's id within that service: `acquisition.id` on a get_library or get_media_details record. [[lidarr: Omit it with `monitored` or `monitor_new_items` alone to reach every artist.]]"
        ),
    quality_profile: z.string().min(1).optional().describe('Profile name or id to switch to.'),
    root_folder: z
        .string()
        .min(1)
        .optional()
        .describe('Root folder path, or any distinctive part of it. Moves the files there unless move_files is false.'),
    monitored: z
        .boolean()
        .optional()
        .describe('Monitor it, or stop.[[lidarr:  On Lidarr it is the artist’s own flag and the albums keep theirs.]]'),
    monitor_new_items: z
        .enum(['all', 'none', 'new'])
        .optional()
        .describe(
            '[[lidarr: Lidarr: the standing rule for albums Lidarr discovers later. `none` is what a finished, stable library wants. Alone or with `monitored`, no other setting.]][[sonarr:  Sonarr: `all` or `none`, whether seasons it finds later are monitored.]]'
        ),
    minimum_availability: z
        .enum(['announced', 'inCinemas', 'released'])
        .optional()
        .describe('[[radarr: Radarr only: how early it may grab.]]'),
    series_type: z
        .enum(['standard', 'daily', 'anime'])
        .optional()
        .describe('[[sonarr: Sonarr only: the numbering scheme.]]'),
    metadata_profile: z
        .string()
        .min(1)
        .optional()
        .describe(
            '[[lidarr: Lidarr only: metadata profile name or id to switch to, which decides the album types and release statuses the artist gets. It applies at the artist’s next refresh, which this does not start. A name that matches none is refused, listing the ones the instance has.]]'
        ),
    tags: z
        .array(z.string().min(1))
        .optional()
        .describe('Tag labels or ids that already exist. Replaces the whole set: pass [] to clear it.'),
    move_files: z
        .boolean()
        .default(true)
        .describe(
            'With root_folder: whether the service moves the files to the new folder. Defaults to true. False only when you have already moved them yourself.'
        )
});

export function registerUpdateMedia(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'update_media',
        title: 'Change what a library item is set to',
        description:
            '[[radarr|sonarr|lidarr: Changes settings on an item already in {{or: radarr=Radarr; sonarr=Sonarr; lidarr=Lidarr}}: quality profile, root folder, monitoring, tags]][[radarr: , Radarr\'s minimum availability]][[sonarr: , Sonarr\'s series type and rule for new seasons]][[lidarr: , Lidarr\'s metadata profile]][[radarr|sonarr|lidarr: .]] [[radarr: The only way to change a Radarr item\'s monitoring.]] [[grimmory: A Grimmory book is update_book.]] [[lidarr: On Lidarr, `id` is an artist; omit it with `monitored` or `monitor_new_items` to set every artist (`none` stops the wanted list growing by itself). The artist flag is not the album flag: albums keep their own, so stop wanting one with set_monitoring `level: "album"`. A new metadata profile applies at the artist\'s next refresh, which can remove albums.]] Takes `service` and `id`. Changing `root_folder` **moves the files on disk** unless `move_files: false`. `tags` replaces the whole set and an unknown tag is refused; get_instance_options lists profiles, folders and tags. Previews first; confirm to apply. Field reference: arr://docs/update_media.',
        inputSchema: UpdateMediaInput,
        target: { adapters, to: TARGET },
        operation: 'update_media',
        tier: ({ metadata_profile }) => (metadata_profile === undefined ? 'safe' : 'destructive'),

        async plan(
            {
            service,
            instance,
            id,
            quality_profile,
            root_folder,
            monitored,
            monitor_new_items,
            minimum_availability,
            series_type,
            tags,
            move_files,
            metadata_profile
            },
            adapter
        ): Promise<WritePlan> {
            const lidarr = adapter.type === 'lidarr';
            const sonarr = adapter.type === 'sonarr';

            if (monitor_new_items !== undefined && !lidarr && !sonarr) {
                throw new ServiceError('NotFound', service, 'monitor_new_items is a Lidarr and Sonarr option', {
                    remedy: 'Only an artist or a series has a rule for what it finds later. Drop it.'
                });
            }
            if (sonarr && monitor_new_items === 'new') {
                throw new ServiceError('NotFound', service, '`new` is a Lidarr rule', {
                    remedy: 'Sonarr takes `all` or `none` for the seasons it finds later.'
                });
            }

            // Lidarr's artist policy: every artist when `id` is omitted, or the
            // one named, written through the editor with the set the preview
            // signed. Anything that needs the one artist's own record stays on
            // the path below.
            if (lidarr && (id === undefined || monitor_new_items !== undefined)) {
                // Refused rather than dropped: this branch can reach every
                // artist, so an option it ignores must not turn into a bulk preview.
                if (series_type !== undefined) {
                    throw new ServiceError('NotFound', service, 'series_type is a Sonarr option', {
                        remedy: 'An artist has no numbering scheme. Drop it.'
                    });
                }
                if (minimum_availability !== undefined) {
                    throw new ServiceError('NotFound', service, 'minimum_availability is a Radarr option', {
                        remedy: 'Lidarr has no availability threshold. Use set_monitoring to choose which albums.'
                    });
                }
                const others = [
                    ['quality_profile', quality_profile],
                    ['root_folder', root_folder],
                    ['tags', tags],
                    ['metadata_profile', metadata_profile]
                ].filter(([, v]) => v !== undefined);
                if (others.length > 0) {
                    throw new Error(
                        `${others.map(([k]) => `\`${String(k)}\``).join(', ')} change${others.length === 1 ? 's' : ''} one artist at a time. ` +
                            (id === undefined
                                ? 'Name the artist with `id`, or drop it: with no `id`, only `monitored` and `monitor_new_items` are set, on every artist.'
                                : 'Set `monitor_new_items` in its own call: with it only `monitored` can be set alongside.')
                    );
                }
                if (!hasArtistMonitor(adapter)) {
                    throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot read or set an artist monitoring policy`);
                }
                return planArtistPolicy(adapters, adapter, { instance, artists: id === undefined ? undefined : [id], monitored, monitor_new_items });
            }

            if (id === undefined) {
                throw new Error(
                    '`id` is required: only Lidarr can omit it, to reach every artist. Take it from `acquisition.id` on a get_library or get_media_details record.'
                );
            }

            if (
                quality_profile === undefined &&
                root_folder === undefined &&
                monitored === undefined &&
                minimum_availability === undefined &&
                series_type === undefined &&
                tags === undefined &&
                metadata_profile === undefined &&
                monitor_new_items === undefined
            ) {
                throw new Error(
                    'Nothing to change. Name at least one of quality_profile, root_folder, monitored, tags, minimum_availability, series_type, monitor_new_items or metadata_profile.'
                );
            }

            // Refused rather than dropped, and named for the service that does
            // have the option; same rule as add_media.
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
            // Sonarr 3 has no such field, and its editor would drop it silently.
            if (monitor_new_items !== undefined && current.monitorNewItems === undefined) {
                throw new ServiceError('NotFound', service, `${service} reports no rule for new seasons`, {
                    remedy: 'Sonarr has it from 4.0. Drop `monitor_new_items`, or set the seasons with set_monitoring.'
                });
            }
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
            // A set: `["kids", "kids"]` is one tag, and must not pass for an
            // item's two.
            const resolvedTags =
                tags === undefined
                    ? undefined
                    : [
                          ...new Map(
                              tags
                                  .map(requested =>
                                      chooseOne(knownTags, requested, TAG_MATCH, t => `${t.display} (id ${t.id})`, 'tag', service)
                                  )
                                  .map(t => [t.id, t] as const)
                          ).values()
                      ];

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

            const newItemsChanged = monitor_new_items !== undefined && monitor_new_items !== current.monitorNewItems;
            if (newItemsChanged) {
                effects.push(
                    monitor_new_items === 'all'
                        ? `Seasons ${service} finds later for ${label} are monitored, so their episodes are grabbed while the series is monitored.`
                        : `Seasons ${service} finds later for ${label} start unmonitored. New episodes of a season that is already monitored are still monitored.`
                );
                changes.push('rule for new seasons');
            }

            const tagIds = resolvedTags?.map(t => t.id);
            const tagsChanged =
                tagIds !== undefined &&
                (tagIds.length !== new Set(current.tagIds).size || tagIds.some(t => !current.tagIds.includes(t)));
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
                    summary: `${label} is already set that way in ${adapter.id}.`,
                    effects: [],
                    noop: true
                };
            }

            return {
                target,
                summary: `Change the ${changes.join(', ')} of ${label} in ${adapter.id}.`,
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
                    ...(newItemsChanged ? { monitorNewItems: monitor_new_items } : {}),
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
            if (id === undefined) return [];
            const a = plan.args as { metadataProfileId?: number; rootFolderPath?: string; moveFiles?: boolean };
            if (a.metadataProfileId === undefined) return [];
            if (a.rootFolderPath !== undefined && a.moveFiles === false) return [];
            return [
                {
                    tool: 'trigger_scan',
                    arguments: { ...instanceArgs(resolveInstance(adapters, service, instance).id), id },
                    why: "Refreshes the artist now, and rescans every root folder unless Lidarr's 'Rescan Artist Folder after Refresh' is set to Never, so Lidarr applies the new metadata profile, with the album changes the preview described."
                }
            ];
        },

        async apply(plan, { id, monitored, monitor_new_items }, adapter) {
            if (hasArtistMonitor(adapter) && Array.isArray(plan.args?.artist_ids)) {
                return applyArtistPolicy(adapter, plan, { monitored, monitor_new_items });
            }
            if (id === undefined) throw new Error('This write needs `id`. Check the arguments before confirming it.');
            const a = plan.args as {
                qualityProfileId?: number;
                rootFolderPath?: string;
                moveFiles?: boolean;
                monitored?: boolean;
                minimumAvailability?: string;
                seriesType?: string;
                monitorNewItems?: ArtistMonitorNewItems;
                tagIds?: number[];
                metadataProfileId?: number;
            };

            // From the plan rather than re-resolved: re-running `chooseOne`
            // here could land on a profile added in between, and the token
            // guaranteed the one that was previewed.
            const state = await adapter.updateMedia(id, {
                ...(a.qualityProfileId === undefined ? {} : { qualityProfileId: a.qualityProfileId }),
                ...(a.rootFolderPath === undefined ? {} : { rootFolderPath: a.rootFolderPath }),
                ...(a.monitored === undefined ? {} : { monitored: a.monitored }),
                ...(a.minimumAvailability === undefined ? {} : { minimumAvailability: a.minimumAvailability }),
                ...(a.seriesType === undefined ? {} : { seriesType: a.seriesType }),
                ...(a.monitorNewItems === undefined ? {} : { monitorNewItems: a.monitorNewItems }),
                ...(a.tagIds === undefined ? {} : { tagIds: a.tagIds }),
                ...(a.metadataProfileId === undefined ? {} : { metadataProfileId: a.metadataProfileId }),
                moveFiles: a.moveFiles ?? false
            });

            return state;
        }
    });
}
