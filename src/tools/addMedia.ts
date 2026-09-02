import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasMediaAdd, type MediaAddCapable, type ServiceAdapter } from '../services/types.ts';
import { chooseOne, freeSpace, FOLDER_MATCH, PROFILE_MATCH, TAG_MATCH } from './chooseOne.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The last of the writes, and the only one that has to *choose*
 * something on the user's behalf.
 *
 * Adding needs a quality profile and a root folder, and neither has a
 * defensible default this code could invent. So the rule is: if there is
 * exactly one, use it silently — there was no choice to make. If there are
 * several and the caller named none, **refuse and list them**. Picking the
 * first of four quality profiles would be a guess presented as a decision, and
 * the user would discover it as a 4K film filling a disk they meant to keep
 * for 1080p.
 *
 * Safe tier: an added item can be removed again with `delete_media`. It still
 * says in the preview that it will start downloading, because "add" reads
 * cheaper than it is.
 */

const findAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & MediaAddCapable => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasMediaAdd(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot add media`, {
            remedy: 'Only radarr (films, by TMDB id) and sonarr (series, by TVDB id) can.'
        });
    }
    return adapter;
};

export function registerAddMedia(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'add_media',
        title: 'Add a film or series',
        description:
            'Adds a film to Radarr or a series to Sonarr and, by default, starts searching for it. Radarr takes a TMDB id, Sonarr takes a TVDB id — get the right one from lookup_media, which returns both under `ids`. If the service has more than one quality profile or root folder you must name which, because guessing wrong is only discovered once the download finishes — `stack_health` at `detail: "full"` lists the profiles, root folders and tags each instance actually has. Sonarr also takes `monitor` (which seasons: `future` is "only what has not aired yet") and `series_type`; Radarr takes `minimum_availability`. An option sent to the wrong service is refused, not dropped. Previews by default — call again with the returned `confirm` token to actually add it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr for a film, sonarr for a series.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            external_id: z
                .string()
                .min(1)
                .describe('TMDB id for radarr, TVDB id for sonarr, as an integer string. From lookup_media.'),
            quality_profile: z
                .string()
                .optional()
                .describe('Profile name or id. Optional only when the service has exactly one.'),
            root_folder: z
                .string()
                .optional()
                .describe('Root folder path, or any distinctive part of it. Optional only when the service has exactly one.'),
            monitored: z.boolean().default(true).describe('Monitor it for downloads. Defaults to true.'),
            monitor: z
                .enum(['all', 'future', 'missing', 'existing', 'firstSeason', 'lastSeason', 'pilot', 'none'])
                .optional()
                .describe(
                    'Sonarr only: which seasons to monitor. `future` is "only what has not aired yet", `all` is everything, `none` monitors the series but no season. Omit for Sonarr\'s own default. Radarr has no seasons — use `monitored` there.'
                ),
            minimum_availability: z
                .enum(['announced', 'inCinemas', 'released'])
                .optional()
                .describe(
                    'Radarr only: how early it may grab. Defaults to `released`, which is what stops a brand-new film grabbing a cinema recording the day it is announced.'
                ),
            series_type: z
                .enum(['standard', 'daily', 'anime'])
                .optional()
                .describe('Sonarr only: the numbering scheme. `anime` for absolute numbering, `daily` for date-based.'),
            tags: z
                .array(z.string().min(1))
                .optional()
                .describe(
                    'Tag labels or ids the service already has. An unknown label is refused, listing the ones that exist — nothing here ever creates a tag.'
                ),
            search_now: z
                .boolean()
                .default(true)
                .describe('Start searching immediately. Defaults to true — set false to add without downloading yet.')
        }),
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write — or worse, the reverse.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'add_media',
        tier: 'safe',

        async plan({
            service,
            instance,
            external_id,
            quality_profile,
            root_folder,
            monitored,
            search_now,
            monitor,
            minimum_availability,
            series_type,
            tags
        }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            // Refused before any call, and named for the service that *does*
            // have the option: silently dropping one would add the series with
            // every season monitored against an explicit "future only".
            if (monitor !== undefined && adapter.type !== 'sonarr') {
                throw new ServiceError('NotFound', service, 'monitor mode is a Sonarr option', {
                    remedy: 'Films have no seasons. Use `monitored` on Radarr, and `minimum_availability` for how early it may grab.'
                });
            }
            if (series_type !== undefined && adapter.type !== 'sonarr') {
                throw new ServiceError('NotFound', service, 'series_type is a Sonarr option', {
                    remedy: 'Films have no numbering scheme. Drop it.'
                });
            }
            if (minimum_availability !== undefined && adapter.type !== 'radarr') {
                throw new ServiceError('NotFound', service, 'minimum_availability is a Radarr option', {
                    remedy: 'Sonarr grabs each episode as it airs. Use `monitor` to choose which seasons.'
                });
            }

            // Together: they are independent, and a preview that takes three
            // sequential round trips on a LAN service is needlessly slow. The
            // tag list is only read when tags were asked for — an add that
            // wants none must not fail because the tag endpoint is down.
            const [candidate, profiles, folders, knownTags] = await Promise.all([
                adapter.lookupForAdd(external_id),
                adapter.listQualityProfiles(),
                adapter.listRootFolders(),
                tags === undefined ? Promise.resolve([]) : adapter.listTags()
            ]);

            const label = `${candidate.title}${candidate.year === undefined ? '' : ` (${candidate.year})`}`;

            // Already there is a no-op, not a failure — and adding again would
            // be a duplicate entry rather than a second copy of the film.
            if (candidate.existingId !== undefined) {
                return {
                    target: `${service}:${external_id}`,
                    summary: `${label} is already in ${service} (id ${candidate.existingId}).`,
                    effects: [],
                    noop: true
                };
            }

            const profile = chooseOne(
                profiles,
                quality_profile,
                PROFILE_MATCH,
                p => `${p.display} (id ${p.id})`,
                'quality profile',
                service
            );

            const folder = chooseOne(
                folders,
                root_folder,
                FOLDER_MATCH,
                f => `${f.display} (${freeSpace(f)})`,
                'root folder',
                service
            );

            // Resolved one at a time so the refusal names the label that
            // missed, not the whole list.
            const resolvedTags = (tags ?? []).map(requested =>
                chooseOne(knownTags, requested, TAG_MATCH, t => `${t.display} (id ${t.id})`, 'tag', service)
            );

            const effects = [
                `Adds ${label} to ${service} under ${folder.display} (${freeSpace(folder)}), quality profile ${profile.display} (id ${profile.id}).`,
                monitored
                    ? 'Monitors it, so it will be grabbed when a matching release appears.'
                    : 'Adds it unmonitored, so nothing will be grabbed until you monitor it.'
            ];

            if (monitor !== undefined) {
                effects.push(
                    monitor === 'none'
                        ? 'Monitors no season, so nothing is grabbed until a season or episode is monitored.'
                        : `Monitors the "${monitor}" set of seasons — Sonarr works out which those are.`
                );
            }
            if (minimum_availability !== undefined) {
                effects.push(`Will not grab anything until the film is ${minimum_availability}.`);
            }
            if (series_type !== undefined) effects.push(`Treats it as ${series_type} numbering.`);
            if (resolvedTags.length > 0) {
                effects.push(`Tags it ${resolvedTags.map(t => t.display).join(', ')}.`);
            }

            effects.push(
                search_now
                    ? 'Starts searching immediately — this may begin a download, using disk space and bandwidth.'
                    : 'Does not search yet. Use trigger_search when you want it to look.'
            );

            return {
                target: `${service}:${external_id}`,
                summary: `Add ${label} to ${service}.`,
                effects,
                // The resolved profile and folder, not the strings asked for:
                // the token must commit to what will actually happen, so a
                // preview showing "1080p into /movies" cannot be confirmed
                // into "4K into /media2".
                args: {
                    service,
                    externalId: external_id,
                    qualityProfileId: profile.id,
                    rootFolderPath: folder.path,
                    monitored,
                    searchNow: search_now,
                    ...(monitor === undefined ? {} : { monitor }),
                    ...(minimum_availability === undefined ? {} : { minimumAvailability: minimum_availability }),
                    ...(series_type === undefined ? {} : { seriesType: series_type }),
                    ...(resolvedTags.length === 0 ? {} : { tagIds: resolvedTags.map(t => t.id) })
                }
            };
        },

        async apply(plan, { service, instance }) {
            const a = plan.args as {
                externalId: string;
                qualityProfileId: number;
                rootFolderPath: string;
                monitored: boolean;
                searchNow: boolean;
                monitor?: string;
                minimumAvailability?: string;
                seriesType?: string;
                tagIds?: number[];
            };

            // Taken from the plan rather than re-resolved from the arguments:
            // re-running `chooseOne` here could land on a different profile if
            // one was added in between, and the token guaranteed the one that
            // was previewed.
            return findAdapter(adapters, service, instance).addMedia({
                externalId: a.externalId,
                qualityProfileId: a.qualityProfileId,
                rootFolderPath: a.rootFolderPath,
                monitored: a.monitored,
                searchNow: a.searchNow,
                ...(a.monitor === undefined ? {} : { monitor: a.monitor }),
                ...(a.minimumAvailability === undefined ? {} : { minimumAvailability: a.minimumAvailability }),
                ...(a.seriesType === undefined ? {} : { seriesType: a.seriesType }),
                ...(a.tagIds === undefined ? {} : { tagIds: a.tagIds })
            });
        }
    });
}
