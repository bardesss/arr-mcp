import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { hasIndexerWrites, type IndexerSyncApp, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Disabling or deleting a Prowlarr indexer, and what that does to the apps.
 *
 * Read against Prowlarr 2.6.5's ApplicationService and NewznabController:
 * a delete reaches every app at "Add and Remove Only" or "Full Sync" at
 * once; a disable only rewrites the copy in Full Sync apps, but Prowlarr
 * answers every search and grab through a disabled indexer with 410, so the
 * other copies stop working rather than disappear. The previews say which.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], instance?: string) => {
    const adapter = resolveInstance(adapters, 'prowlarr', instance);
    if (!hasIndexerWrites(adapter)) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot manage indexers`);
    }
    return adapter;
};

const notReached = (app: IndexerSyncApp) => !app.receives && app.syncLevel !== 'disabled';

const effectOn = (action: 'disable' | 'enable' | 'delete', app: IndexerSyncApp, name: string): string => {
    if (action === 'delete') {
        return app.syncLevel === 'disabled'
            ? `${app.name}: sync is off, so any copy it has stays listed and fails every search. Remove it in ${app.name} by hand.`
            : `${app.name}: Prowlarr removes its copy straight away.`;
    }
    if (notReached(app)) return `${app.name}: unaffected, its tags keep ${name} from syncing there.`;
    if (action === 'enable') {
        return app.syncLevel === 'disabled'
            ? `${app.name}: sync is off, so it only works again if ${app.name} still has its copy.`
            : `${app.name}: searches and grabs through ${name} work again, and the sync re-adds the copy if it is gone.`;
    }
    return app.syncLevel === 'fullSync'
        ? `${app.name}: Prowlarr disables its copy too (Full Sync).`
        : `${app.name}: keeps its copy listed, but Prowlarr refuses every search and grab through it, so nothing more is grabbed from ${name}. ${app.name} will report the indexer as failing until it is enabled again or deleted.`;
};

export function registerManageIndexer(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'manage_indexer',
        title: 'Disable or delete an indexer',
        description:
            'Disables, re-enables or deletes one Prowlarr indexer, then syncs Prowlarr to Radarr and Sonarr. `disable` stops every grab through that indexer in every app, whatever its sync level, and `enable` undoes it; both need only the safe tier. `delete` removes the indexer from Prowlarr and from each app Prowlarr syncs to, needs the destructive tier, and cannot be undone here: getting it back means adding it again in Prowlarr, credentials included. Take `id` from get_indexers. The preview says what each app will see. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.coerce
                .number()
                .int()
                .positive()
                .describe('The indexer id from get_indexers: 21 for a row shown as prowlarr:21.'),
            action: z
                .enum(['disable', 'enable', 'delete'])
                .describe('disable stops grabs and is reversible; enable undoes a disable; delete removes it for good.')
        }),
        service: ({ instance }) => findAdapter(adapters, instance).id,
        operation: 'manage_indexer',
        tier: ({ action }) => (action === 'delete' ? 'destructive' : 'safe'),

        async plan({ instance, id, action }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, instance);
            const view = await adapter.readIndexerSync(id);
            if (view === undefined) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no indexer with id ${id}`, {
                    remedy: 'Take the id from get_indexers, where it shows as prowlarr:<id>.'
                });
            }
            const { indexer, apps } = view;
            if (action !== 'delete' && !view.canToggle) {
                throw new ServiceError(
                    'VersionUnsupported',
                    adapter.id,
                    `${adapter.id} is older than 1.8 and cannot ${action} an indexer through its API`,
                    {
                        remedy: `Upgrade Prowlarr, or ${action} ${indexer.name} in Prowlarr's UI. delete still works on this version.`
                    }
                );
            }
            const effects = apps.map(app => effectOn(action, app, indexer.name));

            if (action === 'delete') {
                return {
                    target: `${adapter.id}:${id}`,
                    summary: `Delete ${indexer.name} from ${adapter.id}.`,
                    effects: [
                        `Deletes ${indexer.name} and its settings from Prowlarr. Re-adding it means configuring it again from scratch.`,
                        ...effects,
                        'Then queues Application Indexer Sync, which also clears a copy an unreachable app missed.'
                    ],
                    args: { action }
                };
            }

            return {
                target: `${adapter.id}:${id}`,
                summary: `${action === 'enable' ? 'Enable' : 'Disable'} ${indexer.name} in ${adapter.id}.`,
                effects: [...effects, 'Then queues Application Indexer Sync in Prowlarr.'],
                args: { action },
                noop: indexer.enabled === (action === 'enable')
            };
        },

        async apply(_plan, { instance, id, action }) {
            const adapter = findAdapter(adapters, instance);
            if (action === 'delete') await adapter.deleteIndexer(id);
            else await adapter.setIndexerEnabled(id, action === 'enable');
            return { [`${action}d`]: `${adapter.id}:${id}`, sync: await adapter.syncIndexers() };
        }
    });
}
