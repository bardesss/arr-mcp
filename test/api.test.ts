import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LEVELS } from '../src/core/logs.ts';
import { hashToken } from '../src/core/mcpTokens.ts';
import { api, closeApi, json, KEY, MCP, mcp, RADARR_KEY, seedApi, stack, TX_PASSWORD } from './helpers/apiStack.ts';

beforeEach(async () => {
    await seedApi();
});

afterEach(async () => {
    vi.restoreAllMocks();
    await closeApi();
});

describe('the gate', () => {
    it('answers 404 with a pointer when no key is configured', async () => {
        await seedApi({ keyed: false });
        const res = await api('/system/status');
        expect(res.status).toBe(404);
        expect(((await res.json()) as { message: string }).message).toContain('Generate a key on the config page');
    });

    it('answers 401 without a key or with a wrong one', async () => {
        expect((await api('/system/status', { key: null })).status).toBe(401);
        expect((await api('/system/status', { key: `amk_${'9'.repeat(64)}` })).status).toBe(401);
    });

    it('ignores a key in the query string', async () => {
        expect((await api(`/system/status?apikey=${KEY}`, { key: null })).status).toBe(401);
    });

    it('keeps the management key and MCP tokens apart', async () => {
        expect((await api('/system/status', { key: MCP })).status).toBe(401);
        expect((await mcp(KEY)).status).toBe(401);
        expect((await mcp(MCP)).status).toBe(200);
    });

    it('answers an unknown endpoint with 404 JSON', async () => {
        const res = await api('/nope');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ message: 'No such endpoint.' });
    });

    it('marks every answer no-store', async () => {
        const answers = [
            await api('/nope'),
            await api('/app'),
            await api('/system/status', { key: null }),
            await api('/log?level=loud'),
            await api('/settings/imdb', json('PUT', { enabled: false }))
        ];
        expect(answers.map(r => r.status)).toEqual([404, 200, 401, 400, 200]);
        for (const res of answers) expect(res.headers.get('cache-control')).toBe('no-store');
    });
});

const line = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ level: LEVELS.info, time: 1_786_000_000_000, app: 'arr-mcp', msg: 'hello', ...over });

describe('GET /system/status', () => {
    it('names the app, version and MCP URL', async () => {
        const body = (await (await api('/system/status')).json()) as Record<string, unknown>;
        expect(body.appName).toBe('arr-mcp');
        expect(typeof body.version).toBe('string');
        expect(body.mcpUrl).toBe('http://localhost:6060/mcp');
    });
});

describe('GET /health', () => {
    it('reports one entry per app, down ones included', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        await seedApi();
        const res = await api('/health');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { app: string; type: string; ok: boolean; latencyMs: number; error?: { kind: string } }[];
        expect(body.map(h => h.app)).toEqual(['radarr/hd', 'transmission']);
        expect(body[0]).toMatchObject({ type: 'radarr', ok: false });
        expect(typeof body[0]?.latencyMs).toBe('number');
        expect(body[0]?.error?.kind).toBeDefined();
    });
});

describe('GET /health detail', () => {
    it('keeps the remedy on a down app', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('nope', { status: 401 })));
        await seedApi({ radarrUrl: 'http://radarr:7878' });
        const body = (await (await api('/health')).json()) as { app: string; error?: { kind: string; remedy?: string } }[];
        expect(body[0]?.app).toBe('radarr/hd');
        expect(body[0]?.error?.remedy).toEqual(expect.any(String));
    });

    it('keeps the version on a healthy app', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ version: '5.1.0' }), { headers: { 'content-type': 'application/json' } }))
        );
        await seedApi({ radarrUrl: 'http://radarr:7878' });
        const body = (await (await api('/health')).json()) as { app: string; ok: boolean; version?: string }[];
        expect(body[0]).toMatchObject({ app: 'radarr/hd', ok: true, version: '5.1.0' });
    });
});

describe('GET /health connection errors', () => {
    it('never shows the userinfo password when a real connection is refused', async () => {
        const closed = createServer();
        await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as AddressInfo).port;
        await new Promise(resolve => closed.close(resolve));

        // Radarr goes to the real fetch; transmission's DNS lookup is too slow to wait on.
        const realFetch = globalThis.fetch;
        vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
            String(input).includes('127.0.0.1') ? realFetch(input, init) : Promise.reject(new TypeError('fetch failed'))
        );
        await seedApi({ radarrUrl: `http://user:s3cretpw@127.0.0.1:${port}` });
        const res = await api('/health');
        expect(res.status).toBe(200);
        const text = await res.text();
        const radarr = (JSON.parse(text) as { app: string; error?: { kind: string } }[])[0];
        expect(radarr).toMatchObject({ app: 'radarr/hd', error: { kind: 'Unreachable' } });
        expect(text).not.toContain('s3cretpw');
    });
});

describe('GET /log', () => {
    beforeEach(() => {
        stack.logs.write(line({ msg: 'first' }));
        stack.logs.write(line({ level: LEVELS.warn, service: 'radarr/hd', msg: 'slow', port: 7878 }));
        stack.logs.write(line({ level: LEVELS.error, msg: 'broke' }));
    });

    it('returns records newest first with flattened fields', async () => {
        const { records } = (await (await api('/log')).json()) as {
            records: { id: number; level: string; app: string | null; message: string; fields: Record<string, string> }[];
        };
        expect(records.map(r => r.message)).toEqual(['broke', 'slow', 'first']);
        expect(records[1]).toMatchObject({ level: 'warn', app: 'radarr/hd', fields: { port: '7878' } });
    });

    it('filters by minimum level, app and cursor', async () => {
        const read = async (q: string) =>
            ((await (await api(`/log?${q}`)).json()) as { records: { id: number; message: string }[] }).records;
        expect((await read('level=warn')).map(r => r.message)).toEqual(['broke', 'slow']);
        expect((await read('app=radarr/hd')).map(r => r.message)).toEqual(['slow']);
        const all = await read('');
        const oldest = all[all.length - 1]?.id as number;
        expect((await read(`afterId=${oldest}`)).map(r => r.message)).toEqual(['broke', 'slow']);
        expect(await read('limit=1')).toHaveLength(1);
    });

    it('refuses a bad level, cursor or limit', async () => {
        for (const q of ['level=loud', 'afterId=-1', 'afterId=x', 'limit=0', 'limit=301', 'limit=x', 'level=constructor']) {
            expect((await api(`/log?${q}`)).status, q).toBe(400);
        }
    });
});

describe('GET /app', () => {
    it('lists apps with type-specific fields and no secrets', async () => {
        const res = await api('/app');
        expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/);
        const text = await res.text();
        expect(text).not.toContain(RADARR_KEY);
        expect(text).not.toContain(TX_PASSWORD);
        expect(text).not.toContain('user:pw');
        expect(JSON.parse(text)).toEqual([
            {
                id: 'radarr/hd',
                type: 'radarr',
                name: 'hd',
                url: 'http://radarr:7878/',
                timeoutMs: 10000,
                safeWrite: false,
                destructive: false,
                apiKeySet: true
            },
            {
                id: 'transmission',
                type: 'transmission',
                name: null,
                url: 'http://transmission:9091',
                timeoutMs: 10000,
                safeWrite: false,
                destructive: false,
                username: 'tx',
                passwordSet: true
            }
        ]);
    });

    it('reads one app by type and name, and 404s an unknown one', async () => {
        expect(((await (await api('/app/radarr/hd')).json()) as { id: string }).id).toBe('radarr/hd');
        expect(((await (await api('/app/transmission')).json()) as { id: string }).id).toBe('transmission');
        expect((await api('/app/radarr')).status).toBe(404);
        expect((await api('/app/sonarr/hd')).status).toBe(404);
    });
});

describe('GET /app multi-user fields', () => {
    const PLEX_KEY = 'plex-secret-token-0000';
    const JF_KEY = 'jellyfin-secret-key-0000';

    it('adds the user fields and the repair switch to plex', async () => {
        await seedApi({ extra: [`  plex: { url: 'http://plex:32400', api_key: '${PLEX_KEY}', default_user: alice }`] });
        const text = await (await api('/app/plex')).text();
        expect(text).not.toContain(PLEX_KEY);
        expect(JSON.parse(text)).toMatchObject({
            defaultUser: 'alice',
            allowOtherUsers: false,
            allowMetadataRepair: false,
            apiKeySet: true
        });
    });

    it('adds the user fields to jellyfin without the repair switch', async () => {
        await seedApi({ extra: [`  jellyfin: { url: 'http://jellyfin:8096', api_key: '${JF_KEY}', allow_other_users: true }`] });
        const text = await (await api('/app')).text();
        expect(text).not.toContain(JF_KEY);
        const jf = (JSON.parse(text) as Record<string, unknown>[]).find(a => a.type === 'jellyfin');
        expect(jf).toMatchObject({ defaultUser: null, allowOtherUsers: true, apiKeySet: true });
        expect(jf).not.toHaveProperty('allowMetadataRepair');
    });
});

describe('GET /settings and /token', () => {
    it('reads the MCP endpoint settings', async () => {
        expect(await (await api('/settings/mcp')).json()).toEqual({
            allowedHosts: [],
            allowTokenInUrl: false,
            oauthConfigured: false
        });
    });

    it('reads the IMDb dataset as off', async () => {
        expect(await (await api('/settings/imdb')).json()).toEqual({
            enabled: false,
            ingestedAt: null,
            titles: null,
            ratings: null
        });
    });

    it('lists tokens without hashes', async () => {
        const text = await (await api('/token')).text();
        expect(text).not.toContain(hashToken(MCP).slice(7));
        expect(JSON.parse(text)).toEqual([
            {
                name: 'phone',
                tier: 'read',
                expires: null,
                fingerprint: hashToken(MCP).slice(7, 15),
                expired: false,
                plaintextOnDisk: false
            }
        ]);
    });

    it('gives every config read the same ETag until the config changes', async () => {
        const tags = await Promise.all(['/app', '/settings/mcp', '/token'].map(async p => (await api(p)).headers.get('etag')));
        expect(new Set(tags).size).toBe(1);
    });

    it('never returns the management key or its hash', async () => {
        for (const p of ['/app', '/settings/mcp', '/settings/imdb', '/token', '/system/status']) {
            const text = await (await api(p)).text();
            expect(text, p).not.toContain(KEY);
            expect(text, p).not.toContain(hashToken(KEY).slice(7));
        }
    });
});
