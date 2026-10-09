import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CleanuparrAdapter } from '../src/services/cleanuparr.ts';

const config = { url: 'http://cleanuparr:11011', api_key: 'k', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };
const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'cleanuparr', `${name}.json`), 'utf8'));

export function stub(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(routes[url.pathname]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

describe('CleanuparrAdapter', () => {
    it('reads the version from /api/status and drops the build part', async () => {
        const adapter = new CleanuparrAdapter(config, stub({ '/api/status': fixture('status') }));
        expect(await adapter.getVersion()).toBe('2.10.9');
    });

    it('sends the key as X-Api-Key', async () => {
        let header: string | null = null;
        const adapter = new CleanuparrAdapter(config, (async (_: string, init?: RequestInit) => {
            header = new Headers(init?.headers).get('X-Api-Key');
            return new Response(JSON.stringify(fixture('status')), { status: 200 });
        }) as unknown as typeof fetch);
        await adapter.getVersion();
        expect(header).toBe('k');
    });

    it('refuses a version below the floor in testConnection', async () => {
        const adapter = new CleanuparrAdapter(config, stub({ '/api/status': { application: { version: '2.9.0.0' } } }));
        const result = await adapter.testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('VersionUnsupported');
    });
});
