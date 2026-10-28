import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import {
    hasArtistMonitor,
    hasMediaDetails,
    hasMonitorState,
    hasMonitoring,
    type ArtistMonitorPolicy,
    type ServiceAdapter
} from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasMonitoring(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no monitoring to set`, {
            remedy: 'Only sonarr and whisparr can be monitored per season or episode, and lidarr per album or artist. Films have no seasons.'
        });
    }
    return adapter;
};

/** How many artists sit at each new-album policy and each monitor flag, so a
 *  preview says what the library holds rather than only what it is about to
 *  become. The monitor-flag half is the "is this stable" read; the policy half
 *  is the "can it stop being stable again" read, and they are different
 *  questions with different answers. */
const tally = (policies: readonly ArtistMonitorPolicy[]): string => {
    const items = new Map<string, number>();
    const flags = new Map<string, number>();
    for (const p of policies) {
        items.set(p.monitorNewItems, (items.get(p.monitorNewItems) ?? 0) + 1);
        const flag = p.monitored ? 'monitored' : 'unmonitored';
        flags.set(flag, (flags.get(flag) ?? 0) + 1);
    }
    const group = (counts: Map<string, number>) =>
        [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => `${count} ${value}`).join(', ');

    return `new-album policy ${group(items)}; albums ${group(flags)}`;
};

export function registerSetMonitoring(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'set_monitoring',
        title: 'Start or stop monitoring',
        description:
            'Turns monitoring on or off. Sonarr and Whisparr: a whole series, one season, or specific episodes. Lidarr takes `level` — `album` monitors or unmonitors one whole album, and `artist` sets the artist-level policy: `monitor_new_items` is the rule Lidarr applies to albums it discovers later, and `none` is the only value that stops the wanted list growing by itself. Omit `artists` on the artist level to reach every artist in Lidarr. **The artist flag is not the album flag.** An artist can read `monitored: false` while an album under it stays `monitored: true`, so setting the artist flag does not empty a wanted list — write the album flag with `level: "album"` for that. Safe tier — nothing is deleted and the service can undo it, so `safe_write` is enough. `season` and `episodes` are mutually exclusive and refused on any Lidarr level, because an album is monitored whole. Unmonitoring **before** deleting files is what stops Sonarr immediately re-downloading them — see delete_episode_files. Takes ids, never a title: take them from `acquisition.id` on a get_library or get_media_details record, or an album row\'s `artistId` for the artist level. Previews by default and the preview reports the state it found — new-album policy and monitor flag across the artists it would touch — so the current policy is read before it is changed rather than assumed; call again with the returned `confirm` token to apply. A season this series does not have, an episode id that cannot be resolved, or an artist id Lidarr does not have is refused rather than written: those endpoints accept a write matching nothing and report success, and you would go on believing the item was unmonitored. The refusal names the seasons that do exist, so retry with one of those rather than assuming the series is unreachable.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('sonarr, whisparr or lidarr.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z
                .string()
                .min(1)
                .optional()
                .describe(
                    'The series id within that service, or the album id when service is lidarr, as an integer string. Required everywhere except the lidarr artist level, where it is refused.'
                ),
            monitored: z
                .boolean()
                .optional()
                .describe(
                    'true to monitor, false to stop. Required except on the lidarr artist level, where it is the bulk switch over each artist\'s existing albums and may be given alone or with `monitor_new_items`.'
                ),
            level: z
                .enum(['album', 'artist'])
                .optional()
                .describe(
                    'lidarr only, and required there: whether `id` names an album or an artist. Refused on every other service.'
                ),
            artists: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe(
                    'lidarr artist level only: artist ids, as integer strings. Omit to apply to every artist in Lidarr.'
                ),
            monitor_new_items: z
                .enum(['all', 'none', 'new'])
                .optional()
                .describe(
                    'lidarr artist level only: the standing rule for albums Lidarr discovers later. `none` is what a finished, stable library wants.'
                ),
            season: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    'One season. 0 is specials. Omit for the whole series. On Whisparr a season is a release year, e.g. 2019.'
                ),
            episodes: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe('Specific episode ids, as integer strings. Mutually exclusive with `season`.')
        }),
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'set_monitoring',
        tier: 'safe',

        async plan({ service, instance, id, monitored, season, episodes, level, artists, monitor_new_items }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            // ---- Lidarr's artist level: a policy over a set, not a flag on one item.
            if (level === 'artist') {
                if (service !== 'lidarr') {
                    throw new ServiceError('NotFound', service, '`level` is a lidarr parameter; only Lidarr has an artist policy', {
                        remedy: 'Drop `level`. A series is monitored whole, per season, or per episode.'
                    });
                }
                if (id !== undefined || season !== undefined || episodes !== undefined) {
                    throw new ServiceError('NotFound', service, 'The artist level takes `artists`, not `id`, `season` or `episodes`', {
                        remedy: 'An artist is not one item: name artists, or omit `artists` for all of them.'
                    });
                }
                if (monitored === undefined && monitor_new_items === undefined) {
                    throw new Error('Give `monitored`, `monitor_new_items`, or both. With neither there is nothing to change.');
                }

                if (!hasArtistMonitor(adapter)) {
                    throw new ServiceError('NotFound', service, `${service} cannot read or set an artist monitoring policy`);
                }

                const all = await adapter.listArtistMonitorPolicies();
                let targets: ArtistMonitorPolicy[];
                if (artists === undefined) {
                    targets = all;
                } else {
                    const byId = new Map(all.map(p => [p.artistId, p]));
                    // Refused rather than dropped: the editor answers a list of ids
                    // it cannot find with a 200, and a caller that mistyped one id
                    // would go on believing that artist had been settled.
                    const missing = artists.filter(aid => !byId.has(aid));
                    if (missing.length > 0) {
                        throw new ServiceError('NotFound', service, `Lidarr has no artist with id ${missing.join(', ')}`, {
                            remedy: `Lidarr holds ${all.length} artists. Take ids from an album row's artistId.`
                        });
                    }
                    targets = artists.map(aid => byId.get(aid)!);
                }

                if (targets.length === 0) {
                    throw new ServiceError('NotFound', service, 'Lidarr reported no artists at all, so there is no policy to set', {
                        remedy: 'Nothing was written. Check that this Lidarr actually holds artists.'
                    });
                }

                const already = targets.filter(
                    p =>
                        (monitored === undefined || p.monitored === monitored) &&
                        (monitor_new_items === undefined || p.monitorNewItems === monitor_new_items)
                );

                const scope = artists === undefined ? `all ${targets.length} artists` : `${targets.length} artist(s)`;
                const effects: string[] = [];
                if (monitor_new_items !== undefined) {
                    effects.push(
                        monitor_new_items === 'none'
                            ? `Lidarr will not monitor any album it discovers for ${scope} from now on; the wanted list can no longer grow by itself.`
                            : `Lidarr will keep monitoring new albums it discovers for ${scope}.`
                    );
                }
                if (monitored !== undefined) {
                    // The artist flag is not the album flag, and this was checked
                    // rather than assumed: a live library was found with an artist
                    // reading `monitored: false` while one album under it stayed
                    // `monitored: true`. Claiming this empties a wanted list would
                    // send a caller away believing nothing is being searched for,
                    // so the album level is named as the way to do that.
                    effects.push(
                        monitored
                            ? `Lidarr sets the artist-level monitor flag on ${scope}. This is not the album flag: an artist can read unmonitored while its albums stay monitored, so empty a wanted list with level "album".`
                            : `Lidarr clears the artist-level monitor flag on ${scope}. Albums already monitored under these artists stay monitored — use level "album" to stop searching for one. Files on disk are untouched either way.`
                    );
                }
                effects.push(`State found before the change: ${tally(targets)}.`);

                const summary = [
                    monitor_new_items === undefined ? undefined : `Set new-album monitoring to "${monitor_new_items}"`,
                    monitored === undefined
                        ? undefined
                        : `${monitored ? 'Monitor' : 'Unmonitor'} at the artist level`
                ]
                    .filter(Boolean)
                    .join(' and ');

                return {
                    target: `${adapter.id}:artists:${artists === undefined ? 'all' : [...artists].sort().join(',')}`,
                    summary: `${summary} for ${scope} in ${service}.`,
                    effects,
                    args: {
                        service,
                        ...(instance === undefined ? {} : { instance }),
                        level,
                        ...(artists === undefined ? {} : { artists }),
                        ...(monitored === undefined ? {} : { monitored }),
                        ...(monitor_new_items === undefined ? {} : { monitor_new_items })
                    },
                    ...(already.length === targets.length ? { noop: true } : {})
                };
            }

            // The artist-only parameters have no meaning on any other level, and
            // Lidarr would ignore them while doing something else entirely.
            if (artists !== undefined || monitor_new_items !== undefined) {
                throw new ServiceError('NotFound', service, '`artists` and `monitor_new_items` need `level: "artist"`', {
                    remedy: 'Give `level: "artist"`, or drop them: an album has no new-item policy of its own.'
                });
            }
            if (service === 'lidarr' && level !== 'album') {
                throw new ServiceError('NotFound', service, 'lidarr needs `level`: "album" or "artist"', {
                    remedy:
                        'An album id and an artist id are two different namespaces and Lidarr cannot tell them apart. Say which one `id` is.'
                });
            }
            if (level !== undefined && service !== 'lidarr') {
                throw new ServiceError('NotFound', service, '`level` is a lidarr parameter', {
                    remedy: 'Drop it. A series is monitored whole, per season, or per episode.'
                });
            }
            if (id === undefined) {
                throw new ServiceError('NotFound', service, '`id` is required', {
                    remedy: 'Take it from `acquisition.id` on a get_library or get_media_details record.'
                });
            }
            if (monitored === undefined) {
                throw new ServiceError('NotFound', service, '`monitored` is required', {
                    remedy: 'Say which way: true to monitor, false to stop.'
                });
            }
            if (season !== undefined && episodes !== undefined) {
                throw new Error(
                    '`season` and `episodes` were both given. They are different targets — send one. Omit both to monitor the whole series.'
                );
            }

            const verb = monitored ? 'Monitor' : 'Unmonitor';
            const who = service.charAt(0).toUpperCase() + service.slice(1);

            let label: string;
            let scope: string;
            let current: boolean | undefined;

            // Two services hold "what is monitored right now" in two places, so
            // the preview read differs. Sonarr and Whisparr answer through the
            // full item description; a Lidarr album cannot go that way —
            // `get_media_details` walks the film and series chain and refuses an
            // album on purpose — so it answers through the narrower monitor read.
            if (hasMediaDetails(adapter)) {
                // The read that makes the preview approvable and fails legibly on a
                // bad id, rather than issuing a PUT into the dark. The episode form
                // asks for the episode list and then *uses* it, below: paying for
                // up to 500 episodes and validating nothing against them was how an
                // id that does not exist reached Sonarr as a write.
                const details = await adapter.getMediaDetails(id, {
                    includeEpisodes: episodes !== undefined,
                    episodeLimit: 500
                });
                label = `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;

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

                scope =
                    episodes !== undefined
                        ? `${episodes.length} episode(s) of ${label}`
                        : season !== undefined
                          ? `season ${season} of ${label}`
                          : label;

                // `noop` only for the whole-series form, where the current state is
                // a single value Sonarr actually holds.
                //
                // The episode form targets a set that can disagree with itself —
                // some monitored, some not — so no claim is made there. The season
                // form *looks* like it has an answer in `seasons[].monitored`, but
                // that is a UI aggregate over the episode flags, and this tool's
                // own episode form writes those flags without touching it. A
                // season therefore reads `monitored: false` while its episodes are
                // monitored, and believing it answered "no change was made" to a
                // request that would have changed something: no PUT, a `dry_run`
                // audit row, and Sonarr still searching for exactly the episodes
                // the caller went on to delete.
                //
                // Deriving the truth from the episode list was the alternative and
                // is worse: it makes every season write depend on a second call for
                // up to 500 episodes, so an episode endpoint that is down turns a
                // working write into a failed one. One redundant confirmation is
                // the cheaper mistake.
                current = season === undefined && episodes === undefined ? details.monitored : undefined;
            } else if (hasMonitorState(adapter)) {
                // An album is monitored whole. A season or an episode list means
                // the caller is holding the wrong model of the service, and
                // Lidarr would accept the call and monitor the entire album
                // regardless — a success report for something else entirely.
                if (season !== undefined || episodes !== undefined) {
                    throw new ServiceError('NotFound', service, `A ${service} album has no seasons and no episode ids.`, {
                        remedy: 'Send only `monitored`. Track-level monitoring is not a Lidarr concept.'
                    });
                }

                const state = await adapter.getMonitorState(id);
                label = state.label;
                scope = label;
                // The album flag is one value Lidarr actually holds, so `noop`
                // is honest here the way it is for a whole series.
                current = state.monitored;
            } else {
                throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
            }

            const effects = [
                monitored
                    ? `${who} will search for missing ${service === 'lidarr' ? 'tracks' : 'episodes'} in ${scope}.`
                    : `${who} will stop searching for ${scope}. Files already on disk are untouched.`
            ];

            return {
                target: `${adapter.id}:${id}`,
                summary: `${verb} ${scope} in ${service}.`,
                effects,
                args: {
                    service,
                    id,
                    monitored,
                    ...(level === undefined ? {} : { level }),
                    ...(season === undefined ? {} : { season }),
                    ...(episodes === undefined ? {} : { episodes })
                },
                ...(current === monitored ? { noop: true } : {})
            };
        },

        async apply(_plan, { service, instance, id, monitored, season, episodes, level, artists, monitor_new_items }) {
            const adapter = findAdapter(adapters, service, instance);

            if (level === 'artist' && hasArtistMonitor(adapter)) {
                const all = await adapter.listArtistMonitorPolicies();
                const ids = artists === undefined ? all.map(p => p.artistId) : artists;
                await adapter.setArtistMonitorPolicy(ids, {
                    ...(monitored === undefined ? {} : { monitored }),
                    ...(monitor_new_items === undefined ? {} : { monitorNewItems: monitor_new_items })
                });
                return {
                    artists: ids.length,
                    ...(monitored === undefined ? {} : { monitored }),
                    ...(monitor_new_items === undefined ? {} : { monitorNewItems: monitor_new_items })
                };
            }

            if (id === undefined || monitored === undefined) {
                throw new ServiceError('NotFound', service, '`id` and `monitored` are required for this write');
            }

            await adapter.setMonitoring(id, {
                monitored,
                ...(season === undefined ? {} : { season }),
                ...(episodes === undefined ? {} : { episodeIds: episodes })
            });
            return { monitored, target: `${adapter.id}:${id}` };
        }
    });
}
