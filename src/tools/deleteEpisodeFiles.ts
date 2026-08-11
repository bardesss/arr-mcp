import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasEpisodeFiles, hasMediaDetails, type ServiceAdapter } from '../services/types.ts';
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

            const details = await adapter.getMediaDetails(id, {
                includeEpisodes: episodes !== undefined,
                episodeLimit: 500
            });
            const label = `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;
            const all = await adapter.listEpisodeFiles(id);

            const fileIds =
                season !== undefined
                    ? all.filter(f => f.season === season).map(f => f.id)
                    : (details.episodes ?? [])
                          .filter(e => episodes?.includes(String(e.id)) === true)
                          .map(e => e.episodeFileId)
                          .filter((f): f is number => typeof f === 'number' && f > 0);

            const bytes = all.filter(f => fileIds.includes(f.id)).reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
            const size = humanSize(bytes);
            const scope = season !== undefined ? `season ${season} of ${label}` : `${fileIds.length} episode(s) of ${label}`;

            if (fileIds.length === 0) {
                return {
                    target: `${service}:${id}:${season !== undefined ? `s${season}` : 'e'}`,
                    summary: `${scope} has no files on disk.`,
                    effects: [],
                    noop: true
                };
            }

            const monitored =
                season !== undefined ? details.seasons?.find(s => s.season === season)?.monitored : undefined;

            const effects: string[] = [
                size === undefined
                    ? `Deletes ${fileIds.length} file(s) from disk. This cannot be undone.`
                    : `Deletes ${size} across ${fileIds.length} file(s) from disk. This cannot be undone.`
            ];

            // Only when it is actually still monitored. A warning that always
            // fires is noise nobody reads.
            if (monitored === true) {
                effects.push(
                    `Season ${season} is still monitored — Sonarr will search for these episodes again and re-download them. Unmonitor it first with set_monitoring.`
                );
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
                // existed. `apply` uses these rather than re-resolving.
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
