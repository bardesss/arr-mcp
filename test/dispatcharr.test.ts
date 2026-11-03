import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
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

const NOW = new Date('2026-11-03T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const f = (name: string) => fenceText(name, { service: 'dispatcharr', field: 'name' });

/** The fields /api/m3u/accounts/ returns at v0.33.0 that the adapter reads, healthy by default. */
const account = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'Example Provider 1',
    is_active: true,
    status: 'success',
    last_message: '',
    updated_at: hoursAgo(1),
    refresh_interval: 24,
    cron_expression: '',
    profiles: [{ id: 1, name: 'Example Profile 1', is_active: true, exp_date: null }],
    ...over
});
const source = (over: Record<string, unknown> = {}) => ({ id: 1, name: 'Example EPG 1', is_active: true, status: 'success', last_message: '', ...over });

async function findings(accounts: unknown[], sources: unknown[] = [], version = VERSION) {
    const adapter = new DispatcharrAdapter(config, stub(routes({ '/api/core/version/': version, '/api/m3u/accounts/': accounts, '/api/epg/sources/': sources })));
    return adapter.getFailedHealthChecks();
}

describe('DispatcharrAdapter health findings', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('finds nothing on a healthy instance', async () => {
        expect(await findings([account()], [source()])).toEqual([]);
    });

    it('reports an active account that failed to refresh, with a classified reason', async () => {
        const message = `Authentication required (401) for M3U file at URL: ${URL_}. Server message: bob`;
        expect(await findings([account({ status: 'error', last_message: message })])).toEqual([
            { service: 'dispatcharr', source: 'm3u', type: 'error', message: `M3U account ${f('Example Provider 1')} failed to refresh: the provider refused the login (HTTP 401)` }
        ]);
    });

    it('reports an account still pending setup', async () => {
        expect(await findings([account({ status: 'pending_setup' })])).toEqual([
            { service: 'dispatcharr', source: 'm3u', type: 'warning', message: `M3U account ${f('Example Provider 1')} is still pending setup` }
        ]);
    });

    it('reports an account that has not refreshed in three intervals', async () => {
        const at = hoursAgo(73);
        expect(await findings([account({ updated_at: at })])).toEqual([
            { service: 'dispatcharr', source: 'm3u', type: 'warning', message: `M3U account ${f('Example Provider 1')} has not refreshed since ${at}; it is set to refresh every 24h` }
        ]);
    });

    it('does not call an account stale inside three intervals', async () => {
        expect(await findings([account({ updated_at: hoursAgo(71) })])).toEqual([]);
    });

    it('skips staleness for a cron schedule or a zero interval', async () => {
        expect(await findings([account({ updated_at: hoursAgo(500), cron_expression: '0 3 * * *' })])).toEqual([]);
        expect(await findings([account({ updated_at: hoursAgo(500), refresh_interval: 0 })])).toEqual([]);
    });

    it('warns about a provider account expiring within 14 days', async () => {
        const profiles = [{ id: 1, name: 'Example Profile 1', is_active: true, exp_date: daysFromNow(10) }];
        expect(await findings([account({ profiles })])).toEqual([
            { service: 'dispatcharr', source: 'm3u', type: 'warning', message: `Provider account ${f('Example Provider 1')} / ${f('Example Profile 1')} expires on 2026-11-13` }
        ]);
    });

    it('errors on a provider account that has expired', async () => {
        const profiles = [{ id: 1, name: 'Example Profile 1', is_active: true, exp_date: daysFromNow(-1) }];
        expect(await findings([account({ profiles })])).toEqual([
            { service: 'dispatcharr', source: 'm3u', type: 'error', message: `Provider account ${f('Example Provider 1')} / ${f('Example Profile 1')} expired on 2026-11-02` }
        ]);
    });

    it('says nothing about expiry far off, absent, on an inactive profile, or with no profiles', async () => {
        const profile = (over: Record<string, unknown>) => ({ id: 1, name: 'P', is_active: true, exp_date: null, ...over });
        expect(await findings([account({ profiles: [profile({ exp_date: daysFromNow(30) })] })])).toEqual([]);
        expect(await findings([account({ profiles: [profile({ exp_date: null })] })])).toEqual([]);
        expect(await findings([account({ profiles: [profile({ is_active: false, exp_date: daysFromNow(-1) })] })])).toEqual([]);
        expect(await findings([account({ profiles: [] })])).toEqual([]);
        expect(await findings([account({ profiles: undefined })])).toEqual([]);
    });

    it('reports an active EPG source that failed', async () => {
        const message = "Error refreshing EPG data: HTTPSConnectionPool(host='h', port=443): Read timed out.";
        expect(await findings([], [source({ status: 'error', last_message: message })])).toEqual([
            { service: 'dispatcharr', source: 'epg', type: 'error', message: `EPG source ${f('Example EPG 1')} failed to refresh: the request timed out` }
        ]);
    });

    it('ignores accounts and sources the user switched off', async () => {
        expect(await findings([account({ is_active: false, status: 'error', updated_at: hoursAgo(500) })], [source({ is_active: false, status: 'error' })])).toEqual([]);
    });

    it('warns when Dispatcharr is newer than the tested minor', async () => {
        expect(await findings([], [], { version: '0.34.0', timestamp: null })).toEqual([
            {
                service: 'dispatcharr',
                source: 'version',
                type: 'warning',
                message: 'Dispatcharr 0.34.0 is newer than 0.33.x, which this adapter was written against; untested, results may be wrong'
            }
        ]);
    });

    it('fences names', async () => {
        const name = 'Evil\u202e<b>name';
        const [finding] = await findings([account({ name, status: 'pending_setup' })]);
        expect(finding?.message).toContain(f(name));
        expect(finding?.message).not.toContain('\u202e');
    });

    it('never lets a credential through, to output or logs', async () => {
        const written: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
            written.push(String(chunk));
            return true;
        }) as typeof process.stdout.write);
        const secretUrl = 'http://iptv.secret-host.example/get.php?username=bob&password=s3cret';
        const adminAccount = account({
            status: 'error',
            username: 'bob',
            password: 's3cret',
            server_url: secretUrl,
            custom_properties: { xc: { password: 's3cret' } },
            last_message: `Server returned HTTP 884 (authentication/authorization failure) from URL: ${secretUrl}. Server message: bob s3cret`,
            updated_at: hoursAgo(500),
            profiles: [{ id: 1, name: 'Example Profile 1', is_active: true, exp_date: daysFromNow(2), search_pattern: 'bob', replace_pattern: 's3cret', custom_properties: { password: 's3cret' } }]
        });
        const epg = source({ status: 'error', url: secretUrl, username: 'bob', last_message: `Error refreshing EPG data: 404 Client Error: Not Found for url: ${secretUrl}` });
        const out = await findings([adminAccount], [epg]);
        expect(out.length).toBeGreaterThanOrEqual(3);
        const text = JSON.stringify(out) + written.join('');
        for (const leak of ['bob', 's3cret', 'secret-host']) expect(text).not.toContain(leak);
    });
});
