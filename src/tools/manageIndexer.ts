import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import {
    hasIndexerWrites,
    reachOf,
    type IndexerLookups,
    type IndexerSeeding,
    type IndexerSettings,
    type IndexerSyncApp,
    type IndexerSyncView,
    type ServiceAdapter
} from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Adding, editing, disabling or deleting a Prowlarr indexer, and what that
 * does to the apps.
 *
 * Read against Prowlarr 2.6.5's ApplicationService and NewznabController:
 * a delete reaches every app at "Add and Remove Only" or "Full Sync" at
 * once; a disable or an edit only rewrites the copy in Full Sync apps, but
 * Prowlarr answers every search and grab through a disabled indexer with
 * 410, so the other copies stop working rather than disappear. The previews
 * say which.
 *
 * Nothing here takes or writes a credential. Add is limited to public
 * definitions with no password or captcha field, and edit goes through the
 * bulk endpoint, which never sees the indexer's settings.
 */

type Adapter = ReturnType<typeof findAdapter>;
type Action = 'disable' | 'enable' | 'delete' | 'edit' | 'add';

const findAdapter = (adapters: readonly ServiceAdapter[], instance?: string) => {
    const adapter = resolveInstance(adapters, 'prowlarr', instance);
    if (!hasIndexerWrites(adapter)) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot manage indexers`);
    }
    return adapter;
};

const SEED_LABELS: [keyof IndexerSeeding, string][] = [
    ['minimumSeeders', 'minimum seeders'],
    ['seedRatio', 'seed ratio'],
    ['seedTime', 'seed time (minutes)'],
    ['packSeedTime', 'pack seed time (minutes)']
];

type SettingsArgs = {
    priority?: number | undefined;
    app_profile?: string | undefined;
    tags?: string[] | undefined;
    minimum_seeders?: number | undefined;
    seed_ratio?: number | undefined;
    seed_time?: number | undefined;
    pack_seed_time?: number | undefined;
};

const seedingFrom = (args: SettingsArgs): IndexerSeeding => ({
    ...(args.minimum_seeders === undefined ? {} : { minimumSeeders: args.minimum_seeders }),
    ...(args.seed_ratio === undefined ? {} : { seedRatio: args.seed_ratio }),
    ...(args.seed_time === undefined ? {} : { seedTime: args.seed_time }),
    ...(args.pack_seed_time === undefined ? {} : { packSeedTime: args.pack_seed_time })
});

const hasSettings = (args: SettingsArgs) =>
    args.priority !== undefined ||
    args.app_profile !== undefined ||
    args.tags !== undefined ||
    Object.keys(seedingFrom(args)).length > 0;

/** Names to ids. Unknown names are refused: arr-mcp never creates a tag or profile. */
const resolveSettings = (adapter: Adapter, args: SettingsArgs, lookups: IndexerLookups): IndexerSettings => {
    const settings: IndexerSettings = { ...seedingFrom(args) };
    if (args.priority !== undefined) settings.priority = args.priority;

    if (args.app_profile !== undefined) {
        const wanted = args.app_profile.trim().toLowerCase();
        const profile = lookups.appProfiles.find(p => p.name.toLowerCase() === wanted || String(p.id) === wanted);
        if (profile === undefined) {
            throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no app profile "${args.app_profile}"`, {
                remedy: `Use one of: ${lookups.appProfiles.map(p => p.name).join(', ')}.`
            });
        }
        settings.appProfileId = profile.id;
    }

    if (args.tags !== undefined) {
        settings.tags = args.tags.map(label => {
            const tag = lookups.tags.find(t => t.label.toLowerCase() === label.trim().toLowerCase());
            if (tag === undefined) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no tag "${label}"`, {
                    remedy:
                        lookups.tags.length === 0
                            ? 'Prowlarr has no tags yet. Create the tag in Prowlarr first; arr-mcp does not create them.'
                            : `Use one of: ${lookups.tags.map(t => t.label).join(', ')}. arr-mcp does not create tags.`
                });
            }
            return tag.id;
        });
    }
    return settings;
};

const refuseSeedingOnUsenet = (adapter: Adapter, settings: IndexerSettings, protocol: string, name: string) => {
    if (protocol !== 'torrent' && SEED_LABELS.some(([key]) => settings[key] !== undefined)) {
        throw new ServiceError('NotFound', adapter.id, `${name} is a ${protocol} indexer and has no seed settings`, {
            remedy: 'Seed settings only apply to torrent indexers. Drop them and try again.'
        });
    }
};

const unreached = (app: IndexerSyncApp, name: string, reason: 'tags' | 'categories') =>
    reason === 'tags'
        ? `${app.name}: unaffected, its tags keep ${name} from syncing there.`
        : `${app.name}: unaffected, ${name} has none of the categories ${app.name} syncs.`;

type Reach = ReturnType<typeof reachOf>;

const toggleEffect = (
    action: 'disable' | 'enable' | 'delete',
    app: IndexerSyncApp,
    name: string,
    reach: Reach
): string => {
    if (action === 'delete') {
        return app.syncLevel === 'disabled'
            ? `${app.name}: sync is off, so any copy it has stays listed and fails every search. Remove it in ${app.name} by hand.`
            : `${app.name}: Prowlarr removes its copy straight away.`;
    }
    if (reach !== 'yes' && app.syncLevel !== 'disabled') return unreached(app, name, reach);
    if (action === 'enable') {
        return app.syncLevel === 'disabled'
            ? `${app.name}: sync is off, so it only works again if ${app.name} still has its copy.`
            : `${app.name}: searches and grabs through ${name} work again, and the sync re-adds the copy if it is gone.`;
    }
    return app.syncLevel === 'fullSync'
        ? `${app.name}: Prowlarr disables its copy too (Full Sync).`
        : `${app.name}: keeps its copy listed, but Prowlarr refuses every search and grab through it, so nothing more is grabbed from ${name}. ${app.name} will report the indexer as failing until it is enabled again or deleted.`;
};

const editEffect = (
    app: IndexerSyncApp,
    name: string,
    before: Reach,
    after: Reach,
    enabled: boolean,
    onlyTags: boolean
) => {
    if (app.syncLevel === 'disabled') return `${app.name}: sync is off, nothing changes there.`;
    if (before !== 'yes' && after !== 'yes') return unreached(app, name, after);
    if (before !== 'yes') {
        return enabled
            ? `${app.name}: gets the indexer on the sync, now that its tags match.`
            : `${app.name}: will get the indexer once it is enabled, now that its tags match.`;
    }
    if (after !== 'yes') {
        return app.syncLevel === 'fullSync'
            ? `${app.name}: Prowlarr removes its copy on the sync, since its tags no longer match.`
            : `${app.name}: keeps its copy. Add and Remove Only does not remove an indexer when tags change.`;
    }
    if (onlyTags) return `${app.name}: unchanged, it still gets this indexer.`;
    return app.syncLevel === 'fullSync'
        ? `${app.name}: gets the new settings (Full Sync).`
        : `${app.name}: keeps its copy's old settings. Add and Remove Only does not push edits; change them in ${app.name}, or delete and re-add.`;
};

const describeTags = (ids: number[], lookups: IndexerLookups) =>
    ids.length === 0 ? 'none' : ids.map(id => lookups.tags.find(t => t.id === id)?.label ?? `#${id}`).join(', ');

const describeProfile = (id: number, lookups: IndexerLookups) =>
    lookups.appProfiles.find(p => p.id === id)?.name ?? `#${id}`;

const readView = async (adapter: Adapter, id: number | undefined): Promise<IndexerSyncView> => {
    if (id === undefined) {
        throw new ServiceError('NotFound', adapter.id, 'this action needs `id`', {
            remedy: 'Take the id from get_indexers, where it shows as prowlarr:<id>.'
        });
    }
    const view = await adapter.readIndexerSync(id);
    if (view === undefined) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no indexer with id ${id}`, {
            remedy: 'Take the id from get_indexers, where it shows as prowlarr:<id>.'
        });
    }
    return view;
};

const needsBulk = (adapter: Adapter, view: IndexerSyncView, action: Action) => {
    if (view.bulkEdit) return;
    throw new ServiceError(
        'VersionUnsupported',
        adapter.id,
        `${adapter.id} is older than 1.8 and cannot ${action} an indexer through its API`,
        { remedy: `Upgrade Prowlarr, or ${action} ${view.indexer.name} in Prowlarr's UI. delete still works on this version.` }
    );
};

async function planEdit(adapter: Adapter, id: number | undefined, args: SettingsArgs): Promise<WritePlan> {
    const view = await readView(adapter, id);
    needsBulk(adapter, view, 'edit');
    if (!hasSettings(args)) {
        throw new ServiceError('NotFound', adapter.id, 'edit needs at least one setting to change', {
            remedy: 'Pass priority, app_profile, tags, minimum_seeders, seed_ratio, seed_time or pack_seed_time.'
        });
    }
    const { indexer, apps } = view;
    const lookups = await adapter.readIndexerLookups();
    const settings = resolveSettings(adapter, args, lookups);
    refuseSeedingOnUsenet(adapter, settings, indexer.protocol, indexer.name);

    const changes: string[] = [];
    const unsetWarnings: string[] = [];
    if (settings.priority !== undefined && settings.priority !== indexer.priority) {
        changes.push(`priority ${indexer.priority} → ${settings.priority}`);
    }
    if (settings.appProfileId !== undefined && settings.appProfileId !== indexer.appProfileId) {
        changes.push(
            `app profile ${describeProfile(indexer.appProfileId, lookups)} → ${describeProfile(settings.appProfileId, lookups)}`
        );
    }
    const tagsChange =
        settings.tags !== undefined &&
        [...settings.tags].sort().join(',') !== [...indexer.tags].sort().join(',');
    if (tagsChange && settings.tags !== undefined) {
        changes.push(`tags ${describeTags(indexer.tags, lookups)} → ${describeTags(settings.tags, lookups)}`);
    }
    for (const [key, label] of SEED_LABELS) {
        const next = settings[key];
        if (next === undefined || next === indexer.seeding[key]) continue;
        const current = indexer.seeding[key];
        changes.push(`${label} ${current ?? 'unset'} → ${next}`);
        if (current === undefined) unsetWarnings.push(label);
    }

    const target = `${adapter.id}:${id}`;
    if (changes.length === 0) {
        return { target, summary: `${indexer.name} already has those settings.`, effects: [], noop: true };
    }

    const newTags = settings.tags ?? indexer.tags;
    const onlyTags = changes.length === 1 && tagsChange;
    return {
        target,
        summary: `Edit ${indexer.name} in ${adapter.id}: ${changes.join('; ')}.`,
        effects: [
            ...apps.map(app =>
                editEffect(
                    app,
                    indexer.name,
                    reachOf(app, indexer.tags, indexer.categories),
                    reachOf(app, newTags, indexer.categories),
                    indexer.enabled,
                    onlyTags
                )
            ),
            ...(unsetWarnings.length === 0
                ? []
                : [
                      `${unsetWarnings.join(' and ')} ${unsetWarnings.length === 1 ? 'is' : 'are'} unset today, so the download client's default applies. arr-mcp cannot unset ${unsetWarnings.length === 1 ? 'it' : 'them'} again; only Prowlarr's UI can.`
                  ]),
            'Then queues Application Indexer Sync in Prowlarr.'
        ],
        args: { action: 'edit', settings }
    };
}

async function planAdd(adapter: Adapter, definition: string | undefined, args: SettingsArgs): Promise<WritePlan> {
    if (definition === undefined || definition.trim() === '') {
        throw new ServiceError('NotFound', adapter.id, 'add needs `definition`', {
            remedy: 'Name the indexer to add, for example "nyaasi" or "Nyaa.si".'
        });
    }
    const [{ definitions, configured }, lookups, apps] = await Promise.all([
        adapter.readIndexerDefinitions(),
        adapter.readIndexerLookups(),
        adapter.readIndexerApps()
    ]);

    const wanted = definition.trim().toLowerCase();
    const found = definitions.find(d => d.definitionName.toLowerCase() === wanted || d.name.toLowerCase() === wanted);
    if (found === undefined) {
        const close = definitions
            .filter(d => d.credentialFree)
            .filter(d => d.definitionName.toLowerCase().includes(wanted) || d.name.toLowerCase().includes(wanted))
            .slice(0, 8)
            .map(d => `${d.name} (${d.definitionName})`);
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no indexer definition "${definition}"`, {
            remedy:
                close.length === 0
                    ? 'Use the name Prowlarr shows in its Add Indexer list.'
                    : `Close matches arr-mcp can add: ${close.join(', ')}.`
        });
    }
    if (!found.credentialFree) {
        throw new ServiceError(
            'PermissionDenied',
            adapter.id,
            `${found.name} is ${found.privacy} and needs credentials, which arr-mcp never handles`,
            { remedy: `Add ${found.name} in Prowlarr's UI. arr-mcp can manage it from there.` }
        );
    }

    const target = `${adapter.id}:new:${found.definitionName}`;
    const existing = configured.find(c => c.definitionName === found.definitionName);
    if (existing !== undefined) {
        return {
            target,
            summary: `${found.name} is already configured as ${adapter.id}:${existing.id}.`,
            effects: [],
            noop: true
        };
    }

    const settings = resolveSettings(adapter, args, lookups);
    refuseSeedingOnUsenet(adapter, settings, found.protocol, found.name);
    const profileId = settings.appProfileId ?? Math.min(...lookups.appProfiles.map(p => p.id));
    const resolved: IndexerSettings = { ...settings, appProfileId: profileId };
    const tags = resolved.tags ?? [];

    const described = [
        `app profile ${describeProfile(profileId, lookups)}`,
        ...(resolved.priority === undefined ? [] : [`priority ${resolved.priority}`]),
        ...(tags.length === 0 ? [] : [`tags ${describeTags(tags, lookups)}`]),
        ...SEED_LABELS.flatMap(([key, label]) => (resolved[key] === undefined ? [] : [`${label} ${resolved[key]}`]))
    ];

    return {
        target,
        summary: `Add ${found.name} (public ${found.protocol}) to ${adapter.id}, enabled, ${described.join(', ')}.`,
        effects: [
            `Prowlarr tests it first by contacting the site. If that fails, nothing is added.`,
            ...apps.map(app => {
                if (app.syncLevel === 'disabled') return `${app.name}: sync is off, so it will not get ${found.name}.`;
                const reach = reachOf(app, tags, found.categories);
                return reach === 'yes'
                    ? `${app.name}: Prowlarr adds it straight away, and ${app.name} starts searching it.`
                    : unreached(app, found.name, reach);
            }),
            'Then queues Application Indexer Sync in Prowlarr. Undo with action "delete" on the new id.'
        ],
        args: { action: 'add', definition: found.definitionName, settings: resolved }
    };
}

export function registerManageIndexer(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'manage_indexer',
        title: 'Add, edit, disable or delete an indexer',
        description:
            'Adds, edits, disables, re-enables or deletes one Prowlarr indexer, then syncs Prowlarr to Radarr and Sonarr. `add` takes a `definition` name and only adds public indexers that need no login; anything private or semi-private is refused, because arr-mcp never handles indexer credentials. `edit` changes priority, app profile, tags and torrent seed settings, nothing else. `disable` stops every grab through that indexer in every app, whatever its sync level, and `enable` undoes it. All of those are safe tier. `delete` removes the indexer from Prowlarr and from each app Prowlarr syncs to, needs the destructive tier, and cannot be undone here. Every action but add takes `id` from get_indexers. The preview says what each app will see, since apps at Add and Remove Only do not receive edits. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            action: z
                .enum(['add', 'edit', 'disable', 'enable', 'delete'])
                .describe(
                    'add a new public indexer; edit its settings; disable stops grabs and is reversible; enable undoes a disable; delete removes it for good.'
                ),
            id: z.coerce
                .number()
                .int()
                .positive()
                .optional()
                .describe('The indexer id from get_indexers: 21 for a row shown as prowlarr:21. Every action but add needs it.'),
            definition: z
                .string()
                .optional()
                .describe('add only: the indexer to add, by its name in Prowlarr\'s Add Indexer list ("Nyaa.si") or its definition name ("nyaasi").'),
            priority: z.number().int().min(1).max(50).optional().describe('edit or add: 1 is searched first, 50 last. Prowlarr\'s default is 25.'),
            app_profile: z.string().optional().describe('edit or add: the Prowlarr app profile, by name.'),
            tags: z
                .array(z.string())
                .optional()
                .describe('edit or add: the full tag list, by label, replacing what is there. [] removes every tag. Tags decide which apps get the indexer.'),
            minimum_seeders: z.number().int().min(0).optional().describe('edit or add, torrent only.'),
            seed_ratio: z.number().min(0).optional().describe('edit or add, torrent only.'),
            seed_time: z.number().int().min(0).optional().describe('edit or add, torrent only: minutes.'),
            pack_seed_time: z.number().int().min(0).optional().describe('edit or add, torrent only: minutes, for season packs.')
        }),
        service: ({ instance }) => findAdapter(adapters, instance).id,
        operation: 'manage_indexer',
        tier: ({ action }) => (action === 'delete' ? 'destructive' : 'safe'),

        async plan(args): Promise<WritePlan> {
            const { instance, id, action, definition } = args;
            const adapter = findAdapter(adapters, instance);

            if (action === 'add') {
                if (id !== undefined) {
                    throw new ServiceError('NotFound', adapter.id, 'add takes `definition`, not `id`', {
                        remedy: 'An id names an indexer that already exists. To change one, use action "edit".'
                    });
                }
                return planAdd(adapter, definition, args);
            }
            if (action === 'edit') return planEdit(adapter, id, args);

            if (hasSettings(args)) {
                throw new ServiceError('NotFound', adapter.id, `${action} takes no settings`, {
                    remedy: 'Settings only apply to edit and add.'
                });
            }
            const view = await readView(adapter, id);
            const { indexer, apps } = view;
            if (action !== 'delete') needsBulk(adapter, view, action);
            const effects = apps.map(app =>
                toggleEffect(action, app, indexer.name, reachOf(app, indexer.tags, indexer.categories))
            );

            if (action === 'delete') {
                return {
                    target: `${adapter.id}:${indexer.id}`,
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
                target: `${adapter.id}:${indexer.id}`,
                summary: `${action === 'enable' ? 'Enable' : 'Disable'} ${indexer.name} in ${adapter.id}.`,
                effects: [...effects, 'Then queues Application Indexer Sync in Prowlarr.'],
                args: { action },
                noop: indexer.enabled === (action === 'enable')
            };
        },

        async apply(plan, { instance, id, action }) {
            const adapter = findAdapter(adapters, instance);
            const planned = plan.args as { definition?: string; settings?: IndexerSettings };

            if (action === 'add') {
                const added = await adapter.addIndexer(planned.definition ?? '', planned.settings ?? {});
                return { added: `${adapter.id}:${added}`, sync: await adapter.syncIndexers() };
            }
            // Every other action was refused in plan without an id.
            const target = id ?? 0;
            if (action === 'edit') await adapter.editIndexer(target, planned.settings ?? {});
            else if (action === 'delete') await adapter.deleteIndexer(target);
            else await adapter.setIndexerEnabled(target, action === 'enable');
            const done = { edit: 'edited', delete: 'deleted', disable: 'disabled', enable: 'enabled' }[action];
            return { [done]: `${adapter.id}:${target}`, sync: await adapter.syncIndexers() };
        }
    });
}
