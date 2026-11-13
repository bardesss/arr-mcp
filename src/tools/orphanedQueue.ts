import type { NextStep } from '../core/nextStep.ts';
import { hasQueue, hasQueueRemove, type QueueItem, type ServiceAdapter, type QueueRemoveCapable, type QueueCapable } from '../services/types.ts';
import { orphanImportStepFor } from './importStep.ts';
import { instanceArgs } from './resolveInstance.ts';
import type { WritePlan } from './write.ts';

/** The adapters that report orphaned queue items. */
type OrphanCapable = ServiceAdapter & QueueRemoveCapable & QueueCapable;
const ORPHAN_SERVICES = ['radarr', 'sonarr', 'whisparr', 'lidarr'] as const;
/** One guard for the plan: the service type and the capability. */
export const canListOrphans = (a: ServiceAdapter): a is OrphanCapable =>
    (ORPHAN_SERVICES as readonly string[]).includes(a.type) && hasQueueRemove(a) && hasQueue(a);

// `orphaned` alone matches unlinked items that are still transferring.
const isStuck = (item: QueueItem): boolean => item.orphaned === true && item.importState === 'importBlocked';

/**
 * `remove_queue_item` with `orphaned: true`: every orphaned (matched to no
 * library item), import-blocked item in one instance's queue, listed with its
 * next steps and never removed. The *arrs delete a film's or series' history
 * with it (checked live on Radarr 6.4.4 and Sonarr 4.0.20), so nothing tells a
 * download whose media was deleted from one they never matched (a title
 * mismatch, one added by hand), and removing the second deletes data an import
 * could still use. The caller removes each row by id once it has read them.
 * Generic over the bound args: a listing binds none.
 */
export async function planOrphaned<B extends Record<string, unknown>>(adapter: OrphanCapable): Promise<WritePlan<B>> {
    const stuck = (await adapter.getQueue()).filter(isStuck);
    const target = `${adapter.id}:orphaned`;

    if (stuck.length === 0) {
        return {
            target,
            // Read as "all clean" on an older Lidarr, it would hide the
            // stuck downloads that release never marks importBlocked.
            summary:
                `${adapter.id} has no orphaned queue items stuck at importBlocked.` +
                (adapter.type === 'lidarr'
                    ? ' Lidarr before 2.10.1 never marks one importBlocked: there, a finished download matched to nothing in the library (deleted, or never matched) stays `completed` with a warning in get_queue, and remove_queue_item with its `id` removes it.'
                    : ''),
            effects: [],
            noop: true
        };
    }

    const next: NextStep[] = stuck.flatMap(i => {
        const imported = orphanImportStepFor(i);
        const remove: NextStep = {
            tool: 'remove_queue_item',
            arguments: { ...instanceArgs(i.service), id: i.id },
            why: `Removes it from ${i.service}'s queue and the download client, deleting its data.`
        };
        return imported === undefined ? [remove] : [imported, remove];
    });
    const rescue =
        adapter.type === 'radarr' || adapter.type === 'sonarr'
        ? 'Import one with import_download and a `mapping`, or remove it by `id`.'
        : `Import one by hand in ${adapter.id}, or remove it by \`id\`.`;
    return {
        target,
        summary: `${adapter.id} has ${stuck.length} orphaned item(s) stuck at importBlocked, matched to nothing in the library: deleted, or never matched. Nothing is removed. ${rescue}`,
        effects: stuck.map(i => `${i.title} (id ${i.id}): ${i.status}/${i.importState ?? 'unknown'}.`),
        noop: true,
        next
    };
}
