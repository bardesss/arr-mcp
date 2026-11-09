import { instancesOfType } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import {
    hasArtistMonitor,
    hasMediaDetails,
    hasMonitorState,
    hasMonitoring,
    type ArtistMonitorPolicy,
    type ServiceAdapter
} from '../services/types.ts';
import { managedIdByTitle } from './byTitle.ts';
import type { LibraryLoader } from './library.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';
import { checkScope, EPISODE_LIMIT, refuseBoth } from './itemScope.ts';

const TARGET = serviceTarget({
    services: ['sonarr', 'whisparr', 'lidarr'],
    can: hasMonitoring,
    cannot: 'has no monitoring to set',
    hint: 'Sonarr and Whisparr monitor per season or episode, and Lidarr per album or artist. Films have no seasons.'
});

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

    // `artists`, not `albums`: the counts come from each artist's own monitor
    // flag, and printing them as albums is the exact mix-up the tool description
    // warns about. "new-album policy" stays, because `monitorNewItems` is an
    // album policy that an artist holds.
    return `new-album policy ${group(items)}; artists ${group(flags)}`;
};

/**
 * The artist ids the preview named, read back off the plan it signed.
 *
 * `apply` writes this list and does not read the library again: a second read
 * resolves "all artists" against a set that may have grown since the preview,
 * which is exactly the write this exists to prevent. The value is always there
 * — `plan` puts it in `args`, and the token is checked against those same args —
 * so a plan without it is a bug here rather than a caller mistake.
 */
const previewedArtistIds = (plan: WritePlan): string[] => {
    const ids = plan.args?.artist_ids;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
        throw new Error('The artist-level plan carried no artist list, so nothing was written.');
    }
    return ids;
};

export function registerSetMonitoring(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    /** Resolves `title`. Absent in tests that only ever pass an id. */
    loader?: LibraryLoader
): void {
    // A series title in place of `id`, resolved on preview and on confirm
    // alike. The token binds the resolved target, so the two cannot disagree.
    const idOf = async (adapterId: string, id: string | undefined, title: string | undefined, service: string): Promise<string | undefined> => {
        if (title === undefined) return id;
        if (id !== undefined) throw new Error('Pass either `id` or `title`, not both.');
        if (service === 'lidarr') throw new Error('`title` names a series; on lidarr pass the album `id`, or `level: "artist"` with `artists`.');
        if (loader === undefined) throw new Error('`title` cannot be resolved here; pass `id`.');
        return managedIdByTitle(adapters, loader, title, adapterId);
    };

    registerWriteTool(server, context, {
        name: 'set_monitoring',
        title: 'Start or stop monitoring',
        description:
            'Turns monitoring on or off. Sonarr and Whisparr: a series (by `id` or `title`), one `season`, or `episodes` (not both). [[lidarr: Lidarr takes `level`: `album` sets one album\'s flag; `artist` sets the artist flag and `monitor_new_items` (`none` is the only value that stops the wanted list growing by itself), and omitting `artists` reaches every artist. **The artist flag is not the album flag**: an unmonitored artist\'s albums drop out of get_wanted but keep their own flags and come back with the artist, so stop wanting one album with `level: "album"` (ids from get_media_details on the artist, or a get_wanted `albumId`).]] Radarr monitoring is update_media. Unmonitor **before** delete_episode_files, or Sonarr downloads the files again. Safe tier. The preview shows the current state; a season, episode or artist that does not exist is refused rather than silently written. Previews first; confirm to apply. Field reference: arr://docs/set_monitoring.',
        inputSchema: z.object({
            ...targetInput(TARGET),
            title: z
                .string()
                .min(1)
                .optional()
                .describe('Sonarr or Whisparr: a series title in place of `id`. A title two series match equally is refused with both ids.'),
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
                    'true to monitor, false to stop. Required except on the lidarr artist level, where it sets each artist\'s own flag, which decides whether Lidarr wants any of its albums, and may be given alone or with `monitor_new_items`.'
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
                    'lidarr artist level only: artist ids, as integer strings. Omit to apply to every artist in that Lidarr.'
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
        target: { adapters, to: TARGET },
        operation: 'set_monitoring',
        tier: 'safe',

        async plan({ service, instance, id: given, title, monitored, season, episodes, level, artists, monitor_new_items }, adapter): Promise<WritePlan> {
            const id = await idOf(adapter.id, given, title, service);

            // ---- Lidarr's artist level: a policy over a set, not a flag on one item.
            //
            // Every refusal below is about the arguments, not about the service.
            // A ServiceError here would read as "sonarr has no such item" and send
            // the caller looking for a missing series when the gap was a missing
            // parameter.
            if (level === 'artist') {
                if (service !== 'lidarr') {
                    throw new Error(
                        '`level` is a lidarr parameter, and only Lidarr has an artist policy. ' +
                            'Drop it: a series is monitored whole, per season, or per episode.'
                    );
                }
                if (id !== undefined || season !== undefined || episodes !== undefined) {
                    throw new Error(
                        'The artist level takes `artists`, not `id`, `season` or `episodes`. ' +
                            'An artist is not one item: name artists, or omit `artists` for all of them.'
                    );
                }
                if (monitored === undefined && monitor_new_items === undefined) {
                    throw new Error('Give `monitored`, `monitor_new_items`, or both. With neither there is nothing to change.');
                }

                if (!hasArtistMonitor(adapter)) {
                    throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot read or set an artist monitoring policy`);
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
                        // Ids are per instance, and a get_library row for an
                        // artist two Lidarrs hold carries one instance's id.
                        const row =
                            instancesOfType(adapters, 'lidarr').length < 2
                                ? 'a get_library artist row'
                                : `a get_library artist row whose acquisition.service is ${adapter.id}. Ids are per instance, and a row for an artist two Lidarrs hold may carry another instance's id, so take this one's from ${adapter.id} itself, or omit \`artists\` to apply to every artist there`;
                        throw new ServiceError('NotFound', adapter.id, `Lidarr has no artist with id ${missing.join(', ')}`, {
                            remedy: `Lidarr holds ${all.length} artists. Take an id from acquisition.id on ${row}.`
                        });
                    }
                    targets = artists.map(aid => byId.get(aid)!);
                }

                if (targets.length === 0) {
                    throw new ServiceError('NotFound', adapter.id, 'Lidarr reported no artists at all, so there is no policy to set', {
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
                    // `monitored: true`. Lidarr's wanted lists, calendar, RSS sync
                    // and missing and cutoff searches skip such an album
                    // (`MissingController`, `CutoffController`, `AlbumsBetweenDates`,
                    // `MonitoredAlbumSpecification` and `AlbumSearchService` check
                    // the artist too; a search for one album by hand does not), but
                    // its own flag is unchanged and comes back with the artist, so
                    // the album level is named as the way to stop wanting one for
                    // good.
                    effects.push(
                        monitored
                            ? `Lidarr sets the artist-level monitor flag on ${scope}. This is not the album flag: each album keeps its own, and the monitored ones come back into Lidarr's wanted lists, calendar and automatic searches.`
                            : `Lidarr clears the artist-level monitor flag on ${scope}. Their albums keep their own flags, but Lidarr leaves all of them out of its wanted lists, calendar and automatic searches until the artist is monitored again — use level "album" to stop wanting one album for good. Files on disk are untouched either way.`
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
                    summary: `${summary} for ${scope} in ${adapter.id}.`,
                    effects,
                    args: {
                        service,
                        ...(instance === undefined ? {} : { instance }),
                        level,
                        // The resolved set, never the word "all". The token is
                        // signed over `args`, so an artist added between the
                        // preview and the confirmation changes this list and the
                        // token stops matching. That refuses a write into an
                        // artist nobody was shown, instead of the apply re-reading
                        // "all" and reaching it. It is also the record of which
                        // artists the write named, which is the part an audit row
                        // cannot reconstruct later.
                        artist_ids: targets.map(p => p.artistId).sort(),
                        ...(monitored === undefined ? {} : { monitored }),
                        ...(monitor_new_items === undefined ? {} : { monitor_new_items })
                    },
                    ...(already.length === targets.length ? { noop: true } : {})
                };
            }

            // The artist-only parameters have no meaning on any other level, and
            // Lidarr would ignore them while doing something else entirely.
            if (artists !== undefined || monitor_new_items !== undefined) {
                throw new Error(
                    '`artists` and `monitor_new_items` need `level: "artist"`. ' +
                        'Give `level: "artist"`, or drop them: an album has no new-item policy of its own.'
                );
            }
            if (service === 'lidarr' && level !== 'album') {
                throw new Error(
                    'lidarr needs `level`: "album" or "artist". ' +
                        'An album id and an artist id are two different namespaces and Lidarr cannot tell them apart. ' +
                        'Say which one `id` is.'
                );
            }
            if (level !== undefined && service !== 'lidarr') {
                throw new Error('`level` is a lidarr parameter. Drop it. A series is monitored whole, per season, or per episode.');
            }
            if (id === undefined) {
                throw new Error('`id` is required. Take it from `acquisition.id` on a get_library or get_media_details record.');
            }
            if (monitored === undefined) {
                throw new Error('`monitored` is required. Say which way: true to monitor, false to stop.');
            }
            refuseBoth(season, episodes, 'Omit both to monitor the whole series.');

            const verb = monitored ? 'Monitor' : 'Unmonitor';
            const who = service.charAt(0).toUpperCase() + service.slice(1);

            let label: string;
            let scope: string;
            let current: boolean | undefined;

            // Two services hold "what is monitored right now" in two places, so
            // the preview read differs. Sonarr and Whisparr answer through the
            // full item description; a Lidarr album cannot go that way, because
            // Lidarr's details read takes an *artist* id, so it answers through
            // the narrower monitor read. That branch is checked first for it.
            if (hasMonitorState(adapter)) {
                // Lidarr's album level, checked before `hasMediaDetails`: an
                // album id is not an artist id, so the details read would fetch
                // the wrong resource and 404 on a valid album.
                // The rule and its message belong to the adapter, which applies
                // the same one to a direct `setMonitoring` call.
                adapter.refusePartialSelection({ season, episodeIds: episodes });

                const state = await adapter.getMonitorState(id);
                label = state.label;
                scope = label;
                // The album flag is one value Lidarr actually holds, so `noop`
                // is honest here the way it is for a whole series.
                current = state.monitored;
            } else if (hasMediaDetails(adapter)) {
                // The read that makes the preview approvable and fails legibly on a
                // bad id, rather than issuing a PUT into the dark. The episode form
                // asks for the episode list and then *uses* it, below: paying for
                // up to 500 episodes and validating nothing against them was how an
                // id that does not exist reached Sonarr as a write.
                const details = await adapter.getMediaDetails(id, {
                    includeEpisodes: episodes !== undefined,
                    episodeLimit: EPISODE_LIMIT
                });
                label = titled(details.title, details.year);

                // A season this series does not have is not a no-op: `sonarr.ts`
                // maps every season, matches none, and PUTs the series back
                // unchanged — so the tool would report `applied: true` for a write
                // that provably did nothing, and the caller, believing the season
                // is now unmonitored, would go on to delete its files. Refused
                // instead, exactly as delete_episode_files refuses an episode id it
                // cannot resolve. Only when Sonarr actually reported seasons: no
                // list is no evidence, and refusing on that would be a guess.
                checkScope(details, label, service, { season, episodes });

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

        async apply(plan, { service, id: given, title, monitored, season, episodes, level, monitor_new_items }, adapter) {
            const id = await idOf(adapter.id, given, title, service);

            if (level === 'artist' && hasArtistMonitor(adapter)) {
                const ids = previewedArtistIds(plan);
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
                throw new Error('This write needs `id` and `monitored`. Check the arguments before confirming it.');
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
