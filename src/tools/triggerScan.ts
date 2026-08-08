import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasLibraryScan, type ServiceAdapter } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The other half of the answer `diagnose` gives most often.
 *
 * `diagnose` names a stale library scan as the usual reason something that
 * finished downloading is still not playable — and until 1.0 nothing here could
 * act on it, so its best answer ended "now go and start one yourself". The tool
 * that identifies a problem should be able to fix it.
 *
 * **Safe, not destructive.** A scan reads the filesystem and updates a
 * database; nothing is deleted, nothing is grabbed, and running one you did not
 * need costs time and disk I/O rather than data. `destructive` is reserved for
 * writes whose worst outcome is losing something.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);

    if (!hasLibraryScan(adapter)) {
        // Refused rather than accepted as a no-op: a queue client or an indexer
        // has no library to scan, and reporting success for an action that
        // could never happen is how a model concludes the scan is done.
        throw new ServiceError('NotFound', service, `${service} has no library to scan`, {
            remedy: 'Only radarr, sonarr and jellyfin manage a library. For "it downloaded but will not play", jellyfin is almost always the one you want.'
        });
    }

    return adapter;
};

export function registerTriggerScan(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'trigger_scan',
        description:
            'Asks Radarr, Sonarr or Jellyfin to rescan its library — the "it downloaded but still will not play" action, and the usual fix for what `diagnose` reports as a stale scan. Jellyfin is the one that matters when something is missing from what you can actually watch. This queues the scan and returns immediately; a large library can take minutes, so check `stack_health` afterwards rather than expecting it to be done. Previews by default — call again with the returned `confirm` token to actually run it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr, sonarr or jellyfin.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION)
        }),
        // Resolved from the arguments, so the permission checked, the audit row
        // written and the token issued all name the same instance.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'trigger_scan',
        tier: 'safe',

        async plan({ service, instance }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            return {
                target: adapter.id,
                summary: `Ask ${adapter.id} to rescan its library.`,
                effects: [
                    `Queues a library scan on ${adapter.id}.`,
                    'Finds media added or moved on disk since the last scan.',
                    'Can take minutes on a large library, and runs in the background.'
                ],
                args: { service, ...(instance === undefined ? {} : { instance }) }
            };
        },

        async apply(_plan, { service, instance }) {
            const adapter = findAdapter(adapters, service, instance);
            const handle = await adapter.startLibraryScan();

            return `${adapter.id} is rescanning its library. It runs in the background — check get_media_details or stack_health in a few minutes rather than expecting it to be finished now.${
                handle.commandId === 0 ? '' : ` Command id ${handle.commandId}.`
            }`;
        }
    });
}
