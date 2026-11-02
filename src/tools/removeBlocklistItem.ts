import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasBlocklist, hasQueueRemove, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Un-blocklisting one release, so it can be grabbed again.
 *
 * `safe` tier: nothing is destroyed — the entry is a refusal, and removing it
 * withdraws the refusal. On Radarr and Sonarr the counterpart is already
 * there: `remove_queue_item`'s `blocklist: true` puts a release back on the
 * list. The preview offers that only where `remove_queue_item` can do it.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasBlocklist(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no blocklist`, {
            remedy: 'Only radarr, sonarr, whisparr and lidarr keep a blocklist. Take `service` and `id` from get_blocklist.'
        });
    }
    return adapter;
};

export function registerRemoveBlocklistItem(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'remove_blocklist_item',
        title: 'Un-blocklist a release',
        description:
            'Removes one entry from Radarr, Sonarr, Whisparr or Lidarr\'s blocklist, so that release can be grabbed again. The fix for "this never downloads and I do not know why" once get_blocklist has said why. Take `service` and `id` from a get_blocklist row. Safe tier: the entry is a refusal to grab, and removing it only withdraws that refusal — nothing on disk changes, and on Radarr and Sonarr the release can be blocklisted again through remove_queue_item\'s `blocklist` flag. Previews by default — call again with the returned `confirm` token to remove it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr, sonarr or lidarr.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.string().min(1).describe('The blocklist entry id, exactly as get_blocklist reported it.')
        }),
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'remove_blocklist_item',
        tier: 'safe',

        async plan({ service, instance, id }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            // Not optional. Probed live against both services: DELETE of a
            // blocklist id that does not exist answers success, so without
            // this a stale id would be reported as removed when nothing
            // happened — the same trap remove_queue_item documents.
            const entry = (await adapter.readBlocklist()).find(b => b.id === id);
            if (entry === undefined) {
                throw new ServiceError('NotFound', service, `nothing in ${service}'s blocklist has id "${id}"`, {
                    remedy: 'It may already have been removed. Call get_blocklist for a current list — the ids are not stable once an entry is gone.'
                });
            }

            return {
                target: `${adapter.id}:${id}`,
                summary: `Un-blocklist ${entry.title} on ${service}.`,
                effects: [
                    `${service} may grab this release again the next time it searches.`,
                    `It was blocklisted ${entry.at || 'at an unrecorded time'}${entry.reason === undefined ? '' : `: ${entry.reason}`}`,
                    hasQueueRemove(adapter) && adapter.supportsBlocklist
                        ? 'Nothing on disk changes. To blocklist it again, remove it from the queue with remove_queue_item and `blocklist: true`.'
                        : 'Nothing on disk changes.'
                ],
                args: { id }
            };
        },

        async apply(_plan, { service, instance, id }) {
            const adapter = findAdapter(adapters, service, instance);
            await adapter.removeBlocklistItem(id);
            return { removed: `${adapter.id}:${id}` };
        }
    });
}
