import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasPause, hasSpeedLimit, type ServiceAdapter } from '../services/types.ts';
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
            remedy: 'Only the download clients pause: sabnzbd, transmission and qbittorrent. Radarr and Sonarr have no pause — they keep grabbing, and the grabs queue up in whichever client is configured.'
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
            remedy: 'Only the download clients throttle: sabnzbd, transmission and qbittorrent.'
        });
    }
    return adapter;
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
            'Pauses, resumes or throttles one download client — SABnzbd, Transmission or qBittorrent — or pauses one item in its queue when `id` is given. The bandwidth answer: "stop downloading for an hour", or `action: "limit"` with `speed_limit_kbps` to slow it down instead of stopping it (0 removes the cap). A limit is always client-wide, never per item. Safe tier, because the undo is this same tool with the other action. It does NOT stop Radarr or Sonarr grabbing: they carry on finding and sending releases, which then sit in the paused client. `service` is required and names one client; pausing "everything" means one call each. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('sabnzbd, transmission or qbittorrent.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            action: z
                .enum(['pause', 'resume', 'limit'])
                .describe('pause, resume, or limit to cap the download speed without stopping anything.'),
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
                    'One queue item to pause, exactly as get_queue reported its id. Omit to pause the whole client.'
                )
        }),
        // The resolved instance id, not the bare type — permissions are
        // granted per instance.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'pause_downloads',
        tier: 'safe',

        async plan({ service, instance, action, id, speed_limit_kbps }): Promise<WritePlan> {
            if (action === 'limit') {
                if (speed_limit_kbps === undefined) {
                    throw new Error('limit needs `speed_limit_kbps` — the cap in KB/s, or 0 to remove it.');
                }

                const client = findLimitAdapter(adapters, service, instance);
                const current = await client.readSpeedLimit();
                const wanted = speed_limit_kbps === 0 ? undefined : speed_limit_kbps;
                const target = `${service}:limit`;

                if (current.kbps === wanted) {
                    return {
                        target,
                        summary:
                            wanted === undefined
                                ? `${service} already has no download limit.`
                                : `${service} is already limited to ${wanted} KB/s.`,
                        effects: [],
                        noop: true
                    };
                }

                return {
                    target,
                    summary:
                        wanted === undefined
                            ? `Remove the download limit on ${service}.`
                            : `Limit ${service} to ${wanted} KB/s.`,
                    effects: [
                        wanted === undefined
                            ? `${service} will download as fast as the line allows${current.kbps === undefined ? '' : `, instead of the current ${current.kbps} KB/s`}.`
                            : `Caps ${service} at ${wanted} KB/s${current.kbps === undefined ? ', which currently has no limit' : `, from ${current.kbps} KB/s`}. Client-wide, not per item.`,
                        'Does NOT stop Radarr or Sonarr grabbing. They keep sending releases; they just arrive more slowly.',
                        'Undo it by calling this tool again with action: "limit" and a different value — 0 removes the cap.'
                    ],
                    args: { action, kbps: speed_limit_kbps }
                };
            }

            const adapter = findAdapter(adapters, service, instance);
            const paused = action === 'pause';
            const state = await adapter.readPauseState(id);

            const target = `${service}:${id ?? 'all'}`;

            // Asking someone to confirm a no-op teaches them to confirm
            // without reading.
            if (state.paused === paused) {
                return {
                    target,
                    summary: `${state.scope} on ${service} ${paused ? 'is already paused' : 'is already running'}.`,
                    effects: [],
                    noop: true
                };
            }

            const effects = paused
                ? [
                      `Stops ${state.scope} on ${service}. Nothing already downloaded is lost, and partial downloads resume where they left off.`,
                      // The thing a bare "paused" would let someone believe.
                      'Does NOT stop Radarr or Sonarr searching and grabbing. They keep sending releases, which pile up in this client until it is resumed.',
                      `Undo it by calling this tool again with action: "resume".`
                  ]
                : [
                      `Restarts ${state.scope} on ${service}. Downloading resumes immediately and uses bandwidth.`,
                      'Anything Radarr or Sonarr grabbed while it was paused starts downloading too.'
                  ];

            return {
                target,
                summary: `${paused ? 'Pause' : 'Resume'} ${state.scope} on ${service}.`,
                effects,
                args: { action, ...(id === undefined ? {} : { id }) }
            };
        },

        async apply(_plan, { service, instance, action, id, speed_limit_kbps }) {
            if (action === 'limit') {
                const kbps = speed_limit_kbps === undefined || speed_limit_kbps === 0 ? undefined : speed_limit_kbps;
                await findLimitAdapter(adapters, service, instance).setSpeedLimit(kbps);
                return { limitKbps: kbps ?? null, service };
            }

            await findAdapter(adapters, service, instance).setPaused(action === 'pause', id);
            return { [action === 'pause' ? 'paused' : 'resumed']: `${service}:${id ?? 'all'}` };
        }
    });
}
