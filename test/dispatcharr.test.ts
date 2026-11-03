import { describe, expect, it } from 'vitest';
import { DispatcharrAdapter } from '../src/services/dispatcharr.ts';

const config = { url: 'http://dispatcharr:9191', api_key: 'dsp-key', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };

/** Answers by path; a number answers with that status. `seen` records every request. */
function stub(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
        const body = routes[url.pathname];
        if (typeof body === 'number') return new Response('{"detail":"no"}', { status: body });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

const VERSION = { version: '0.33.0', timestamp: null };
const routes = (over: Record<string, unknown> = {}) => ({
    '/api/core/version/': VERSION,
    '/api/m3u/accounts/': [],
    '/api/epg/sources/': [],
    ...over
});

describe('DispatcharrAdapter connection', () => {
    it('reads the version from /api/core/version/', async () => {
        const adapter = new DispatcharrAdapter(config, stub(routes()));
        expect(await adapter.getVersion()).toBe('0.33.0');
    });

    it('sends the key as X-API-Key', async () => {
        let header: string | null = null;
        const adapter = new DispatcharrAdapter(config, (async (_input: string, init?: RequestInit) => {
            header = new Headers(init?.headers).get('X-API-Key');
            return new Response(JSON.stringify(VERSION), { status: 200 });
        }) as unknown as typeof fetch);
        await adapter.getVersion();
        expect(header).toBe('dsp-key');
    });

    it('testConnection reads accounts too, since the version route answers anyone', async () => {
        const seen: string[] = [];
        const result = await new DispatcharrAdapter(config, stub(routes(), seen)).testConnection();
        expect(seen).toContain('GET /api/core/version/');
        expect(seen).toContain('GET /api/m3u/accounts/');
        expect(result.ok).toBe(true);
        expect(result.version).toBe('0.33.0');
    });

    it('a 403 on accounts names permission or network access, not the key', async () => {
        const result = await new DispatcharrAdapter(config, stub(routes({ '/api/m3u/accounts/': 403 }))).testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('AuthFailed');
        expect(result.error?.remedy).toMatch(/permission|Network Access/);
        expect(result.error?.remedy).not.toMatch(/key is wrong/);
    });

    it('a 401 says the key was rejected', async () => {
        const result = await new DispatcharrAdapter(config, stub(routes({ '/api/m3u/accounts/': 401 }))).testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.remedy).toMatch(/API key/);
    });
});
