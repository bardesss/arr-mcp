import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { CONFIRM_REASON, ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { ProwlarrAdapter } from '../src/services/prowlarr.ts';
import { registerDeleteIndexer, registerManageIndexer } from '../src/tools/manageIndexer.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (destructive: boolean): KeyedServiceConfig => ({
    url: 'http://192.0.2.10:9696',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive }
});

const seedFields = (ratio: number | null) => [
    { name: 'baseUrl', type: 'select', privacy: 'normal', value: 'https://example.invalid/' },
    { name: 'torrentBaseSettings.appMinimumSeeders', type: 'number', privacy: 'normal', value: 1 },
    { name: 'torrentBaseSettings.seedRatio', type: 'number', privacy: 'normal', value: ratio },
    { name: 'torrentBaseSettings.seedTime', type: 'number', privacy: 'normal', value: null }
];

const INDEXERS = [
    {
        id: 21,
        name: 'Nyaa.si',
        definitionName: 'nyaasi',
        enable: true,
        protocol: 'torrent',
        priority: 25,
        appProfileId: 1,
        tags: [],
        fields: seedFields(null)
    },
    {
        id: 8,
        name: 'altHUB',
        definitionName: 'Newznab',
        enable: false,
        protocol: 'usenet',
        priority: 25,
        appProfileId: 1,
        tags: [3],
        fields: [{ name: 'apiKey', type: 'textbox', privacy: 'apiKey', value: '********' }]
    }
];

const template = (definitionName: string, name: string, protocol: string, fields: unknown[]) => ({
    id: 0,
    definitionName,
    name,
    privacy: 'public',
    protocol,
    priority: 25,
    appProfileId: 0,
    tags: [],
    fields
});

const SCHEMA = [
    template('nyaasi', 'Nyaa.si', 'torrent', seedFields(null)),
    template('eztv', 'EZTV', 'torrent', seedFields(null)),
    {
        ...template('yts', 'YTS', 'torrent', seedFields(null)),
        capabilities: { categories: [{ id: 2000, subCategories: [{ id: 2040 }, { id: 2045 }] }] }
    },
    {
        ...template('animetosho', 'Anime Tosho', 'torrent', seedFields(null)),
        capabilities: { categories: [{ id: 5070, subCategories: [] }] }
    },
    template('nzbindex', 'NZBIndex', 'usenet', []),
    template('cookietracker', 'Cookie Tracker', 'torrent', [
        { name: 'cookie', type: 'password', privacy: 'normal', value: '' }
    ]),
    {
        ...template('privatehd', 'Private HD', 'torrent', [
            { name: 'username', type: 'textbox', privacy: 'userName', value: '' }
        ]),
        privacy: 'private'
    }
];

const PROFILES = [
    { id: 1, name: 'Everything' },
    { id: 2, name: 'Interactive only' }
];
const TAGS = [
    { id: 3, label: '4k' },
    { id: 4, label: 'anime' }
];

const APPS = [
    {
        name: 'Radarr',
        implementation: 'Radarr',
        syncLevel: 'addOnly',
        tags: [],
        fields: [{ name: 'syncCategories', value: [2000, 2040, 2045] }]
    },
    {
        name: 'Sonarr',
        implementation: 'Sonarr',
        syncLevel: 'fullSync',
        tags: [],
        fields: [
            { name: 'syncCategories', value: [5000, 5040] },
            { name: 'animeSyncCategories', value: [5070] }
        ]
    },
    { name: 'Sonarr 4K', implementation: 'Sonarr', syncLevel: 'fullSync', tags: [3] },
    { name: 'Lidarr', implementation: 'Lidarr', syncLevel: 'disabled', tags: [] }
];

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(
    opts: {
        destructive?: boolean;
        version?: string;
        addFails?: boolean | string;
        syncFails?: boolean;
        profiles?: unknown[];
        tool?: 'manage_indexer' | 'delete_indexer';
        /** Names the Prowlarr instance, as one entry of a list does. */
        name?: string;
    } = {}
) {
    const writes: { method: string; path: string; body?: unknown }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
            writes.push({
                method,
                path: url.pathname,
                ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {})
            });
            if (url.pathname === '/api/v1/command') {
                if (opts.syncFails === true) return jsonResponse({ message: 'database is locked' }, 500);
                return jsonResponse({ id: 77, name: 'ApplicationIndexerSync', status: 'queued' });
            }
            if (method === 'POST' && url.pathname === '/api/v1/indexer') {
                return opts.addFails
                    ? jsonResponse([{ errorMessage: typeof opts.addFails === 'string' ? opts.addFails : 'Unable to connect' }], 400)
                    : jsonResponse({ id: 99 });
            }
            return new Response('', { status: 202 });
        }
        if (url.pathname === '/api/v1/indexer') return jsonResponse(INDEXERS);
        if (url.pathname === '/api/v1/applications') return jsonResponse(APPS);
        if (url.pathname === '/api/v1/indexer/schema') return jsonResponse(SCHEMA);
        if (url.pathname === '/api/v1/appprofile') return jsonResponse(opts.profiles ?? PROFILES);
        if (url.pathname === '/api/v1/tag') return jsonResponse(TAGS);
        if (url.pathname === '/api/v1/system/status') return jsonResponse({ version: opts.version ?? '2.6.5.5623' });
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    const config = opts.name === undefined ? keyed(opts.destructive ?? true) : { ...keyed(opts.destructive ?? true), name: opts.name };
    const adapters = [new ProwlarrAdapter(config, impl)];
    const calls: Record<string, Call> = {};
    const server = {
        registerTool(name: string, spec: { inputSchema: z.ZodObject }, handler: Call) {
            calls[name] = args => handler(spec.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const invalidate = vi.fn();
    const context = {
        permissions: permissionSourceFrom(instancesOf({ prowlarr: config as unknown as AnyServiceConfig })),
        confirm: new ConfirmTokens(),
        audit: WriteAudit.ephemeral(),
        library: { invalidate } as unknown as LibraryLoader
    };
    registerManageIndexer(server as never, context, adapters);
    registerDeleteIndexer(server as never, context, adapters);

    const callTool = (name: string, args: Record<string, unknown>) => {
        const fn = calls[name];
        if (fn === undefined) throw new Error(`${name} not registered`);
        return fn(args);
    };
    const call = (args: Record<string, unknown>) => callTool(opts.tool ?? 'manage_indexer', args);
    const confirmed = async (args: Record<string, unknown>) => {
        const preview = await call(args);
        return call({ ...args, confirm: preview.structuredContent.confirm_token });
    };
    return { call, callTool, confirmed, writes, invalidate };
}

describe('manage_indexer disable and enable', () => {
    it('previews per app without writing anything', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ id: 21, action: 'disable' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.target).toBe('prowlarr:21');
        expect(h.writes).toEqual([]);

        const effects = structuredContent.effects.join('\n');
        expect(effects).toContain('Radarr: keeps its copy listed, but Prowlarr refuses every search and grab');
        expect(effects).toContain('Sonarr: Prowlarr disables its copy too (Full Sync).');
        expect(effects).toContain('Sonarr 4K: unaffected');
        expect(effects).toContain('Lidarr: keeps its copy listed');
    });

    it('flips only the flag through the bulk endpoint, then syncs', async () => {
        const h = harness();
        const applied = await h.confirmed({ id: 21, action: 'disable' });

        expect(applied.structuredContent.applied).toBe(true);
        expect(h.writes).toEqual([
            { method: 'PUT', path: '/api/v1/indexer/bulk', body: { ids: [21], enable: false } },
            { method: 'POST', path: '/api/v1/command', body: { name: 'ApplicationIndexerSync' } }
        ]);
    });

    it('reports the disable when the sync after it fails', async () => {
        const h = harness({ syncFails: true });
        const applied = await h.confirmed({ id: 21, action: 'disable' });

        expect(applied.structuredContent.applied).toBe(true);
        expect(applied.structuredContent.result).toMatchObject({ disabled: 'prowlarr:21', syncFailed: expect.any(String) });
        expect(applied.content[0]?.text).toContain('trigger_scan with service "prowlarr"');
    });

    it('accepts the id as a string, the way a model copies it', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ id: '21', action: 'disable' });
        expect(structuredContent.target).toBe('prowlarr:21');
    });

    it('is a no-op for an indexer already in that state', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ id: 8, action: 'disable' });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(h.writes).toEqual([]);
    });

    it('re-enables through the same flag, and says the sync re-adds a lost copy', async () => {
        const h = harness();
        const preview = await h.call({ id: 8, action: 'enable' });
        expect(preview.structuredContent.effects.join(' ')).toContain('the sync re-adds the copy if it is gone');

        await h.confirmed({ id: 8, action: 'enable' });
        expect(h.writes[0]).toEqual({ method: 'PUT', path: '/api/v1/indexer/bulk', body: { ids: [8], enable: true } });
    });

    it('needs only the safe tier to disable, even with destructive off', async () => {
        const h = harness({ destructive: false });
        const applied = await h.confirmed({ id: 21, action: 'disable' });

        expect(applied.structuredContent.tier).toBe('safe');
        expect(applied.structuredContent.applied).toBe(true);
    });

    it('refuses before a token on a Prowlarr without the bulk endpoint', async () => {
        const h = harness({ version: '1.7.4.3769' });
        await expect(h.call({ id: 21, action: 'disable' })).rejects.toThrow(/older than 1\.8/);
        expect(h.writes).toEqual([]);
    });

    it('reads a v-prefixed 1.8 version as having the bulk endpoint', async () => {
        const h = harness({ version: 'v1.8.0' });
        const applied = await h.confirmed({ id: 21, action: 'disable' });

        expect(h.writes[0]).toEqual({ method: 'PUT', path: '/api/v1/indexer/bulk', body: { ids: [21], enable: false } });
        expect(applied.structuredContent.applied).toBe(true);
    });

    it.each(['2.0', '1.10', '1.10.2.4000'])('reads %s as newer than 1.8', async version => {
        const h = harness({ version });
        const applied = await h.confirmed({ id: 21, action: 'disable' });

        expect(h.writes[0]?.path).toBe('/api/v1/indexer/bulk');
        expect(applied.structuredContent.applied).toBe(true);
    });

    it('refuses an id Prowlarr does not have', async () => {
        const h = harness();
        await expect(h.call({ id: 404, action: 'disable' })).rejects.toThrow(/no indexer with id 404/);
    });
});

describe('manage_indexer delete', () => {
    it('is gone: deleting is delete_indexer', () => {
        const h = harness();
        expect(() => h.call({ id: 21, action: 'delete' })).toThrow(/action/);
        expect(h.writes).toEqual([]);
    });
});

describe('delete_indexer', () => {
    it('says which apps lose their copy and which keep it', async () => {
        const h = harness({ tool: 'delete_indexer' });
        const { structuredContent } = await h.call({ id: 21 });

        expect(structuredContent.tier).toBe('destructive');
        expect(h.writes).toEqual([]);

        const effects = structuredContent.effects.join('\n');
        expect(effects).toContain('Radarr: Prowlarr removes its copy straight away.');
        expect(effects).toContain('Sonarr: Prowlarr removes its copy straight away.');
        expect(effects).toContain('Lidarr: sync is off, so any copy it has stays listed');
    });

    it('deletes, then syncs', async () => {
        const h = harness({ tool: 'delete_indexer' });
        const applied = await h.confirmed({ id: 21 });

        expect(applied.structuredContent.applied).toBe(true);
        expect(h.writes.map(w => `${w.method} ${w.path}`)).toEqual(['DELETE /api/v1/indexer/21', 'POST /api/v1/command']);
    });

    /** The delete has landed by the time the sync is queued: reported as a
     *  failure, a retry would answer that the indexer does not exist. */
    it('reports the delete when the sync after it fails', async () => {
        const h = harness({ tool: 'delete_indexer', syncFails: true });
        const applied = await h.confirmed({ id: 21 });

        expect(applied.structuredContent.applied).toBe(true);
        expect(applied.structuredContent.result).toMatchObject({ deleted: 'prowlarr:21', syncFailed: expect.any(String) });
        expect(applied.content[0]?.text).toMatch(/^Applied\. Delete .* But Application Indexer Sync did not start/);
        expect(applied.structuredContent.summary).toMatch(/did not start/);
        expect(h.invalidate).toHaveBeenCalled();
    });

    it('is refused when the destructive tier is off', async () => {
        const h = harness({ destructive: false, tool: 'delete_indexer' });
        const preview = await h.call({ id: 21, dry_run: true });
        expect(preview.structuredContent.permission.allowed).toBe(false);

        await expect(h.call({ id: 21 })).rejects.toThrow(/destructive/);
        expect(h.writes).toEqual([]);
    });

    it('previews a delete on a Prowlarr older than 1.8', async () => {
        const h = harness({ version: '1.7.4.3769', tool: 'delete_indexer' });
        expect((await h.call({ id: 21 })).structuredContent.confirm_token).toBeDefined();
    });

    it('will not apply a disable token to a delete', async () => {
        const h = harness({ tool: 'delete_indexer' });
        const disable = await h.callTool('manage_indexer', { id: 21, action: 'disable' });
        const retried = await h.call({ id: 21, confirm: disable.structuredContent.confirm_token });

        expect(retried.structuredContent.applied).toBe(false);
        expect(retried.structuredContent.confirm_error).toBe(CONFIRM_REASON.mismatch);
        expect(h.writes).toEqual([]);
    });
});

describe('manage_indexer edit', () => {
    it('previews old to new, and says Add and Remove Only apps keep the old settings', async () => {
        const h = harness();
        const { structuredContent } = await h.call({
            id: 21,
            action: 'edit',
            priority: 10,
            app_profile: 'interactive only'
        });

        expect(structuredContent.summary).toBe(
            'Edit Nyaa.si in prowlarr: priority 25 → 10; app profile Everything → Interactive only.'
        );
        const effects = structuredContent.effects.join(' | ');
        expect(effects).toContain("Radarr: keeps its copy's old settings");
        expect(effects).toContain('Sonarr: gets the new settings (Full Sync).');
        expect(effects).toContain('Lidarr: sync is off');
        expect(h.writes).toEqual([]);
    });

    it('sends only the changed settings, by id, through the bulk endpoint', async () => {
        const h = harness();
        await h.confirmed({ id: 21, action: 'edit', priority: 10, tags: ['Anime'], seed_ratio: 2 });

        expect(h.writes[0]).toEqual({
            method: 'PUT',
            path: '/api/v1/indexer/bulk',
            body: { ids: [21], priority: 10, tags: [4], applyTags: 'replace', seedRatio: 2 }
        });
        expect(h.writes[1]?.path).toBe('/api/v1/command');
    });

    it('warns that a seed value set from unset cannot be unset again here', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ id: 21, action: 'edit', seed_ratio: 2 });

        expect(structuredContent.summary).toContain('seed ratio unset → 2');
        expect(structuredContent.effects.join(' | ')).toContain("only Prowlarr's UI can");
    });

    it('works out which apps gain the indexer when tags change', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ id: 21, action: 'edit', tags: ['4k'] });
        const effects = structuredContent.effects.join(' | ');

        expect(effects).toContain('Radarr: unchanged, it still gets this indexer.');
        expect(effects).toContain('Sonarr 4K: gets the indexer on the sync, now that its tags match.');
    });

    it('works out which apps lose it, and that only Full Sync removes the copy', async () => {
        const h = harness();
        // altHUB carries tag 3, so Sonarr 4K has it. Swapping 3 for anime
        // keeps the untagged apps but drops Sonarr 4K.
        const { structuredContent } = await h.call({ id: 8, action: 'edit', tags: ['anime'] });

        expect(structuredContent.effects.join(' | ')).toContain(
            'Sonarr 4K: Prowlarr removes its copy on the sync, since its tags no longer match.'
        );
    });

    it('is a no-op when nothing would change', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ id: 21, action: 'edit', priority: 25, minimum_seeders: 1 });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    it('names the instance in the no-op summary', async () => {
        const h = harness({ name: 'two' });
        const { structuredContent } = await h.call({ id: 21, action: 'edit', priority: 25, minimum_seeders: 1 });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toMatch(/ in prowlarr\/two already has those settings\.$/);
    });

    it('refuses a tag or profile that does not exist, rather than creating one', async () => {
        const h = harness();
        await expect(h.call({ id: 21, action: 'edit', tags: ['movies'] })).rejects.toThrow(/no tag "movies"/);
        await expect(h.call({ id: 21, action: 'edit', app_profile: 'Nope' })).rejects.toThrow(/no app profile/);
    });

    it('refuses seed settings on a usenet indexer', async () => {
        const h = harness();
        await expect(h.call({ id: 8, action: 'edit', seed_ratio: 2 })).rejects.toThrow(/usenet indexer/);
    });

    it('refuses an edit with nothing to change, and settings on any other action', async () => {
        const h = harness();
        await expect(h.call({ id: 21, action: 'edit' })).rejects.toThrow(/at least one setting/);
        await expect(h.call({ id: 21, action: 'disable', priority: 3 })).rejects.toThrow(/takes no settings/);
    });
});

describe('manage_indexer add', () => {
    it('refuses to add when Prowlarr has no app profile', async () => {
        const h = harness({ profiles: [] });
        await expect(h.call({ action: 'add', definition: 'EZTV' })).rejects.toThrow(/Prowlarr has no app profile/);
        expect(h.writes).toEqual([]);
    });

    it('previews a public indexer with the first profile and what each app will do', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ action: 'add', definition: 'EZTV' });

        expect(structuredContent.target).toBe('prowlarr:new:eztv');
        expect(structuredContent.tier).toBe('safe');
        expect(structuredContent.summary).toBe(
            'Add EZTV (public torrent) to prowlarr, enabled, app profile Everything.'
        );
        const effects = structuredContent.effects.join(' | ');
        expect(effects).toContain('Radarr: Prowlarr adds it straight away');
        expect(effects).toContain('Sonarr 4K: unaffected');
        expect(h.writes).toEqual([]);
    });

    it('says which apps skip it for its categories, counting Sonarr anime categories', async () => {
        const h = harness();
        const movies = (await h.call({ action: 'add', definition: 'yts' })).structuredContent.effects.join(' | ');
        expect(movies).toContain('Radarr: Prowlarr adds it straight away');
        expect(movies).toContain('Sonarr: unaffected, YTS has none of the categories Sonarr syncs.');

        const anime = (await h.call({ action: 'add', definition: 'animetosho' })).structuredContent.effects.join(' | ');
        expect(anime).toContain('Radarr: unaffected, Anime Tosho has none of the categories Radarr syncs.');
        expect(anime).toContain('Sonarr: Prowlarr adds it straight away');
    });

    it("posts Prowlarr's own template with only the requested settings changed", async () => {
        const h = harness();
        const applied = await h.confirmed({ action: 'add', definition: 'eztv', priority: 30, seed_ratio: 1.5 });

        expect(applied.structuredContent.result).toMatchObject({ added: 'prowlarr:99' });
        const post = h.writes[0];
        expect(post?.method).toBe('POST');
        const body = post?.body as {
            definitionName: string;
            enable: boolean;
            priority: number;
            appProfileId: number;
            fields: { name: string; value: unknown }[];
        };
        expect(body).toMatchObject({ definitionName: 'eztv', enable: true, priority: 30, appProfileId: 1 });
        expect(body.fields.find(f => f.name === 'torrentBaseSettings.seedRatio')?.value).toBe(1.5);
        expect(body.fields.find(f => f.name === 'baseUrl')?.value).toBe('https://example.invalid/');
        expect(h.writes[1]?.path).toBe('/api/v1/command');
    });

    it('refuses anything that needs credentials, including a public one with a cookie field', async () => {
        const h = harness();
        await expect(h.call({ action: 'add', definition: 'Private HD' })).rejects.toThrow(/needs credentials/);
        await expect(h.call({ action: 'add', definition: 'cookietracker' })).rejects.toThrow(/needs credentials/);
        expect(h.writes).toEqual([]);
    });

    it('is a no-op for a definition already configured', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ action: 'add', definition: 'nyaasi' });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toBe('Nyaa.si is already configured as prowlarr:21.');
    });

    it('suggests close credential-free matches for an unknown name', async () => {
        const h = harness();
        await expect(h.call({ action: 'add', definition: 'ez' })).rejects.toThrow(/EZTV \(eztv\)/);
    });

    it('says plainly when Prowlarr refuses the add after testing the site', async () => {
        const h = harness({ addFails: true });
        await expect(h.confirmed({ action: 'add', definition: 'eztv' })).rejects.toThrow(
            /Prowlarr refused to add eztv/
        );
    });

    it('carries the reason Prowlarr gave when the refusal is not the site test', async () => {
        const h = harness({ addFails: 'Should not be empty' });
        await expect(h.confirmed({ action: 'add', definition: 'eztv' })).rejects.toThrow(
            /Prowlarr refused to add eztv: .*Should not be empty.*Nothing was added\. A failed site test/
        );
    });

    it('takes definition, not id', async () => {
        const h = harness();
        await expect(h.call({ action: 'add', id: 21, definition: 'eztv' })).rejects.toThrow(/not `id`/);
    });
});
