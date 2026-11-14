import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { hasEpisodeFiles, type EpisodeSummary, type ServiceAdapter } from '../services/types.ts';
import { arrSubject } from './crossChecks.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';
import { checkScope, describable, EPISODE_LIMIT, refuseBoth } from './itemScope.ts';

const GIB = 1024 ** 3;

/** Deliberately coarse, like delete_media's: this number exists to make someone
 *  hesitate, not to balance a ledger. */
function humanSize(bytes: number): string | undefined {
    if (bytes <= 0) return undefined;
    return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const TARGET = serviceTarget({
    services: ['sonarr', 'whisparr'],
    can: hasEpisodeFiles,
    cannot: 'has no episode files to delete',
    hint: 'Use delete_media for a film.'
});

const DeleteEpisodeFilesInput = z.object({
    ...targetInput(TARGET),
    id: z.string().min(1).describe('The series id, as an integer string.'),
    season: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('One season. 0 is specials.[[whisparr:  On Whisparr a season is a release year, e.g. 2019.]]'),
    episodes: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Specific episode ids, as integer strings. Mutually exclusive with `season`.')
});

export function registerDeleteEpisodeFiles(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'delete_episode_files',
        title: 'Delete episode files',
        description:
            'Deletes the files for one Sonarr season, or for specific episodes, from disk. Destructive and not undoable. Give `season` or `episodes`, never both; there is no whole-series form; that is delete_media. **Unmonitor first with set_monitoring**, or Sonarr treats the episodes as missing and re-downloads exactly what you just deleted; the preview says so when the target is still monitored. Leaves the series, its monitoring and its history in Sonarr; only the files go. Previews first; confirm to delete.',
        inputSchema: DeleteEpisodeFilesInput,
        target: { adapters, to: TARGET },
        operation: 'delete_episode_files',
        tier: 'destructive',
        crossCheck: 'delete',

        async plan({ service, id, season, episodes }, adapter): Promise<WritePlan<{ service: string; id: string; fileIds: number[] }>> {
            refuseBoth(season, episodes);
            if (season === undefined && episodes === undefined) {
                throw new Error(
                    'Give either `season` or `episodes`. There is no whole-series form here; use delete_media with `delete_files: true` for that.'
                );
            }

            // Episodes on both paths, not just the `episodes` one. The
            // re-download warning below is the entire mitigation for shipping
            // monitoring and deletion as two primitives, and Sonarr's searches
            // key on the **episode** monitored flag, `seasons[].monitored` is
            // a UI aggregate over it. Toggling a season cascades down, but
            // set_monitoring's own episode form writes episode flags and never
            // touches the aggregate, so a season can read `monitored: false`
            // while its episodes are monitored. Reading the aggregate here
            // would leave the warning silent in exactly the state this branch
            // can create.
            const details = await describable(adapter, service).getMediaDetails(id, { includeEpisodes: true, episodeLimit: EPISODE_LIMIT });
            const label = titled(details.title, details.year);
            // A season the series does not have is refused, not reported as
            // "no files on disk": that sentence claims the season was looked
            // at, and on Whisparr (where a season is a release year) `season:
            // 1` is the likeliest wrong input. Only when seasons were reported:
            // no list is no evidence, and refusing on that would be a guess.
            checkScope(details, label, service, { season, episodes });

            const all = await adapter.listEpisodeFiles(id);

            let fileIds: number[];
            // Episodes whose file is about to go, so the preview can name
            // exactly what will disappear and check their monitoring; not
            // just the requested ids, which may be a strict subset of that
            // (see `collateral` below).
            let episodesLosingFiles: EpisodeSummary[] = [];
            // Requested episodes that share a file with an episode the caller
            // did not name; Sonarr routinely stores a double episode as one
            // `episodefile`, so deleting episode 11's file can also remove
            // episode 12's without episode 12 ever being asked for.
            let collateral: EpisodeSummary[] = [];
            // The requested episodes the series has. With no file to delete none
            // of them loses one, so the no-op counts these.
            let targeted: EpisodeSummary[] = [];

            if (season !== undefined) {
                fileIds = all.filter(f => f.season === season).map(f => f.id);
            } else {
                const requested = episodes ?? [];
                const allEpisodes = details.episodes ?? [];

                const requestedIdSet = new Set(requested);
                targeted = allEpisodes.filter(e => requestedIdSet.has(String(e.id)));
                const rawFileIds = targeted
                    .map(e => e.episodeFileId)
                    .filter((f): f is number => typeof f === 'number' && f > 0);
                // De-duplicated: two requested episodes can share one file
                // (a double episode), and the DELETE body must not carry the
                // same id twice.
                fileIds = Array.from(new Set(rawFileIds));

                episodesLosingFiles = allEpisodes.filter(
                    e => typeof e.episodeFileId === 'number' && fileIds.includes(e.episodeFileId)
                );
                collateral = episodesLosingFiles.filter(e => !requestedIdSet.has(String(e.id)));
            }

            const bytes = all.filter(f => fileIds.includes(f.id)).reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
            const size = humanSize(bytes);
            const episodeCount = fileIds.length === 0 ? targeted.length : episodesLosingFiles.length;
            const scope = `${season !== undefined ? `season ${season}` : `${episodeCount} episode(s)`} of ${label} in ${adapter.id}`;

            if (fileIds.length === 0) {
                return {
                    target: `${adapter.id}:${id}:${season !== undefined ? `s${season}` : 'e'}`,
                    summary: `${scope} ${season === undefined && episodeCount !== 1 ? 'have' : 'has'} no files on disk.`,
                    effects: [],
                    noop: true
                };
            }

            const effects: string[] = [
                size === undefined
                    ? `Deletes ${fileIds.length} file(s) from disk. This cannot be undone.`
                    : `Deletes ${size} across ${fileIds.length} file(s) from disk. This cannot be undone.`
            ];

            if (collateral.length > 0) {
                const names = collateral.map(e => `S${e.season}E${e.episode}`).join(', ');
                effects.push(
                    `${names} share${collateral.length === 1 ? 's' : ''} a file with an episode you targeted, and will be deleted too.`
                );
            }

            // Only when something targeted is actually still monitored. A
            // warning that always fires is noise nobody reads. Both paths ask
            // the same question of the same field; the episode's own flag,
            // which is what Sonarr's searches key on.
            if (season !== undefined) {
                const stillMonitored = (details.episodes ?? []).filter(
                    e => e.season === season && e.monitored === true
                );
                if (stillMonitored.length > 0) {
                    const plural = stillMonitored.length > 1;
                    effects.push(
                        `${stillMonitored.length} episode(s) in season ${season} ${plural ? 'are' : 'is'} still monitored. Sonarr will search for ${plural ? 'them' : 'it'} again and re-download ${plural ? 'them' : 'it'}. Unmonitor the season first with set_monitoring.`
                    );
                } else if (details.episodesTruncated === true) {
                    // Finding nothing monitored is only an answer when
                    // everything was looked at. The episode list is capped at
                    // 500 and sliced in Sonarr's own order, so on a series
                    // longer than that; The Simpsons, Doctor Who, a long
                    // anime; this season's episodes can sit outside the
                    // window entirely, and silence would read as "nothing is
                    // monitored" when it means "I could not see". The files
                    // themselves come from `listEpisodeFiles`, which is not
                    // truncated, so the delete is still exact; it is only the
                    // advisory that has a hole, and saying so is better than
                    // refusing a legitimate delete over it.
                    effects.push(
                        `Whether season ${season} is still monitored could not be established. The episode list was truncated at 500, so some of its episodes were never fetched. If any of them is monitored, Sonarr will search for it again and re-download it. Unmonitor the season first with set_monitoring to be sure.`
                    );
                }
            } else {
                const stillMonitored = episodesLosingFiles.filter(e => e.monitored === true);
                if (stillMonitored.length > 0) {
                    const plural = stillMonitored.length > 1;
                    const names = stillMonitored.map(e => `S${e.season}E${e.episode}`).join(', ');
                    effects.push(
                        `${names} ${plural ? 'are' : 'is'} still monitored. Sonarr will search for ${plural ? 'them' : 'it'} again and re-download ${plural ? 'them' : 'it'}. Unmonitor ${plural ? 'them' : 'it'} first with set_monitoring.`
                    );
                }
            }

            effects.push(
                `Leaves ${label}, its monitoring and its history in ${service}. Only the files go.`
            );

            return {
                target: `${adapter.id}:${id}:${season !== undefined ? `s${season}` : `e${fileIds.join(',')}`}`,
                summary: `Delete ${fileIds.length} episode file(s) from ${scope}${size === undefined ? '' : `, ${size}`} from disk.`,
                effects,
                // The ids, not the season: a file imported between preview and
                // confirm must not be swept up by a token issued before it
                // existed. The protection is the token's signature: `apply`
                // gets whatever `plan` resolves at confirm time, and a
                // resolution that has drifted from what was previewed fails to
                // verify; the write is refused rather than applied against
                // stale or changed ids.
                args: { service, id, fileIds },
                // Empty for named episodes, not absent: they are part of the
                // title, and the series' watched flag says nothing about them.
                ...arrSubject(adapter, {
                    label,
                    ids: details.ids,
                    acquisition: { service: adapter.id, id },
                    seasons: season === undefined ? [] : [season]
                })
            };
        },

        async apply(plan, _args, adapter) {
            const fileIds = plan.args?.fileIds ?? [];
            await adapter.deleteEpisodeFiles(fileIds);
            return { deleted: fileIds.length, target: plan.target };
        }
    });
}
