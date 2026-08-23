import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasPause, type ServiceAdapter } from '../services/types.ts';
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

export function registerPauseDownloads(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'pause_downloads',
        title: 'Pause or resume a download client',
        description:
            'Pauses or resumes one download client — SABnzbd, Transmission or qBittorrent — or one item in its queue when `id` is given. The bandwidth answer: "stop downloading for an hour". Safe tier, because the undo is this same tool with the other action. It does NOT stop Radarr or Sonarr grabbing: they carry on finding and sending releases, which then sit in the paused client. `service` is required and names one client; pausing "everything" means one call each. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('sabnzbd, transmission or qbittorrent.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            action: z.enum(['pause', 'resume']).describe('pause or resume.'),
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

        async plan({ service, instance, action, id }): Promise<WritePlan> {
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

        async apply(_plan, { service, instance, action, id }) {
            await findAdapter(adapters, service, instance).setPaused(action === 'pause', id);
            return { [action === 'pause' ? 'paused' : 'resumed']: `${service}:${id ?? 'all'}` };
        }
    });
}
