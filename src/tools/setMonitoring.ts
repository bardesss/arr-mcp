import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasMediaDetails, hasMonitoring, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasMonitoring(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no monitoring to set`, {
            remedy: 'Only sonarr can be monitored per season or episode. Films have no seasons.'
        });
    }
    return adapter;
};

export function registerSetMonitoring(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'set_monitoring',
        description:
            'Turns Sonarr monitoring on or off for a whole series, one season, or specific episodes. Safe tier — nothing is deleted and Sonarr can undo it, so `safe_write` is enough. Give `season` for one season, `episodes` for specific episode ids, or neither for the whole series; giving both is refused rather than resolved. Unmonitoring **before** deleting files is what stops Sonarr immediately re-downloading them — see delete_episode_files. Takes `service` and `id`, never a title: get those from get_media_details or get_library. Previews by default — call again with the returned `confirm` token to apply. A season this series does not have, or an episode id that cannot be resolved, is refused rather than written: Sonarr would accept a write matching nothing and report success, and you would go on to delete files believing they were unmonitored. The refusal names the seasons that do exist, so retry with one of those rather than assuming the series is unreachable.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('sonarr.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.string().min(1).describe("The series id within that service, as an integer string."),
            monitored: z.boolean().describe('true to monitor, false to stop.'),
            season: z.number().int().min(0).optional().describe('One season. 0 is specials. Omit for the whole series.'),
            episodes: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe('Specific episode ids, as integer strings. Mutually exclusive with `season`.')
        }),
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'set_monitoring',
        tier: 'safe',

        async plan({ service, instance, id, monitored, season, episodes }): Promise<WritePlan> {
            if (season !== undefined && episodes !== undefined) {
                throw new Error(
                    '`season` and `episodes` were both given. They are different targets — send one. Omit both to monitor the whole series.'
                );
            }

            const adapter = findAdapter(adapters, service, instance);
            if (!hasMediaDetails(adapter)) {
                throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
            }

            // The read that makes the preview approvable and fails legibly on a
            // bad id, rather than issuing a PUT into the dark. The episode form
            // asks for the episode list and then *uses* it, below: paying for
            // up to 500 episodes and validating nothing against them was how an
            // id that does not exist reached Sonarr as a write.
            const details = await adapter.getMediaDetails(id, {
                includeEpisodes: episodes !== undefined,
                episodeLimit: 500
            });
            const label = `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;
            const verb = monitored ? 'Monitor' : 'Unmonitor';

            // A season this series does not have is not a no-op: `sonarr.ts`
            // maps every season, matches none, and PUTs the series back
            // unchanged — so the tool would report `applied: true` for a write
            // that provably did nothing, and the caller, believing the season
            // is now unmonitored, would go on to delete its files. Refused
            // instead, exactly as delete_episode_files refuses an episode id it
            // cannot resolve. Only when Sonarr actually reported seasons: no
            // list is no evidence, and refusing on that would be a guess.
            if (season !== undefined && details.seasons !== undefined) {
                const known = details.seasons.map(s => s.season);
                if (!known.includes(season)) {
                    throw new ServiceError('NotFound', service, `${label} has no season ${season}`, {
                        remedy: `Seasons on this series: ${known.join(', ')}. Get them from get_media_details.`
                    });
                }
            }

            // The same refusal one level down, and for the same reason its
            // sibling gives: an id `getMediaDetails` never returned — wrong, or
            // past the 500-episode cap — is not "nothing to change"; it is "I
            // could not see that episode at all", and the episode endpoint
            // accepts ids it cannot find without complaint.
            if (episodes !== undefined) {
                const found = new Set((details.episodes ?? []).map(e => String(e.id)));
                const unresolved = episodes.filter(eid => !found.has(eid));
                if (unresolved.length > 0) {
                    throw new ServiceError(
                        'NotFound',
                        service,
                        `Could not find episode(s) ${unresolved.join(', ')} on ${label}` +
                            (details.episodesTruncated === true
                                ? ' — the episode list was truncated at 500, so they may simply not have been fetched.'
                                : '.'),
                        { remedy: 'Check the episode ids from get_media_details.' }
                    );
                }
            }

            const scope =
                episodes !== undefined
                    ? `${episodes.length} episode(s) of ${label}`
                    : season !== undefined
                      ? `season ${season} of ${label}`
                      : label;

            // `noop` only where the current state is a single value. The
            // episode form targets a set that can disagree with itself — some
            // monitored, some not — so no claim is made there; one redundant
            // confirmation beats "already monitored" asserted across a mixture.
            const current =
                season !== undefined
                    ? details.seasons?.find(s => s.season === season)?.monitored
                    : episodes === undefined
                      ? details.monitored
                      : undefined;

            const effects = [
                monitored
                    ? `Sonarr will search for missing episodes in ${scope}.`
                    : `Sonarr will stop searching for ${scope}. Files already on disk are untouched.`
            ];

            return {
                target: `${service}:${id}`,
                summary: `${verb} ${scope} in ${service}.`,
                effects,
                args: {
                    service,
                    id,
                    monitored,
                    ...(season === undefined ? {} : { season }),
                    ...(episodes === undefined ? {} : { episodes })
                },
                ...(current === monitored ? { noop: true } : {})
            };
        },

        async apply(_plan, { service, instance, id, monitored, season, episodes }) {
            await findAdapter(adapters, service, instance).setMonitoring(id, {
                monitored,
                ...(season === undefined ? {} : { season }),
                ...(episodes === undefined ? {} : { episodeIds: episodes })
            });
            return { monitored, target: `${service}:${id}` };
        }
    });
}
