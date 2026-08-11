import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasEpisodeFiles, hasMediaDetails, type EpisodeSummary, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

const GIB = 1024 ** 3;

/** Deliberately coarse, like delete_media's: this number exists to make someone
 *  hesitate, not to balance a ledger. */
function humanSize(bytes: number): string | undefined {
    if (bytes <= 0) return undefined;
    return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasEpisodeFiles(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no episode files to delete`, {
            remedy: 'Only sonarr has per-episode files. Use delete_media for a film.'
        });
    }
    return adapter;
};

export function registerDeleteEpisodeFiles(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'delete_episode_files',
        description:
            'Deletes the files for one Sonarr season, or for specific episodes, from disk. Destructive and not undoable. Give `season` or `episodes`, never both; there is no whole-series form — that is delete_media. **Unmonitor first with set_monitoring**, or Sonarr treats the episodes as missing and re-downloads exactly what you just deleted; the preview says so when the target is still monitored. Leaves the series, its monitoring and its history in Sonarr — only the files go. Previews by default — call again with the returned `confirm` token to actually delete.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('sonarr.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.string().min(1).describe('The series id, as an integer string.'),
            season: z.number().int().min(0).optional().describe('One season. 0 is specials.'),
            episodes: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe('Specific episode ids, as integer strings. Mutually exclusive with `season`.')
        }),
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'delete_episode_files',
        tier: 'destructive',

        async plan({ service, instance, id, season, episodes }): Promise<WritePlan> {
            if (season !== undefined && episodes !== undefined) {
                throw new Error(
                    '`season` and `episodes` were both given. They are different targets — send one.'
                );
            }
            if (season === undefined && episodes === undefined) {
                throw new Error(
                    'Give either `season` or `episodes`. There is no whole-series form here — use delete_media with `delete_files: true` for that.'
                );
            }

            const adapter = findAdapter(adapters, service, instance);
            if (!hasMediaDetails(adapter)) {
                throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
            }

            // Episodes on both paths, not just the `episodes` one. The
            // re-download warning below is the entire mitigation for shipping
            // monitoring and deletion as two primitives, and Sonarr's searches
            // key on the **episode** monitored flag — `seasons[].monitored` is
            // a UI aggregate over it. Toggling a season cascades down, but
            // set_monitoring's own episode form writes episode flags and never
            // touches the aggregate, so a season can read `monitored: false`
            // while its episodes are monitored. Reading the aggregate here
            // would leave the warning silent in exactly the state this branch
            // can create.
            const details = await adapter.getMediaDetails(id, { includeEpisodes: true, episodeLimit: 500 });
            const label = `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;
            const all = await adapter.listEpisodeFiles(id);

            let fileIds: number[];
            // Episodes whose file is about to go, so the preview can name
            // exactly what will disappear and check their monitoring — not
            // just the requested ids, which may be a strict subset of that
            // (see `collateral` below).
            let episodesLosingFiles: EpisodeSummary[] = [];
            // Requested episodes that share a file with an episode the caller
            // did not name — Sonarr routinely stores a double episode as one
            // `episodefile`, so deleting episode 11's file can also remove
            // episode 12's without episode 12 ever being asked for.
            let collateral: EpisodeSummary[] = [];

            if (season !== undefined) {
                fileIds = all.filter(f => f.season === season).map(f => f.id);
            } else {
                const requested = episodes ?? [];
                const allEpisodes = details.episodes ?? [];
                const foundIds = new Set(allEpisodes.map(e => String(e.id)));

                // An id `getMediaDetails` never returned — wrong, or past the
                // 500-episode cap — is not "nothing to delete"; it is "I
                // could not see that episode at all". Reporting a noop or a
                // quietly-short count for that would misdescribe the request,
                // so this refuses instead of guessing.
                const unresolved = requested.filter(rid => !foundIds.has(rid));
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

                const requestedIdSet = new Set(requested);
                const targeted = allEpisodes.filter(e => requestedIdSet.has(String(e.id)));
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
            const episodeCount = season !== undefined ? fileIds.length : episodesLosingFiles.length;
            const scope = season !== undefined ? `season ${season} of ${label}` : `${episodeCount} episode(s) of ${label}`;

            if (fileIds.length === 0) {
                return {
                    target: `${service}:${id}:${season !== undefined ? `s${season}` : 'e'}`,
                    summary: `${scope} has no files on disk.`,
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
            // the same question of the same field — the episode's own flag,
            // which is what Sonarr's searches key on.
            if (season !== undefined) {
                const stillMonitored = (details.episodes ?? []).filter(
                    e => e.season === season && e.monitored === true
                );
                if (stillMonitored.length > 0) {
                    const plural = stillMonitored.length > 1;
                    effects.push(
                        `${stillMonitored.length} episode(s) in season ${season} ${plural ? 'are' : 'is'} still monitored — Sonarr will search for ${plural ? 'them' : 'it'} again and re-download ${plural ? 'them' : 'it'}. Unmonitor the season first with set_monitoring.`
                    );
                } else if (details.episodesTruncated === true) {
                    // Finding nothing monitored is only an answer when
                    // everything was looked at. The episode list is capped at
                    // 500 and sliced in Sonarr's own order, so on a series
                    // longer than that — The Simpsons, Doctor Who, a long
                    // anime — this season's episodes can sit outside the
                    // window entirely, and silence would read as "nothing is
                    // monitored" when it means "I could not see". The files
                    // themselves come from `listEpisodeFiles`, which is not
                    // truncated, so the delete is still exact; it is only the
                    // advisory that has a hole, and saying so is better than
                    // refusing a legitimate delete over it.
                    effects.push(
                        `Whether season ${season} is still monitored could not be established — the episode list was truncated at 500, so some of its episodes were never fetched. If any of them is monitored, Sonarr will search for it again and re-download it. Unmonitor the season first with set_monitoring to be sure.`
                    );
                }
            } else {
                const stillMonitored = episodesLosingFiles.filter(e => e.monitored === true);
                if (stillMonitored.length > 0) {
                    const plural = stillMonitored.length > 1;
                    const names = stillMonitored.map(e => `S${e.season}E${e.episode}`).join(', ');
                    effects.push(
                        `${names} ${plural ? 'are' : 'is'} still monitored — Sonarr will search for ${plural ? 'them' : 'it'} again and re-download ${plural ? 'them' : 'it'}. Unmonitor ${plural ? 'them' : 'it'} first with set_monitoring.`
                    );
                }
            }

            effects.push(
                `Leaves ${label}, its monitoring and its history in ${service}. Only the files go.`
            );

            return {
                target: `${service}:${id}:${season !== undefined ? `s${season}` : `e${fileIds.join(',')}`}`,
                summary: `Delete ${fileIds.length} episode file(s) from ${scope}${size === undefined ? '' : `, ${size}`} from disk.`,
                effects,
                // The ids, not the season: a file imported between preview and
                // confirm must not be swept up by a token issued before it
                // existed. The protection is the token's signature: `apply`
                // gets whatever `plan` resolves at confirm time, and a
                // resolution that has drifted from what was previewed fails to
                // verify — the write is refused rather than applied against
                // stale or changed ids.
                args: { service, id, fileIds }
            };
        },

        async apply(plan, { service, instance }) {
            const fileIds = (plan.args?.fileIds ?? []) as number[];
            await findAdapter(adapters, service, instance).deleteEpisodeFiles(fileIds);
            return { deleted: fileIds.length, target: plan.target };
        }
    });
}
