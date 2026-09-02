import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import {
    hasMediaAdd,
    hasMediaUpdate,
    type MediaAddCapable,
    type MediaUpdateCapable,
    type ServiceAdapter
} from '../services/types.ts';
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

export function registerUpdateMedia(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'update_media',
        title: 'Change what a library item is set to',
        description:
            'Changes settings on something already in Radarr or Sonarr: quality profile, root folder, monitoring, tags, Radarr’s minimum availability, Sonarr’s series type. The counterpart to add_media, which only ever adds — and the only way to change a **Radarr** item’s monitoring, since set_monitoring is Sonarr’s per-season tool. Takes `service` and `id`, never a title: take `id` from `acquisition.id` on a get_library or get_media_details record. Changing `root_folder` asks the service to **move the files on disk**; pass `move_files: false` to leave them where they are, which reports them missing until the next scan. `tags` replaces the whole tag set rather than adding to it, and an unknown label is refused — nothing here creates a tag. `stack_health` at `detail: "full"` lists the profiles, root folders and tags each instance actually has. Previews by default — call again with the returned `confirm` token to apply.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr for a film, sonarr for a series.'),
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
                .describe('Tag labels or ids that already exist. Replaces the whole set — pass [] to clear it.'),
            move_files: z
                .boolean()
                .default(true)
                .describe(
                    'With root_folder: whether the service moves the files to the new folder. Defaults to true. False only when you have already moved them yourself.'
                )
        }),
        // The resolved instance id, not the bare type — permissions are
        // granted per instance.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
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
            move_files
        }): Promise<WritePlan> {
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

            const target = `${service}:${id}`;

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
