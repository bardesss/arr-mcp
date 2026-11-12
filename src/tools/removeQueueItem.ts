import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { PENDING_STATUSES } from '../services/arrRecord.ts';
import { hasQueue, hasQueueRemove, type QueueItem, type QueueRemoveCapable, type ServiceAdapter } from '../services/types.ts';
import { applyOrphaned, canClearOrphans, planOrphaned } from './cleanQueue.ts';
import { outcomeText, registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';

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

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'lidarr', 'sabnzbd', 'nzbget', 'transmission', 'qbittorrent', 'shelfmark', 'grimmory'],
    can: hasQueueRemove,
    cannot: 'has no download queue',
    hint: 'Take a service and id from get_queue.'
});

const RemoveQueueItemInput = z.object({
    ...targetInput(TARGET),
    id: z.string().min(1).optional().describe('The queue item id, exactly as get_queue reported it.'),
    orphaned: z
        .boolean()
        .optional()
        .describe(
            'Instead of `id`. Refuses `blocklist: true` and `remove_from_client: false`.'
        ),
    remove_from_client: z
        .boolean()
        .optional()
        .describe(
            'Also drop it from the download client and delete partial data. Defaults to true, which is what "get rid of it" normally means.'
        ),
    blocklist: z
        .boolean()
        .default(false)
        .describe(
            'Blocklist the release so it is not grabbed again. *arr rows only; ignored elsewhere. Defaults to false.'
        )
});

type RemoveBound = { service: string; id: string; removeFromClient: boolean; blocklist: boolean } | { ids: string[] };

/**
 * Why `blocklist: true` blocklists one row and not another, read in Radarr
 * 6.4.4, Sonarr 4.0.20, Whisparr 2.2.0 and Lidarr 3.1.6.
 *
 * A row the service is only holding back (`delay`, `downloadClientUnavailable`,
 * `fallback`) is a pending release: the queue's DELETE drops it, ignoring
 * `removeFromClient`, and blocklists it directly (`BlocklistService.Block`),
 * with no download behind it and no search after. It always has its media.
 *
 * Any other row goes through `FailedDownloadService.MarkAsFailed`, which acts
 * only through the service's `grabbed` history for the download id. Its
 * `DownloadFailedEvent` is what `BlocklistService` blocklists from, and what
 * `RedownloadFailedDownloadService` searches again from when Redownload Failed
 * is on (`autoRedownloadFailed`, the default; for a grab from an interactive
 * search, Redownload Failed from Interactive Search too). It also has the *arr
 * delete the download from the client when that client's Remove Failed setting
 * is on (`DownloadEventHub`, the default). A download the service did not grab
 * has no such history. `HistoryService` (`EntityHistoryService` on Lidarr)
 * deletes it with the film, series or artist, and housekeeping drops it when an
 * episode or album is gone though its series or artist is not. Without it
 * nothing is blocklisted, and from Sonarr 5.0.0.2569 the DELETE fails instead,
 * after removing the download if `removeFromClient` asked for that. So the
 * preview reads that history (`grabRecorded`, one request) and, without it,
 * sends `blocklist=false`. An orphaned row is read too: one whose grab the
 * service could not map back to its media still has the record.
 */
const isPending = (item: QueueItem): boolean => PENDING_STATUSES.has(item.status.toLowerCase());

/** Whether `blocklist=true` would blocklist this row, rather than do nothing (or fail, from Sonarr 5.0.0.2569). */
async function blocklists(adapter: ServiceAdapter & QueueRemoveCapable, item: QueueItem): Promise<boolean> {
    if (!adapter.supportsBlocklist) return false;
    if (isPending(item)) return true;
    if (item.downloadId === undefined || item.downloadId.trim() === '' || adapter.grabRecorded === undefined) return false;
    return adapter.grabRecorded(item.downloadId);
}

const blocklistEffect = (adapter: ServiceAdapter & QueueRemoveCapable, item: QueueItem, removeFromClient: boolean, blocklisted: boolean): string => {
    if (!adapter.supportsBlocklist) {
        return `Ignored: ${adapter.id} has no blocklist of its own. To blocklist a release, remove it from the Radarr, Sonarr, Whisparr or Lidarr queue instead.`;
    }
    if (!blocklisted) return `Not blocklisted: ${adapter.id} lists no grab of this download.`;
    const blocks = 'Blocklists this release (remove_blocklist_item undoes it)';
    if (isPending(item)) return `${blocks}.`;
    return `${blocks}; ${adapter.id} may ${removeFromClient ? 'also' : 'still delete it from the client, and'} search for a replacement.`;
};

/** What happens to the row and the download itself, before any blocklist. */
const removalEffect = (adapter: ServiceAdapter & QueueRemoveCapable, item: QueueItem, removeFromClient: boolean): string => {
    if (adapter.discardsFile === true) return `Discards ${item.title} from Grimmory's Bookdrop, which deletes the file from disk. It is not imported, and this cannot be undone.`;
    if (adapter.cancelOnly === true) return `Cancels it in ${adapter.id}, stopping it if it has started. get_history then shows it as stopped, and retry_download can usually start it again.`;
    if (isPending(item)) return `Drops this pending release from ${adapter.id}; nothing has gone to a download client yet.`;
    if (removeFromClient) return `Removes it from ${adapter.id} and deletes any partial data already downloaded.`;
    return `Removes it from ${adapter.id}'s queue but leaves the download itself alone.`;
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
            'Removes one item from a download queue: the stuck-at-0%, wrong-release, or stalled download. Take `service` and `id` from get_queue. Optionally deletes partial data and, on an *arr, blocklists the release so it will not be grabbed again. [[nzbget: On NZBGet, keeping the data parks the download in its history rather than deleting it.]] [[shelfmark: On Shelfmark it cancels a queued or running book, and a failed one has nothing to cancel.]] [[grimmory: On Grimmory it discards a file waiting in the Bookdrop, which deletes the file from disk (so `remove_from_client: false` is refused).]] [[radarr|sonarr|whisparr|lidarr: `orphaned: true` in place of `id` removes every finished download stuck at importBlocked because its film, series or artist is gone, from one *arr instance and its client.]] Previews first; confirm to remove it.',
        inputSchema: RemoveQueueItemInput,
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write — or worse, the reverse.
        target: { adapters, to: TARGET },
        operation: 'remove_queue_item',
        tier: 'destructive',

        async plan({ id, orphaned, remove_from_client: requested, blocklist }, adapter): Promise<WritePlan<RemoveBound>> {
            const remove_from_client = requested ?? true;
            if (orphaned === true) {
                if (id !== undefined) {
                    throw new ServiceError('NotFound', adapter.id, 'pass `id` or `orphaned: true`, not both', {
                        remedy: 'Leave out `id` to remove every orphaned download, or leave out `orphaned` to remove that one item.'
                    });
                }
                if (requested === false) {
                    throw new ServiceError('NotFound', adapter.id, '`orphaned` always removes the download from the client, so it cannot leave it alone', {
                        remedy: 'Leave out `remove_from_client`. To keep a download, remove one row by `id` instead.'
                    });
                }
                if (blocklist) {
                    throw new ServiceError('NotFound', adapter.id, '`orphaned` never blocklists: the release was fine, the media was deleted', {
                        remedy: 'Leave out `blocklist`. To blocklist one release, pass its `id` instead.'
                    });
                }
                if (!canClearOrphans(adapter)) {
                    throw new ServiceError('NotFound', adapter.id, `${adapter.id} reports no orphaned items`, {
                        remedy: 'orphaned works with Radarr, Sonarr, Whisparr and Lidarr only.'
                    });
                }
                return planOrphaned(adapter);
            }
            if (id === undefined) {
                throw new ServiceError('NotFound', adapter.id, 'pass `id`, or `orphaned: true` for every orphaned download', {
                    remedy: 'Take an id from get_queue.'
                });
            }

            // Read the live queue so the preview names the release rather than
            // an opaque id, and so an id that has already finished downloading
            // fails here instead of as a confusing 404 from a delete.
            if (!hasQueue(adapter)) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot list its own queue`);
            }
            const item = (await adapter.getQueue()).find(q => q.id === id);
            if (item === undefined) {
                throw new ServiceError('NotFound', adapter.id, `nothing in ${adapter.id}'s queue has id "${id}"`, {
                    remedy:
                        'It may have finished or already been removed. Call get_queue for a current list — queue ids are not stable once an item leaves the queue.'
                });
            }

            if (adapter.cancelOnly === true && !remove_from_client) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} can only cancel a download outright, so it cannot leave the download alone`, {
                    remedy: 'Leave out `remove_from_client` to cancel it.'
                });
            }
            if (adapter.cancelOnly === true && item.status === 'error') {
                throw new ServiceError('NotFound', adapter.id, 'that download has already failed, so there is nothing to cancel', {
                    remedy: 'retry_download tries it again. To clear the row, dismiss it in Shelfmark.'
                });
            }

            if (adapter.discardsFile === true && !remove_from_client) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} deletes the file when it discards one, so it cannot leave the file alone`, {
                    remedy: 'Leave out remove_from_client: discarding always deletes the file.'
                });
            }

            const blocklisted = blocklist && (await blocklists(adapter, item));

            // Kept without a blocklist, a download is ignored, which the *arr does
            // only with a film, series or artist (on Lidarr, also its albums) to
            // record it against (`IgnoredDownloadService`). Without one it stops
            // tracking the download, which is back at the next refresh. A blocklisted
            // one is failed instead, which `DownloadIsTrackable` never tracks again.
            if ((item.orphaned === true || item.noAlbum === true) && !remove_from_client && !blocklisted) {
                const why = `${adapter.id} matched ${item.orphaned === true ? 'nothing in its library' : 'no album'} to this download`;
                throw new ServiceError('NotFound', adapter.id, `${why}, so it cannot leave the download alone and drop the row`, {
                    remedy: 'Nothing was changed: a torrent keeps seeding, and the row stays. To delete the download too, leave out remove_from_client.'
                });
            }

            const effects = [removalEffect(adapter, item, remove_from_client)];

            // Accepting a flag that silently does nothing is how someone
            // believes a release is blocklisted for a year. Say it plainly.
            if (blocklist) effects.push(blocklistEffect(adapter, item, remove_from_client, blocklisted));

            return {
                target: `${adapter.id}:${id}`,
                summary: `Remove ${item.title} from ${adapter.id}'s queue (currently ${item.status}).`,
                effects,
                args: {
                    service: adapter.id,
                    id,
                    removeFromClient: remove_from_client,
                    // The *effective* value, not the requested one, so the
                    // token and the audit row record what will actually happen
                    // rather than what was asked for on a service, or a row,
                    // that cannot do it. `apply` sends this one.
                    blocklist: blocklisted
                }
            };
        },

        applied: outcomeText,

        // What the plan resolved and the token is bound to, not the raw flags.
        async apply(plan, _args, adapter) {
            if (plan.args === undefined) throw new Error('remove_queue_item: the plan bound no flags to send');
            if ('ids' in plan.args) {
                if (!canClearOrphans(adapter)) throw new Error('remove_queue_item: the plan bound orphans for an adapter that cannot clear them');
                return applyOrphaned({ ...plan, args: plan.args }, adapter);
            }
            const { id, removeFromClient, blocklist } = plan.args;
            await adapter.removeQueueItem(id, { removeFromClient, blocklist });
            return { removed: `${adapter.id}:${id}` };
        }
    });
}
