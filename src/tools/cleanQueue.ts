import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { hasQueue, hasQueueRemove, type QueueItem, type ServiceAdapter, type QueueRemoveCapable, type QueueCapable } from '../services/types.ts';
import { outcomeText, registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    can: (a): a is ServiceAdapter & QueueRemoveCapable & QueueCapable => hasQueueRemove(a) && hasQueue(a),
    cannot: 'has no download queue',
    hint: 'They report the orphaned items this cleans up.'
});

// Narrow and not caller-configurable: `orphaned` alone matches unlinked items
// that are still transferring, and deleting one destroys a download in progress.
const isLitter = (item: QueueItem): boolean => item.orphaned === true && item.importState === 'importBlocked';

const CleanQueueInput = z.object({
    ...targetInput(TARGET)
});

export function registerCleanQueue(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'clean_queue',
        title: 'Clean up orphaned queue items',
        description:
            'Removes every completed download stuck in a Radarr, Sonarr, Whisparr or Lidarr queue because the film, series or artist it belongs to no longer exists — the ones that pile up at "importBlocked" for years. Also drops them from the download client. Only touches items that are both orphaned and import-blocked, so a download still in progress is never affected, and it never blocklists: the release was fine, the media was deleted. On Lidarr before 2.10.1 nothing is ever marked `importBlocked` — a deleted artist\'s finished download stays `completed` with a warning — so this finds nothing there; remove such a row with remove_queue_item. Previews first; confirm to remove them.',
        inputSchema: CleanQueueInput,
        target: { adapters, to: TARGET },
        operation: 'clean_queue',
        tier: 'destructive',

        async plan(_args, adapter): Promise<WritePlan<{ ids: string[] }>> {
            const litter = (await adapter.getQueue()).filter(isLitter);
            const target = `${adapter.id}:orphaned`;

            if (litter.length === 0) {
                return {
                    target,
                    // Read as "all clean" on an older Lidarr, it would hide the
                    // stuck downloads that release never marks importBlocked.
                    summary:
                        `${adapter.id} has no orphaned queue items stuck at importBlocked.` +
                        (adapter.type === 'lidarr'
                            ? ' Lidarr before 2.10.1 never marks one importBlocked: there, a deleted artist\'s finished download stays `completed` with a warning in get_queue, and remove_queue_item removes it.'
                            : ''),
                    effects: [],
                    noop: true
                };
            }

            return {
                target,
                summary: `Remove ${litter.length} orphaned item(s) from ${adapter.id}'s queue, and from the download client.`,
                effects: [
                    ...litter.map(i => `${i.title} — ${i.status}/${i.importState ?? 'unknown'}, no media behind it.`),
                    'Deletes the downloaded data too. Nothing is blocklisted, so any of these can be grabbed again.'
                ],
                // Bound to the ids, so a token cannot apply to a queue that has
                // changed since the preview.
                args: { ids: litter.map(i => i.id).sort() }
            };
        },

        applied: outcomeText,

        async apply(plan, _args, adapter) {
            const ids = plan.args?.ids ?? [];

            // Caught per item. Throwing on the first failure audited the whole
            // write as failed and told the caller nothing about the ones that
            // *had* been removed — so a retry re-planned against a queue that
            // had already changed underneath it.
            //
            // Deliberately still serial: removal is two calls per item on some
            // clients, and qBittorrent bans a client that bursts at it.
            const removed: string[] = [];
            const failed: string[] = [];
            for (const id of ids) {
                try {
                    await adapter.removeQueueItem(id, { removeFromClient: true, blocklist: false });
                    removed.push(id);
                } catch (err) {
                    logger.warn({ service: adapter.id, id, err }, 'queue item removal failed; continuing');
                    failed.push(`${id} (${(err as Error).message})`);
                }
            }

            if (removed.length === 0 && failed.length > 0) {
                throw new ServiceError(
                    'UpstreamError',
                    adapter.id,
                    `none of the ${failed.length} orphaned item(s) could be removed: ${failed.join('; ')}`
                );
            }

            if (failed.length > 0) {
                return (
                    `Removed ${removed.length} of ${ids.length} orphaned item(s) from ${adapter.id}'s queue. ` +
                    `${failed.length} could not be removed: ${failed.join('; ')}. ` +
                    `Run the preview again — the queue has changed.`
                );
            }

            return `Removed ${removed.length} orphaned item(s) from ${adapter.id}'s queue.`;
        }
    });
}
