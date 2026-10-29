import { resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DOWNLOAD_CLIENTS, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasPause, hasSpeedLimit, type QueueHold, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';

/**
 * "Stop downloading, I need the bandwidth", and its inverse, which is the
 * whole reason this is `safe` tier: the undo is the same tool with the other
 * action.
 *
 * `service` is **required**, one client per call, rather than defaulting to
 * every configured client. `registerWriteTool` resolves exactly one service id
 * from the arguments and checks that service's permissions, and a tool
 * spanning three clients would have to name one of them there, which is the
 * failure `write.ts` calls out by name: it would check SABnzbd's writes
 * against Transmission's `permissions` block, so enabling one client would
 * quietly enable another. Naming the client is a small cost; checking the
 * wrong permission is not.
 */

const TARGET = serviceTarget({
    services: DOWNLOAD_CLIENTS,
    can: hasPause,
    cannot: 'cannot be paused',
    hint: 'The *arrs have no pause. They keep grabbing, and the grabs queue up in whichever client is configured.'
});

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

const PauseDownloadsInput = z.object({
    ...targetInput(TARGET),
    action: z
        .enum(['pause', 'resume', 'limit'])
        .describe('pause, resume, or limit to cap the download speed without stopping anything.'),
    speed_limit_kbps: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            'With action: "limit", the download cap in KiB/s; 0 removes the cap. Client-wide, never per item. Required for "limit" and ignored otherwise.'
        ),
    id: z
        .string()
        .optional()
        .describe(
            'One queue item to pause or resume, exactly as get_queue reported its id. Omit for the whole client. Refused with action "limit".'
        )
});

/**
 * What else holds one SABnzbd or NZBGet item, for its resume preview and for
 * the no-op of an item not paused itself: its client's paused queue, which this
 * tool resumes without an `id`; SABnzbd's wait for post-processing, which ends
 * by itself, though its rows can look like it under a manual pause
 * (`sabHolds`); or NZBGet's paused post-processing, which this tool does not
 * resume.
 */
const HOLD_TEXT: Readonly<Record<QueueHold, (client: string) => { noop: string; effect: string }>> = {
    queue: client => ({
        noop: `${client}'s whole queue is: resume that with this tool and no \`id\`.`,
        effect: `${client}'s whole queue is paused too, so it starts downloading only once that is resumed, with this tool and no \`id\`.`
    }),
    postProcessing: client => ({
        noop: `${client} pauses its queue while it post-processes ("Pause Downloading During Post-Processing"), and resumes by itself; if it stays paused, resume it with this tool and no \`id\`.`,
        effect: `${client} pauses its queue while it post-processes ("Pause Downloading During Post-Processing"), so it starts downloading once that ends; if the queue stays paused, resume it with this tool and no \`id\`.`
    }),
    postPaused: client => ({
        noop: `${client}'s post-processing is: it waits there until post-processing is resumed in ${client}.`,
        effect: `${client}'s post-processing is paused too, so it then waits there until post-processing is resumed in ${client}.`
    })
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
            'Pauses, resumes or throttles one download client ({{or: sabnzbd=SABnzbd; nzbget=NZBGet; transmission=Transmission; qbittorrent=qBittorrent}}) or one item in its queue when `id` is given. The bandwidth answer: "stop downloading for an hour", or `action: "limit"` with `speed_limit_kbps` (KiB/s) to slow it down instead of stopping it (0 removes the cap). A limit is always client-wide, never per item. Safe tier, because the undo is this same tool with the other action. It does NOT stop the *arrs grabbing: they carry on finding and sending releases, which then sit in the paused client. `service` is required and names one client; pausing "everything" means one call each. Previews first; confirm to apply it.',
        inputSchema: PauseDownloadsInput,
        // The resolved instance id, not the bare type: permissions are
        // granted per instance.
        target: { adapters, to: TARGET },
        operation: 'pause_downloads',
        tier: 'safe',

        async plan({ service, instance, action, id, speed_limit_kbps }, adapter): Promise<WritePlan> {
            if (action === 'limit') {
                if (id !== undefined) {
                    throw new Error(
                        '`id` cannot be used with action "limit": a limit is always client-wide. Drop `id`, or use action "pause" to pause that one item.'
                    );
                }
                if (speed_limit_kbps === undefined) {
                    throw new Error('limit needs `speed_limit_kbps`, the cap in KiB/s, or 0 to remove it.');
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
                                : `${client.id} is already limited to ${wanted} KiB/s.`,
                        effects: [],
                        noop: true
                    };
                }

                return {
                    target,
                    summary:
                        wanted === undefined
                            ? `Remove the download limit on ${client.id}.`
                            : `Limit ${client.id} to ${wanted} KiB/s.`,
                    effects: [
                        wanted === undefined
                            ? `${client.id} will download as fast as the line allows${current.kbps === undefined ? '' : `, instead of the current ${current.kbps} KiB/s`}.`
                            : `Caps ${client.id} at ${wanted} KiB/s${current.kbps === undefined ? ', which currently has no limit' : `, from ${current.kbps} KiB/s`}. Client-wide, not per item.`,
                        'Does NOT stop the *arrs grabbing. They keep sending releases; they just arrive more slowly.',
                        'Undo it by calling this tool again with action: "limit" and a different value; 0 removes the cap.'
                    ],
                    args: { action, kbps: speed_limit_kbps }
                };
            }
            const paused = action === 'pause';
            const state = await adapter.readPauseState(id);

            const target = `${adapter.id}:${id ?? 'all'}`;

            // Asking someone to confirm a no-op teaches them to confirm
            // without reading.
            if (state.paused === paused) {
                // A held item that is not paused itself is not running either.
                const held = paused ? undefined : state.heldBy;
                return {
                    target,
                    summary:
                        held === undefined
                            ? `${state.scope} on ${adapter.id} ${paused ? 'is already paused' : 'is already running'}.`
                            : `${state.scope} on ${adapter.id} is not paused itself, but ${HOLD_TEXT[held](adapter.id).noop}`,
                    effects: [],
                    noop: true
                };
            }

            // One item paused or resumed leaves the rest of the client as it
            // was, so what the *arrs grab meanwhile neither piles up nor starts.
            const whole = id === undefined;
            const effects = paused
                ? [
                      `Stops ${state.scope} on ${adapter.id}. Nothing already downloaded is lost, and partial downloads resume where they left off.`,
                      // The thing a bare "paused" would let someone believe.
                      ...(whole ? ['Does NOT stop the *arrs searching and grabbing. They keep sending releases, which pile up in this client until it is resumed.'] : []),
                      `Undo it by calling this tool again with action: "resume"${whole ? '' : ` and the same \`id\``}.`
                  ]
                : [
                      `Restarts ${state.scope} on ${adapter.id}. ${state.heldBy === undefined ? 'Downloading resumes immediately and uses bandwidth.' : HOLD_TEXT[state.heldBy](adapter.id).effect}`,
                      ...(whole ? ['Anything the *arrs grabbed while it was paused starts downloading too.'] : [])
                  ];

            return {
                target,
                summary: `${paused ? 'Pause' : 'Resume'} ${state.scope} on ${adapter.id}.`,
                effects,
                args: { action, ...(id === undefined ? {} : { id }) }
            };
        },

        async apply(_plan, { service, instance, action, id, speed_limit_kbps }, adapter) {
            if (action === 'limit') {
                const kbps = speed_limit_kbps === undefined || speed_limit_kbps === 0 ? undefined : speed_limit_kbps;
                const client = findLimitAdapter(adapters, service, instance);
                await client.setSpeedLimit(kbps);
                return { limitKbps: kbps ?? null, service: client.id };
            }
            await adapter.setPaused(action === 'pause', id);
            return { [action === 'pause' ? 'paused' : 'resumed']: `${adapter.id}:${id ?? 'all'}` };
        }
    });
}
