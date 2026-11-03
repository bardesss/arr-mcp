import { describe, expect, it } from 'vitest';
import { DispatcharrAdapter, refreshReason } from '../src/services/dispatcharr.ts';

/** Dispatcharr's own formats (apps/m3u/tasks.py, apps/epg/tasks.py at v0.33.0), with a credentialed URL. */
const URL_ = 'http://h/get.php?username=bob&password=s3cret';
const REASONS: [string | null, string][] = [
    [`Server returned HTTP 884 (authentication/authorization failure) from URL: ${URL_}. Server message: bob s3cret`, 'the provider refused the login (HTTP 884)'],
    [`Authentication required (401) for M3U file at URL: ${URL_}. Server message: bob`, 'the provider refused the login (HTTP 401)'],
    [`Access forbidden (403) to M3U file at URL: ${URL_}. Server message: s3cret`, 'the provider refused access (HTTP 403)'],
    [`M3U file not found (404) at URL: ${URL_}. Server message: nope`, 'the provider has no playlist at that URL (HTTP 404)'],
    [`Server error (500) while fetching M3U file from URL: ${URL_}. Server message: oops`, 'the provider failed (HTTP 500)'],
    [`Server returned non-standard HTTP status 512 from URL: ${URL_}. Server message: x`, 'the provider answered HTTP 512'],
    [`HTTP error (502) while fetching M3U file from URL: ${URL_}. Server message: x`, 'the provider answered HTTP 502'],
    [`Server responded successfully (HTTP 200) but provided empty M3U file from URL: ${URL_}`, 'the provider sent an empty playlist'],
    ["Error refreshing EPG data: HTTPSConnectionPool(host='h', port=443): Read timed out. (read timeout=30)", 'the request timed out'],
    ["Error refreshing EPG data: HTTPConnectionPool(host='h', port=80): Max retries exceeded with url: /x (Caused by NewConnectionError('Failed to establish a new connection'))", 'could not reach the provider'],
    ['Error refreshing EPG data: [Errno -2] Name or service not known', 'could not reach the provider'],
    ['Error refreshing EPG data: [Errno 111] Connection refused', 'could not reach the provider'],
    ['Traceback (most recent call last): fetching http://bob:s3cret@h/x', 'refresh failed'],
    [null, 'refresh failed'],
    ['', 'refresh failed']
];

describe('refreshReason', () => {
    for (const [input, expected] of REASONS) {
        it(`reads ${JSON.stringify(input?.slice(0, 40))} as "${expected}"`, () => {
            const out = refreshReason(input);
            expect(out).toBe(expected);
            for (const leak of ['bob', 's3cret', 'http', 'h/']) expect(out).not.toContain(leak);
        });
    }
});

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
