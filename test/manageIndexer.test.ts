import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { ProwlarrAdapter } from '../src/services/prowlarr.ts';
import { registerManageIndexer } from '../src/tools/manageIndexer.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (destructive: boolean): KeyedServiceConfig => ({
    url: 'http://192.0.2.10:9696',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive }
});

const INDEXERS = [
    { id: 21, name: 'Nyaa.si', enable: true, protocol: 'torrent', priority: 25, tags: [] },
    { id: 8, name: 'altHUB', enable: false, protocol: 'usenet', priority: 25, tags: [3] }
];

const APPS = [
    { name: 'Radarr', implementation: 'Radarr', syncLevel: 'addOnly', tags: [] },
    { name: 'Sonarr', implementation: 'Sonarr', syncLevel: 'fullSync', tags: [] },
    { name: 'Sonarr 4K', implementation: 'Sonarr', syncLevel: 'fullSync', tags: [3] },
    { name: 'Lidarr', implementation: 'Lidarr', syncLevel: 'disabled', tags: [] }
];

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: { destructive?: boolean; version?: string } = {}) {
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
                return jsonResponse({ id: 77, name: 'ApplicationIndexerSync', status: 'queued' });
            }
            return new Response('', { status: 202 });
        }
        if (url.pathname === '/api/v1/indexer') return jsonResponse(INDEXERS);
        if (url.pathname === '/api/v1/applications') return jsonResponse(APPS);
        if (url.pathname === '/api/v1/system/status') return jsonResponse({ version: opts.version ?? '2.6.5.5623' });
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    const config = keyed(opts.destructive ?? true);
    const adapters = [new ProwlarrAdapter(config, impl)];
    const calls: Record<string, Call> = {};
    const server = {
        registerTool(name: string, spec: { inputSchema: z.ZodObject }, handler: Call) {
            calls[name] = args => handler(spec.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const context = {
        permissions: permissionSourceFrom(instancesOf({ prowlarr: config as unknown as AnyServiceConfig })),
        confirm: new ConfirmTokens(),
        audit: WriteAudit.ephemeral(),
        library: { invalidate: vi.fn() } as unknown as LibraryLoader
    };
    registerManageIndexer(server as never, context, adapters);

    const call = (args: Record<string, unknown>) => {
        const fn = calls.manage_indexer;
        if (fn === undefined) throw new Error('manage_indexer not registered');
        return fn(args);
    };
    const confirmed = async (args: Record<string, unknown>) => {
        const preview = await call(args);
        return call({ ...args, confirm: preview.structuredContent.confirm_token });
    };
    return { call, confirmed, writes };
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

    it('refuses before a token on a Prowlarr without the bulk endpoint, but still deletes', async () => {
        const h = harness({ version: '1.7.4.3769' });
        await expect(h.call({ id: 21, action: 'disable' })).rejects.toThrow(/older than 1\.8/);

        const preview = await h.call({ id: 21, action: 'delete' });
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('refuses an id Prowlarr does not have', async () => {
        const h = harness();
        await expect(h.call({ id: 404, action: 'disable' })).rejects.toThrow(/no indexer with id 404/);
    });
});

describe('manage_indexer delete', () => {
    it('says which apps lose their copy and which keep it', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ id: 21, action: 'delete' });

        expect(structuredContent.tier).toBe('destructive');
        expect(h.writes).toEqual([]);

        const effects = structuredContent.effects.join('\n');
        expect(effects).toContain('Radarr: Prowlarr removes its copy straight away.');
        expect(effects).toContain('Sonarr: Prowlarr removes its copy straight away.');
        expect(effects).toContain('Lidarr: sync is off, so any copy it has stays listed');
    });

    it('deletes, then syncs', async () => {
        const h = harness();
        const applied = await h.confirmed({ id: 21, action: 'delete' });

        expect(applied.structuredContent.applied).toBe(true);
        expect(h.writes.map(w => `${w.method} ${w.path}`)).toEqual(['DELETE /api/v1/indexer/21', 'POST /api/v1/command']);
    });

    it('is refused when the destructive tier is off', async () => {
        const h = harness({ destructive: false });
        const preview = await h.call({ id: 21, action: 'delete', dry_run: true });
        expect(preview.structuredContent.permission.allowed).toBe(false);

        await expect(h.call({ id: 21, action: 'delete' })).rejects.toThrow(/destructive/);
        expect(h.writes).toEqual([]);
    });

    it('will not apply a disable token to a delete', async () => {
        const h = harness();
        const disable = await h.call({ id: 21, action: 'disable' });
        const retried = await h.call({ id: 21, action: 'delete', confirm: disable.structuredContent.confirm_token });

        expect(retried.structuredContent.applied).toBe(false);
        expect(h.writes).toEqual([]);
    });
});
