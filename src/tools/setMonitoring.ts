import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { ARR_NAMES } from '../core/resolver.ts';
import {
    hasMediaDetails,
    hasMonitorState,
    hasMonitoring,
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
    hint: 'Sonarr and Whisparr monitor per season or episode, and Lidarr per album. Films have no seasons.'
});

const SetMonitoringInput = z.object({
    ...targetInput(TARGET),
    title: z
        .string()
        .min(1)
        .optional()
        .describe('[[sonarr|whisparr: A series title in place of `id`. A title two series match equally is refused with both ids.]]'),
    id: z
        .string()
        .min(1)
        .optional()
        .describe(
            'The series id within that service, or the album id when service is lidarr, as an integer string.'
        ),
    monitored: z.boolean().describe('true to monitor, false to stop.'),
    level: z
        .enum(['album'])
        .optional()
        .describe('[[lidarr: lidarr only, and required there: `album`, since `id` names an album. Refused on every other service.]]'),
    season: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            '[[sonarr|whisparr: One season. 0 is specials. Omit for the whole series.]] [[whisparr: On Whisparr a season is a release year, e.g. 2019.]]'
        ),
    episodes: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Specific episode ids, as integer strings. Mutually exclusive with `season`.')
});

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
        if (service === 'lidarr') throw new Error('`title` names a series; on lidarr pass the album `id`.');
        if (loader === undefined) throw new Error('`title` cannot be resolved here; pass `id`.');
        return managedIdByTitle(adapters, loader, title, adapterId);
    };

    registerWriteTool(server, context, {
        name: 'set_monitoring',
        title: 'Start or stop monitoring',
        description:
            'Turns monitoring on or off. [[sonarr|whisparr: {{and: sonarr=Sonarr; whisparr=Whisparr}}: a series (by `id` or `title`), one `season`, or `episodes` (not both).]] [[lidarr: Lidarr takes `level: "album"` for one album\'s flag (ids from get_media_details on the artist, or a get_wanted `albumId`); an artist\'s own flag is update_media.]] [[radarr: Radarr monitoring is update_media.]] [[sonarr|whisparr: Unmonitor **before** delete_episode_files, or the *arr downloads the files again.]] Safe tier. The preview shows the current state; a season or episode that does not exist is refused rather than silently written. Previews first; confirm to apply. Field reference: arr://docs/set_monitoring.',
        inputSchema: SetMonitoringInput,
        target: { adapters, to: TARGET },
        operation: 'set_monitoring',
        tier: 'safe',

        async plan({ service, id: given, title, monitored, season, episodes, level }, adapter): Promise<WritePlan> {
            const id = await idOf(adapter.id, given, title, service);

            // Every refusal below is about the arguments, not about the service.
            // A ServiceError here would read as "sonarr has no such item" and send
            // the caller looking for a missing series when the gap was a missing
            // parameter.
            if (service === 'lidarr' && level !== 'album') {
                throw new Error(
                    'lidarr needs `level: "album"`: an album id and an artist id are two different namespaces, and Lidarr cannot tell them apart. ' +
                        "An artist's own flag is update_media."
                );
            }
            if (level !== undefined && service !== 'lidarr') {
                throw new Error('`level` is a lidarr parameter. Drop it. A series is monitored whole, per season, or per episode.');
            }
            if (id === undefined) {
                throw new Error('`id` is required. Take it from `acquisition.id` on a get_library or get_media_details record.');
            }
            refuseBoth(season, episodes, 'Omit both to monitor the whole series.');

            const verb = monitored ? 'Monitor' : 'Unmonitor';
            const who = ARR_NAMES[service];
            if (who === undefined) throw new Error(`set_monitoring: ARR_NAMES has no name for ${service}`);

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
                // unchanged, so the tool would report `applied: true` for a write
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
                // The episode form targets a set that can disagree with itself;
                // some monitored, some not, so no claim is made there. The season
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
                summary: `${verb} ${scope} in ${adapter.id}.`,
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

        async apply(_plan, { service, id: given, title, monitored, season, episodes }, adapter) {
            const id = await idOf(adapter.id, given, title, service);

            if (id === undefined) {
                throw new Error('This write needs `id`. Check the arguments before confirming it.');
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
