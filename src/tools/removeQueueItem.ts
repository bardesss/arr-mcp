import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasQueue, hasQueueRemove, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * "This has been stuck at 0% for two days, get rid of it" — the other thing
 * people actually want to write.
 *
 * Destructive tier rather than safe, even though a removed download can be
 * searched for again: `remove_from_client` deletes partial data, and
 * `blocklist` durably teaches the *arr to refuse a release, which is
 * genuinely hard to notice and hard to undo months later when the same film
 * mysteriously never grabs.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasQueueRemove(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no download queue`, {
            remedy: 'Queue items live on radarr, sonarr, sabnzbd, transmission and qbittorrent. Take a service and id from get_queue.'
        });
    }
    return adapter;
};

export function registerRemoveQueueItem(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'remove_queue_item',
        title: 'Remove a queue item',
        description:
            'Removes one item from a download queue — the stuck-at-0%, wrong-release, or stalled download. Works against Radarr, Sonarr, SABnzbd, Transmission and qBittorrent; take `service` and `id` from get_queue. Optionally deletes partial data and, on Radarr and Sonarr only, blocklists the release so it will not be grabbed again. Previews by default — call again with the returned `confirm` token to actually remove it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr, sonarr, sabnzbd, transmission or qbittorrent.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.string().min(1).describe('The queue item id, exactly as get_queue reported it.'),
            remove_from_client: z
                .boolean()
                .default(true)
                .describe(
                    'Also drop it from the download client and delete partial data. Defaults to true, which is what "get rid of it" normally means.'
                ),
            blocklist: z
                .boolean()
                .default(false)
                .describe(
                    'Blocklist the release so it is not grabbed again. Radarr and Sonarr only; ignored elsewhere. Defaults to false.'
                )
        }),
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write — or worse, the reverse.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'remove_queue_item',
        tier: 'destructive',

        async plan({ service, instance, id, remove_from_client, blocklist }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            // Read the live queue so the preview names the release rather than
            // an opaque id, and so an id that has already finished downloading
            // fails here instead of as a confusing 404 from a delete.
            if (!hasQueue(adapter)) {
                throw new ServiceError('NotFound', service, `${service} cannot list its own queue`);
            }
            const item = (await adapter.getQueue()).find(q => q.id === id);
            if (item === undefined) {
                throw new ServiceError('NotFound', service, `nothing in ${service}'s queue has id "${id}"`, {
                    remedy:
                        'It may have finished or already been removed. Call get_queue for a current list — queue ids are not stable once an item leaves the queue.'
                });
            }

            const effects = [
                remove_from_client
                    ? `Removes it from ${service} and deletes any partial data already downloaded.`
                    : `Removes it from ${service}'s queue but leaves the download itself alone.`
            ];

            // Accepting a flag that silently does nothing is how someone
            // believes a release is blocklisted for a year. Say it plainly.
            if (blocklist) {
                effects.push(
                    adapter.supportsBlocklist
                        ? 'Blocklists this release, so it will not be grabbed again. Undoing this means finding it in the service\'s blocklist by hand.'
                        : `Ignored: ${service} has no blocklist of its own. To blocklist a release, remove it from the Radarr or Sonarr queue instead.`
                );
            }

            return {
                target: `${service}:${id}`,
                summary: `Remove ${item.title} from ${service}'s queue (currently ${item.status}).`,
                effects,
                args: {
                    service,
                    id,
                    removeFromClient: remove_from_client,
                    // The *effective* value, not the requested one, so the
                    // token and the audit row record what will actually happen
                    // rather than what was asked for on a service that cannot
                    // do it.
                    blocklist: blocklist && adapter.supportsBlocklist
                }
            };
        },

        async apply(_plan, { service, instance, id, remove_from_client, blocklist }) {
            const adapter = findAdapter(adapters, service, instance);
            await adapter.removeQueueItem(id, {
                removeFromClient: remove_from_client,
                blocklist: blocklist && adapter.supportsBlocklist
            });
            return { removed: `${service}:${id}` };
        }
    });
}
