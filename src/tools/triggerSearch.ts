import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasMediaDetails, hasSearchTrigger, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The first write, and the shape every later one follows.
 *
 * It takes `service` plus `id` and **not** a title. Every read tool accepts a
 * fuzzy title because the cost of resolving one wrongly is a wrong answer the
 * user can see; for a write the cost is an action against the wrong item. The
 * model is expected to establish identity through `get_media_details` or
 * `get_library` first — which also means the id in the audit trail is one the
 * user could have seen before the write, not one this tool invented.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasSearchTrigger(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot be told to search`, {
            remedy: 'Only radarr and sonarr support trigger_search.'
        });
    }
    return adapter;
};

export function registerTriggerSearch(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'trigger_search',
        title: 'Search indexers for a release',
        description:
            'Asks Radarr or Sonarr to go looking for releases for one item it already tracks — the "it never downloaded, try again" action. Takes `service` and `id`, deliberately not a title: get those from get_media_details or get_library first. On Sonarr, give `season` to search one season or `episodes` for specific episode ids; giving both is refused rather than resolved, and neither on Radarr, which has no seasons. This queues a search and returns immediately; it does not wait for a release to be found, and finding one is not guaranteed. Previews by default — call again with the returned `confirm` token to actually run it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr or sonarr.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.string().min(1).describe("The item's id within that service, as an integer string."),
            season: z.number().int().min(0).optional().describe('Sonarr only. One season. 0 is specials. Omit for the whole series.'),
            episodes: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe('Sonarr only. Specific episode ids, as integer strings. Mutually exclusive with `season`.')
        }),
        // The permission check follows the argument, so enabling `safe_write`
        // on Radarr does not quietly enable it on Sonarr.
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write — or worse, the reverse.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'trigger_search',
        tier: 'safe',

        async plan({ service, instance, id, season, episodes }): Promise<WritePlan> {
            if (season !== undefined && episodes !== undefined) {
                throw new Error(
                    '`season` and `episodes` were both given. They are different targets — send one. Omit both to search the whole series.'
                );
            }
            if ((season !== undefined || episodes !== undefined) && service !== 'sonarr') {
                throw new ServiceError('NotFound', service, `${service} has no seasons`, {
                    remedy: 'Season and episode scope apply to sonarr only. Films have no seasons — omit season and episodes for radarr.'
                });
            }

            const adapter = findAdapter(adapters, service, instance);

            // A read before the write, for two reasons: it fails early and
            // legibly if the id does not exist ("Radarr has no movie 9999"
            // rather than a 404 from a command endpoint), and it puts a real
            // title in the preview — a confirmation prompt that says "search
            // for item 5" is one nobody can meaningfully approve.
            if (!hasMediaDetails(adapter)) {
                throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
            }
            const details = await adapter.getMediaDetails(id, {
                includeEpisodes: episodes !== undefined,
                episodeLimit: 500
            });
            const label = `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;

            // A season or episode id that does not resolve is not "search
            // nothing interesting" — Sonarr accepts a command matching nothing
            // and reports success, so an unvalidated write here is a search
            // that silently searches for nothing at all.
            if (season !== undefined && details.seasons !== undefined) {
                const known = details.seasons.map(s => s.season);
                if (!known.includes(season)) {
                    throw new ServiceError('NotFound', service, `${label} has no season ${season}`, {
                        remedy: `Seasons on this series: ${known.join(', ')}. Get them from get_media_details.`
                    });
                }
            }
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
            const scopeKind =
                episodes !== undefined ? 'episode' : season !== undefined ? 'season' : service === 'sonarr' ? 'whole-series' : 'movie';

            const effects = [
                `Queues a ${scopeKind} search on ${service} for ${scope}.`,
                'May grab and start downloading a release, which will appear in get_queue.'
            ];

            // Not a no-op — an unmonitored item can still be searched, and
            // upstream will happily run the command — but the model should say
            // so rather than let the user wonder why nothing arrives.
            if (details.monitored === false) {
                effects.push(
                    `${label} is not monitored on ${service}, so the search may find a release and still not grab it.`
                );
            }
            if (details.hasFile === true) {
                effects.push('This item already has a file; a search may replace it with an upgrade.');
            }

            return {
                target: `${service}:${id}`,
                summary: `Ask ${service} to search for releases for ${scope}.`,
                effects,
                args: {
                    service,
                    id,
                    ...(season === undefined ? {} : { season }),
                    ...(episodes === undefined ? {} : { episodes })
                }
            };
        },

        async apply(_plan, { service, instance, id, season, episodes }) {
            return findAdapter(adapters, service, instance).triggerSearch(id, {
                ...(season === undefined ? {} : { season }),
                ...(episodes === undefined ? {} : { episodes })
            });
        }
    });
}
