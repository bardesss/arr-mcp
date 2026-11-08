import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasFileSelection, hasPause, hasSpeedLimit, type ServiceAdapter, type TorrentFile } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * "Stop downloading, I need the bandwidth" — and its inverse, which is the
 * whole reason this is `safe` tier: the undo is the same tool with the other
 * action.
 *
 * `service` is **required**, one client per call, rather than defaulting to
 * every configured client. `registerWriteTool` resolves exactly one service id
 * from the arguments and checks that service's permissions, and a tool
 * spanning three clients would have to name one of them there — which is the
 * failure `write.ts` calls out by name: it would check SABnzbd's writes
 * against Transmission's `permissions` block, so enabling one client would
 * quietly enable another. Naming the client is a small cost; checking the
 * wrong permission is not.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasPause(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot be paused`, {
            remedy: 'Only the download clients pause: sabnzbd, nzbget, transmission and qbittorrent. Radarr and Sonarr have no pause — they keep grabbing, and the grabs queue up in whichever client is configured.'
        });
    }
    return adapter;
};

/** A speed cap is its own capability: a client can pause without having one,
 *  and reporting a limit that was never applied is worse than refusing. */
const findLimitAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasSpeedLimit(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no download speed limit to set`, {
            remedy: 'Only the download clients throttle: sabnzbd, nzbget, transmission and qbittorrent.'
        });
    }
    return adapter;
};

/** Choosing files is a torrent-client capability; a usenet client has none to choose. */
const findFilesAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasFileSelection(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no per-file choice to make`, {
            remedy: 'Only the torrent clients choose files: transmission and qbittorrent.'
        });
    }
    return adapter;
};

const GIB = 1024 ** 3;
const size = (bytes: number): string => (bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/** "#2 Movie.nfo", fenced name and all, for a preview line. Five at most: a season pack can hold fifty. */
const fileList = (files: readonly TorrentFile[]): string => {
    const shown = files.slice(0, 5).map(f => `#${f.index} ${f.name}`).join('; ');
    return files.length > 5 ? `${shown}; and ${files.length - 5} more` : shown;
};

export function registerPauseDownloads(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'pause_downloads',
        title: 'Pause, resume or throttle a download client',
        description:
            'Pauses, resumes or throttles one download client — SABnzbd, NZBGet, Transmission or qBittorrent — or pauses one item in its queue when `id` is given. The bandwidth answer: "stop downloading for an hour", or `action: "limit"` with `speed_limit_kbps` to slow it down instead of stopping it (0 removes the cap). A limit is always client-wide, never per item. On a torrent client, `skip_files` and `want_files` choose which files of one torrent (`id`) are downloaded and shared — qBittorrent\'s "Do not download" and back — taking `files` indexes from get_queue. Safe tier, because the undo is this same tool with the other action. It does NOT stop Radarr or Sonarr grabbing: they carry on finding and sending releases, which then sit in the paused client. `service` is required and names one client; pausing "everything" means one call each. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('sabnzbd, nzbget, transmission or qbittorrent.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            action: z
                .enum(['pause', 'resume', 'limit', 'skip_files', 'want_files'])
                .describe(
                    'pause, resume, or limit to cap the download speed without stopping anything. skip_files and want_files act on files inside one torrent (`id` required): skip_files stops downloading and sharing them, want_files brings them back.'
                ),
            speed_limit_kbps: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    'With action: "limit", the download cap in KB/s — 0 removes the cap. Client-wide, never per item. Required for "limit" and ignored otherwise.'
                ),
            id: z
                .string()
                .optional()
                .describe(
                    'One queue item to pause, exactly as get_queue reported its id. Omit to pause the whole client. Required for skip_files and want_files.'
                ),
            files: z
                .array(z.number().int().min(0))
                .min(1)
                .optional()
                .describe(
                    'With skip_files or want_files: file indexes, as get_queue lists them for this torrent at detail: "full". Required for skip_files. Omitted with want_files, every skipped file comes back.'
                )
        }),
        // The resolved instance id, not the bare type — permissions are
        // granted per instance.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'pause_downloads',
        tier: 'safe',

        async plan({ service, instance, action, id, speed_limit_kbps, files }): Promise<WritePlan> {
            if (action === 'skip_files' || action === 'want_files') {
                const wanted = action === 'want_files';
                if (id === undefined) {
                    throw new Error(`${action} acts on one torrent: pass its \`id\` from get_queue.`);
                }
                if (!wanted && files === undefined) {
                    throw new Error('skip_files needs `files`: the indexes to skip, from get_queue with this id and detail: "full".');
                }

                const client = findFilesAdapter(adapters, service, instance);
                const current = await client.readTorrentFiles(id);
                const byIndex = new Map(current.map(f => [f.index, f]));
                const unknown = (files ?? []).filter(i => !byIndex.has(i));
                if (unknown.length > 0) {
                    throw new Error(
                        `Torrent ${id} has no file at index ${unknown.join(', ')}. Its files are indexed ${current.length === 0 ? '(none yet: metadata has not arrived)' : `${Math.min(...byIndex.keys())} to ${Math.max(...byIndex.keys())}`}; read them with get_queue, this id and detail: "full".`
                    );
                }

                const named = files === undefined ? current : files.map(i => byIndex.get(i)!);
                const changing = named.filter(f => f.wanted !== wanted);
                const target = `${client.id}:${id}:files`;

                if (changing.length === 0) {
                    return {
                        target,
                        summary:
                            files === undefined
                                ? `No file of torrent ${id} on ${client.id} is skipped.`
                                : `Those files of torrent ${id} are already ${wanted ? 'downloaded' : 'skipped'} on ${client.id}.`,
                        effects: [],
                        noop: true
                    };
                }

                const indexes = changing.map(f => f.index).sort((a, b) => a - b);
                const missing = changing.reduce((sum, f) => sum + Math.round(f.sizeBytes * (1 - f.progress)), 0);
                const effects = wanted
                    ? [
                          `${client.id} downloads and shares ${changing.length} file${changing.length === 1 ? '' : 's'} again: ${fileList(changing)}.`,
                          missing === 0
                              ? 'Nothing left to download: the data is already there, so this only shares it again.'
                              : `About ${size(missing)} still to download.`,
                          'Each comes back at normal priority, whatever it had before it was skipped.',
                          'Undo it with action: "skip_files" and the same indexes.'
                      ]
                    : [
                          `${client.id} stops downloading and sharing ${changing.length} file${changing.length === 1 ? '' : 's'}: ${fileList(changing)}.`,
                          'Deletes nothing on disk itself. The torrent no longer counts as complete, so peers get less from you, and a tool that links or imports these files (cross-seed, Radarr, Sonarr) will not find them.',
                          'Undo it with action: "want_files".'
                      ];

                return {
                    target,
                    summary: `${wanted ? 'Download' : 'Skip'} ${changing.length} file${changing.length === 1 ? '' : 's'} of torrent ${id} on ${client.id}.`,
                    effects,
                    args: { action, id, indexes }
                };
            }

            if (action === 'limit') {
                if (speed_limit_kbps === undefined) {
                    throw new Error('limit needs `speed_limit_kbps` — the cap in KB/s, or 0 to remove it.');
                }

                const client = findLimitAdapter(adapters, service, instance);
                const current = await client.readSpeedLimit();
                const wanted = speed_limit_kbps === 0 ? undefined : speed_limit_kbps;
                const target = `${client.id}:limit`;

                if (current.kbps === wanted) {
                    return {
                        target,
                        summary:
                            wanted === undefined
                                ? `${client.id} already has no download limit.`
                                : `${client.id} is already limited to ${wanted} KB/s.`,
                        effects: [],
                        noop: true
                    };
                }

                return {
                    target,
                    summary:
                        wanted === undefined
                            ? `Remove the download limit on ${client.id}.`
                            : `Limit ${client.id} to ${wanted} KB/s.`,
                    effects: [
                        wanted === undefined
                            ? `${client.id} will download as fast as the line allows${current.kbps === undefined ? '' : `, instead of the current ${current.kbps} KB/s`}.`
                            : `Caps ${client.id} at ${wanted} KB/s${current.kbps === undefined ? ', which currently has no limit' : `, from ${current.kbps} KB/s`}. Client-wide, not per item.`,
                        'Does NOT stop Radarr or Sonarr grabbing. They keep sending releases; they just arrive more slowly.',
                        'Undo it by calling this tool again with action: "limit" and a different value — 0 removes the cap.'
                    ],
                    args: { action, kbps: speed_limit_kbps }
                };
            }

            const adapter = findAdapter(adapters, service, instance);
            const paused = action === 'pause';
            const state = await adapter.readPauseState(id);

            const target = `${adapter.id}:${id ?? 'all'}`;

            // Asking someone to confirm a no-op teaches them to confirm
            // without reading.
            if (state.paused === paused) {
                return {
                    target,
                    summary: `${state.scope} on ${adapter.id} ${paused ? 'is already paused' : 'is already running'}.`,
                    effects: [],
                    noop: true
                };
            }

            const effects = paused
                ? [
                      `Stops ${state.scope} on ${adapter.id}. Nothing already downloaded is lost, and partial downloads resume where they left off.`,
                      // The thing a bare "paused" would let someone believe.
                      'Does NOT stop Radarr or Sonarr searching and grabbing. They keep sending releases, which pile up in this client until it is resumed.',
                      `Undo it by calling this tool again with action: "resume".`
                  ]
                : [
                      `Restarts ${state.scope} on ${adapter.id}. Downloading resumes immediately and uses bandwidth.`,
                      'Anything Radarr or Sonarr grabbed while it was paused starts downloading too.'
                  ];

            return {
                target,
                summary: `${paused ? 'Pause' : 'Resume'} ${state.scope} on ${adapter.id}.`,
                effects,
                args: { action, ...(id === undefined ? {} : { id }) }
            };
        },

        async apply(plan, { service, instance, action, id, speed_limit_kbps }) {
            if (action === 'skip_files' || action === 'want_files') {
                // The indexes the preview resolved, which the token is bound
                // to: "want every skipped file" means the ones it listed.
                const indexes = plan.args?.['indexes'] as number[];
                const client = findFilesAdapter(adapters, service, instance);
                await client.setFilesWanted(id!, indexes, action === 'want_files');
                return { [action === 'want_files' ? 'wanted' : 'skipped']: indexes, torrent: `${client.id}:${id}` };
            }

            if (action === 'limit') {
                const kbps = speed_limit_kbps === undefined || speed_limit_kbps === 0 ? undefined : speed_limit_kbps;
                const client = findLimitAdapter(adapters, service, instance);
                await client.setSpeedLimit(kbps);
                return { limitKbps: kbps ?? null, service: client.id };
            }

            const adapter = findAdapter(adapters, service, instance);
            await adapter.setPaused(action === 'pause', id);
            return { [action === 'pause' ? 'paused' : 'resumed']: `${adapter.id}:${id ?? 'all'}` };
        }
    });
}
