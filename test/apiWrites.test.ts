import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachLogStore, detachLogStore, logger } from '../src/core/logger.ts';
import { hashToken } from '../src/core/mcpTokens.ts';
import { hashPassword } from '../src/core/session.ts';
import { api, closeApi, json, KEY, MCP, mcp, RADARR_KEY, seedApi, stack, TX_PASSWORD } from './helpers/apiStack.ts';

beforeEach(async () => {
    await seedApi();
});

afterEach(async () => {
    vi.restoreAllMocks();
    await closeApi();
});

const etag = async () => (await api('/settings/mcp')).headers.get('etag') as string;

describe('the write pipeline', () => {
    it('refuses a non-JSON body with 415', async () => {
        const res = await api('/settings/imdb', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'on' });
        expect(res.status).toBe(415);
    });

    it('refuses malformed JSON with a {message} 400, not a JSON-RPC error', async () => {
        const res = await api('/settings/imdb', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{nope'
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ message: 'The request body is not valid JSON.' });
    });

    it('refuses malformed JSON on POST the same way', async () => {
        const res = await api('/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ message: 'The request body is not valid JSON.' });
    });

    it('checks the key before the body: a wrong key and malformed JSON is 401', async () => {
        const res = await api('/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope', key: 'wrong' });
        expect(res.status).toBe(401);
    });

    it('answers 404 for a malformed body while the API is off', async () => {
        await seedApi({ keyed: false });
        const res = await api('/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
        expect(res.status).toBe(404);
    });

    it('answers a save that fails for another reason with a {message} 500', async () => {
        const tag = await etag();
        await rm(join(stack.dir, 'config.yaml'));
        // Expected, and its stack trace is noise in the test output.
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
        const res = await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': tag }));
        expect(res.status).toBe(500);
        expect(typeof ((await res.json()) as { message: string }).message).toBe('string');
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('applies a write with a current If-Match, weak or strong', async () => {
        const tag = await etag();
        expect((await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': tag }))).status).toBe(200);
        const next = await etag();
        expect(next).not.toBe(tag);
        expect((await api('/settings/imdb', json('PUT', { enabled: false }, { 'if-match': `W/${next}` }))).status).toBe(200);
    });

    it('accepts If-Match: * and a list that holds the current tag', async () => {
        expect((await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': '*' }))).status).toBe(200);
        const list = `"0000000000000000", ${await etag()}`;
        expect((await api('/settings/imdb', json('PUT', { enabled: false }, { 'if-match': list }))).status).toBe(200);
        const stale = `"0000000000000000", "1111111111111111"`;
        expect((await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': stale }))).status).toBe(412);
    });

    it('refuses a stale If-Match with 412 and changes nothing', async () => {
        const stale = await etag();
        await api('/settings/imdb', json('PUT', { enabled: true }));
        const res = await api('/settings/imdb', json('PUT', { enabled: false }, { 'if-match': stale }));
        expect(res.status).toBe(412);
        expect(stack.runtime.config.metadata?.imdb?.enabled).toBe(true);
    });

    it('refuses with 412 when config.yaml changed on disk', async () => {
        const path = join(stack.dir, 'config.yaml');
        const text = await readFile(path, 'utf8');
        await writeFile(path, `# edited by hand\n${text.replace('allowed_hosts: []', 'allowed_hosts: [edited.example.com]')}`, 'utf8');
        const res = await api('/settings/imdb', json('PUT', { enabled: true }));
        expect(res.status).toBe(412);
    });

    it('picks up a hand edit after the 412, so reading again and retrying works', async () => {
        const before = await etag();
        const path = join(stack.dir, 'config.yaml');
        const text = await readFile(path, 'utf8');
        await writeFile(path, text.replace('allowed_hosts: []', 'allowed_hosts: []\n  allow_token_in_url: true'), 'utf8');

        expect((await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': before }))).status).toBe(412);

        const fresh = await api('/settings/mcp');
        const tag = fresh.headers.get('etag') as string;
        expect(tag).not.toBe(before);
        expect(((await fresh.json()) as { allowTokenInUrl: boolean }).allowTokenInUrl).toBe(true);

        expect((await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': tag }))).status).toBe(200);
        expect(await readFile(path, 'utf8')).toContain('allow_token_in_url: true');
    });

    it('carries the new ETag on the write response', async () => {
        const res = await api('/settings/imdb', json('PUT', { enabled: true }));
        expect(res.headers.get('etag')).toBe(await etag());
    });
});

const radarr = () => {
    const list = stack.runtime.config.services.radarr;
    return (Array.isArray(list) ? list : [list]).find(r => (r as { name?: string } | undefined)?.name === 'hd');
};

describe('POST /app', () => {
    it('adds an app and answers 201 with the resource, no key', async () => {
        const res = await api('/app', json('POST', { type: 'radarr', name: 'uhd', url: 'http://radarr-uhd:7878', apiKey: 'uhd-secret-000' }));
        expect(res.status).toBe(201);
        const text = await res.text();
        expect(text).not.toContain('uhd-secret-000');
        expect(JSON.parse(text)).toMatchObject({ id: 'radarr/uhd', apiKeySet: true, safeWrite: false });
    });

    it('passes the config refusal through', async () => {
        const res = await api('/app', json('POST', { type: 'radarr', url: 'http://radarr2:7878', apiKey: 'k' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { message: string }).message).toContain('Name the new radarr');
    });

    it('names a forced rename in the log', async () => {
        await seedApi({ extra: ["  sonarr: { url: 'http://sonarr:8989', api_key: 'sonarr-key-000' }"] });
        const info = vi.spyOn(logger, 'info');
        const res = await api('/app', json('POST', { type: 'sonarr', name: 'uhd', renameExistingTo: 'hd', url: 'http://sonarr-uhd:8989', apiKey: 'k' }));
        expect(res.status).toBe(201);
        const line = info.mock.calls.find(call => call[1] === 'configuration saved from the management API');
        expect(line?.[0]).toMatchObject({ what: 'added sonarr/uhd (renamed sonarr to sonarr/hd)' });
    });

    it('logs the origin the new app points at, and nothing past it', async () => {
        const info = vi.spyOn(logger, 'info');
        await api('/app', json('POST', { type: 'sonarr', url: 'http://u:leakpw@sonarr.example:8989/x?apikey=leak', apiKey: 'k' }));
        const line = info.mock.calls.find(call => call[1] === 'configuration saved from the management API');
        expect(line?.[0]).toMatchObject({ what: 'added sonarr', target: 'http://sonarr.example:8989' });
        expect(JSON.stringify(line)).not.toContain('leak');
    });

    it('says which field is missing', async () => {
        const noUrl = await api('/app', json('POST', { type: 'sonarr', apiKey: 'k' }));
        expect(noUrl.status).toBe(400);
        expect(await noUrl.json()).toEqual({ message: 'url: required' });
        const emptyUrl = await api('/app', json('POST', { type: 'sonarr', url: '', apiKey: 'k' }));
        expect(await emptyUrl.json()).toEqual({ message: 'url: required' });
        const noKey = await api('/app', json('POST', { type: 'bazarr', url: 'http://bazarr:6767' }));
        expect(noKey.status).toBe(400);
        expect(await noKey.json()).toEqual({ message: 'apiKey is required for bazarr.' });
    });

    it('needs no apiKey for a download client that signs in', async () => {
        expect((await api('/app', json('POST', { type: 'qbittorrent', url: 'http://qbit:8080' }))).status).toBe(201);
    });

    it('refuses an unknown type or field', async () => {
        expect((await api('/app', json('POST', { type: 'kodi', url: 'http://k:1' }))).status).toBe(400);
        expect((await api('/app', json('POST', { type: 'sonarr', url: 'http://s:1', apiKey: 'k', apikey: 'typo' }))).status).toBe(400);
    });
});

describe('PUT /app/{type}/{name}', () => {
    it('merges: an omitted field is unchanged, secrets and URL credentials included', async () => {
        const res = await api('/app/radarr/hd', json('PUT', { timeoutMs: 20000 }));
        expect(res.status).toBe(200);
        expect(radarr()).toMatchObject({ timeout_ms: 20000, api_key: RADARR_KEY, url: 'http://user:pw@radarr:7878' });
    });

    it('accepts its own GET body back, so GET-modify-PUT works', async () => {
        const current = (await (await api('/app/radarr/hd')).json()) as Record<string, unknown>;
        const res = await api('/app/radarr/hd', json('PUT', { ...current, safeWrite: true }));
        expect(res.status).toBe(200);
        expect(radarr()).toMatchObject({
            url: 'http://user:pw@radarr:7878',
            api_key: RADARR_KEY,
            permissions: { safe_write: true, destructive: false }
        });
    });

    it('keeps the other permission when only one is sent', async () => {
        await api('/app/radarr/hd', json('PUT', { safeWrite: true }));
        await api('/app/radarr/hd', json('PUT', { destructive: true }));
        expect(radarr()?.permissions).toEqual({ safe_write: true, destructive: true });
    });

    it('sets a new URL and a new key', async () => {
        await api('/app/radarr/hd', json('PUT', { url: 'http://radarr-new:7878', apiKey: 'new-key-000' }));
        expect(radarr()).toMatchObject({ url: 'http://radarr-new:7878', api_key: 'new-key-000' });
    });

    it('clears a username with null and leaves the password', async () => {
        await api('/app/transmission', json('PUT', { username: null }));
        const tx = stack.runtime.config.services.transmission;
        const one = Array.isArray(tx) ? tx[0] : tx;
        expect(one?.username).toBeUndefined();
        expect(one?.password).toBe(TX_PASSWORD);
    });

    it('keeps URL credentials when the GET URL comes back with stray whitespace', async () => {
        const res = await api('/app/radarr/hd', json('PUT', { url: ' http://radarr:7878/ ' }));
        expect(res.status).toBe(200);
        expect(radarr()?.url).toBe('http://user:pw@radarr:7878');
    });

    it('logs the origin of a changed URL, and nothing past it', async () => {
        const info = vi.spyOn(logger, 'info');
        await api('/app/radarr/hd', json('PUT', { url: 'http://u:leakpw@elsewhere.example:9999/x?apikey=leak' }));
        const line = info.mock.calls.find(call => call[1] === 'configuration saved from the management API');
        expect(line?.[0]).toMatchObject({ what: 'saved radarr/hd', target: 'http://elsewhere.example:9999' });
        expect(JSON.stringify(line)).not.toContain('leak');
    });

    it('logs no target when the URL is unchanged', async () => {
        const info = vi.spyOn(logger, 'info');
        await api('/app/radarr/hd', json('PUT', { url: 'http://radarr:7878/', timeoutMs: 20000 }));
        const line = info.mock.calls.find(call => call[1] === 'configuration saved from the management API');
        expect(line?.[0]).toMatchObject({ what: 'saved radarr/hd' });
        expect(line?.[0]).not.toHaveProperty('target');
    });

    it('refuses a timeout too large for AbortSignal.timeout, before it reaches the config', async () => {
        const res = await api('/app/radarr/hd', json('PUT', { timeoutMs: 4_294_967_296 }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { message: string }).message).toContain('timeoutMs');
        expect((await api('/app/radarr/hd', json('PUT', { timeoutMs: 2_147_483_647 }))).status).toBe(200);
    });

    it('keeps URL credentials when the GET URL comes back without its trailing slash', async () => {
        expect((await api('/app/radarr/hd', json('PUT', { url: 'http://radarr:7878' }))).status).toBe(200);
        expect(radarr()?.url).toBe('http://user:pw@radarr:7878');
        expect((await api('/app/radarr/hd', json('PUT', { url: 'HTTP://Radarr:7878/' }))).status).toBe(200);
        expect(radarr()?.url).toBe('http://user:pw@radarr:7878');
    });

    it('treats another path, port or query as a new URL', async () => {
        for (const url of ['http://radarr:7878/radarr', 'http://radarr:7879', 'http://radarr:7878/?x=1']) {
            await seedApi();
            await api('/app/radarr/hd', json('PUT', { url }));
            expect(radarr()?.url, url).toBe(url);
        }
    });

    it('treats another scheme, or new credentials on the same host, as a new URL', async () => {
        for (const url of ['https://radarr:7878', 'http://other:pw2@radarr:7878']) {
            await seedApi();
            await api('/app/radarr/hd', json('PUT', { url }));
            expect(radarr()?.url, url).toBe(url);
        }
    });

    it('keeps URL credentials under a base path echoed with or without a slash', async () => {
        await seedApi({ radarrUrl: 'http://user:pw@proxy:443/radarr' });
        for (const url of ['http://proxy:443/radarr', 'http://proxy:443/radarr/']) {
            await api('/app/radarr/hd', json('PUT', { url }));
            expect(radarr()?.url, url).toBe('http://user:pw@proxy:443/radarr');
        }
    });

    it('refuses to clear a secret', async () => {
        expect((await api('/app/radarr/hd', json('PUT', { apiKey: null }))).status).toBe(400);
    });

    it('404s an unknown app', async () => {
        expect((await api('/app/sonarr', json('PUT', { timeoutMs: 1000 }))).status).toBe(404);
    });
});

describe('PUT /app multi-user fields', () => {
    const one = (type: 'jellyfin' | 'plex' | 'seerr') => {
        const value = stack.runtime.config.services[type];
        return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined;
    };

    // One media server at a time, so plex gets its own stack.
    const SEERR = "  seerr: { url: 'http://seerr:5055', api_key: 'seerr-key-000' }";
    const withJellyfin = () => seedApi({ extra: ["  jellyfin: { url: 'http://jellyfin:8096', api_key: 'jellyfin-key-000' }", SEERR] });
    const withPlex = () => seedApi({ extra: ["  plex: { url: 'http://plex:32400', api_key: 'plex-token-000' }", SEERR] });

    it('sets the default user and other users on jellyfin and seerr, and clears with null', async () => {
        await withJellyfin();
        for (const type of ['jellyfin', 'seerr'] as const) {
            const res = await api(`/app/${type}`, json('PUT', { defaultUser: ' alice ', allowOtherUsers: true }));
            expect(res.status, type).toBe(200);
            expect(await res.json()).toMatchObject({ defaultUser: 'alice', allowOtherUsers: true });
            expect(one(type)).toMatchObject({ default_user: 'alice', allow_other_users: true });

            expect((await api(`/app/${type}`, json('PUT', { defaultUser: null }))).status, type).toBe(200);
            expect(one(type)?.default_user, type).toBeUndefined();
            expect(one(type)?.allow_other_users, type).toBe(true);
        }
    });

    it('sets the default user and the repair switch on plex', async () => {
        await withPlex();
        const res = await api('/app/plex', json('PUT', { defaultUser: 'alice', allowMetadataRepair: true }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ defaultUser: 'alice', allowMetadataRepair: true });
        expect(one('plex')).toMatchObject({ default_user: 'alice', allow_metadata_repair: true });

        await api('/app/plex', json('PUT', { defaultUser: null }));
        expect(one('plex')?.default_user).toBeUndefined();
    });

    it('refuses other users on plex, whose token is one account', async () => {
        await withPlex();
        const res = await api('/app/plex', json('PUT', { allowOtherUsers: true }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { message: string }).message).toBe(
            'services.plex.allow_other_users: must be false. A Plex token is scoped to one account, so there is no second user to permit.'
        );
        expect(one('plex')?.allow_other_users).not.toBe(true);
    });
});

describe('DELETE /app', () => {
    it('removes the app', async () => {
        const res = await api('/app/transmission', { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(stack.runtime.config.services.transmission).toBeUndefined();
        expect((await api('/app/transmission')).status).toBe(404);
    });

    it('404s an unknown app', async () => {
        expect((await api('/app/sonarr', { method: 'DELETE' })).status).toBe(404);
    });
});

describe('POST /app/test', () => {
    it('tests an existing app with overrides, saving nothing, and answers 400 on failure', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const res = await api('/app/test', json('POST', { id: 'radarr/hd', url: 'http://radarr-other:7878' }));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { ok: boolean; app: string; latencyMs: number; error?: { kind: string } };
        expect(body).toMatchObject({ ok: false, app: 'radarr/hd' });
        expect(body.error?.kind).toBeDefined();
        expect(radarr()?.url).toBe('http://user:pw@radarr:7878');
    });

    it('answers 200 with the version when the app connects', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ version: '5.1.0' }), { headers: { 'content-type': 'application/json' } }))
        );
        const res = await api('/app/test', json('POST', { id: 'radarr/hd' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, app: 'radarr/hd', version: '5.1.0' });
    });

    it('tests a new app from type and fields', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const res = await api('/app/test', json('POST', { type: 'sonarr', url: 'http://sonarr:8989', apiKey: 'k' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { app: string }).app).toBe('sonarr');
        expect(stack.runtime.config.services.sonarr).toBeUndefined();
    });

    it('logs the origin of a URL the body sends, and nothing past it', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const info = vi.spyOn(logger, 'info');
        await api('/app/test', json('POST', { id: 'radarr/hd', url: ' http://elsewhere.example:9999/x?apikey=leak ' }));
        const line = info.mock.calls.find(call => call[1] === 'connection tested from the management API');
        expect(line?.[0]).toMatchObject({ service: 'radarr/hd', target: 'http://elsewhere.example:9999' });
        expect(JSON.stringify(line)).not.toContain('leak');
    });

    it('answers a candidate that will not build with {message}', async () => {
        const res = await api('/app/test', json('POST', { type: 'sonarr', url: 'not a url', apiKey: 'k' }));
        expect(res.status).toBe(400);
        expect(typeof ((await res.json()) as { message: string }).message).toBe('string');
    });
});

describe('PUT /settings', () => {
    it('turns the IMDb dataset on and off', async () => {
        const on = await api('/settings/imdb', json('PUT', { enabled: true }));
        expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
        expect(stack.runtime.config.metadata?.imdb?.enabled).toBe(true);
        await api('/settings/imdb', json('PUT', { enabled: false }));
        expect(stack.runtime.config.metadata).toBeUndefined();
    });

    it('sets allowTokenInUrl', async () => {
        const res = await api('/settings/mcp', json('PUT', { allowTokenInUrl: true }));
        expect(await res.json()).toEqual({ allowedHosts: [], allowTokenInUrl: true, oauthConfigured: false });
    });

    it('refuses to change allowedHosts, which would let a leaked key lock the owner out', async () => {
        const res = await api('/settings/mcp', json('PUT', { allowedHosts: ['evil.example.com'] }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { message: string }).message).toBe('allowedHosts can only be changed on the config page.');
        expect(stack.runtime.config.auth.allowed_hosts).toEqual([]);
    });

    it('accepts its own GET body back', async () => {
        const current = await (await api('/settings/mcp')).json();
        expect((await api('/settings/mcp', json('PUT', current))).status).toBe(200);
    });

    it('cannot reach anything outside its card', async () => {
        for (const body of [{ oauth: {} }, { managementKey: 'x' }, { username: 'root' }]) {
            expect((await api('/settings/mcp', json('PUT', body))).status, JSON.stringify(body)).toBe(400);
        }
    });
});

describe('tokens', () => {
    it('creates a token, returns it once, and it works on /mcp', async () => {
        const res = await api('/token', json('POST', { name: 'companion', tier: 'read', expiry: '30' }));
        expect(res.status).toBe(201);
        const created = (await res.json()) as { name: string; token: string; expires: string };
        expect(created.token).toMatch(/^amcp_[0-9a-f]{64}$/);
        expect(created.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect((await mcp(created.token)).status).toBe(200);
        expect(await (await api('/token')).text()).not.toContain(created.token);
    });

    it('refuses a duplicate name or a bad tier or expiry', async () => {
        expect((await api('/token', json('POST', { name: 'phone', tier: 'read', expiry: '30' }))).status).toBe(400);
        expect((await api('/token', json('POST', { name: 'x', tier: 'admin', expiry: '30' }))).status).toBe(400);
        expect((await api('/token', json('POST', { name: 'x', tier: 'read', expiry: '365' }))).status).toBe(400);
        expect((await api('/token', json('POST', { name: 'bad name!', tier: 'read', expiry: '30' }))).status).toBe(400);
    });

    it('revokes a token, which stops working at once', async () => {
        expect((await api('/token/phone', { method: 'DELETE' })).status).toBe(200);
        expect((await mcp(MCP)).status).toBe(401);
        expect(await (await api('/token')).text()).not.toContain('phone');
    });

    it('revokes regardless of case', async () => {
        const info = vi.spyOn(logger, 'info');
        expect((await api('/token/PHONE', { method: 'DELETE' })).status).toBe(200);
        expect(stack.runtime.config.auth.tokens).toEqual([]);
        const line = info.mock.calls.find(call => call[1] === 'configuration saved from the management API');
        expect(line?.[0]).toMatchObject({ what: 'revoked token phone' });
    });

    it('404s an unknown token', async () => {
        expect((await api('/token/nope', { method: 'DELETE' })).status).toBe(404);
    });
});

describe('a hand edit that no longer loads', () => {
    const breakFile = async () => {
        const path = join(stack.dir, 'config.yaml');
        const text = await readFile(path, 'utf8');
        await writeFile(path, text.replace(`api_key: '${RADARR_KEY}'`, `api_key: '${RADARR_KEY}', timeout_ms: -1`), 'utf8');
    };

    it('answers 409 with what to do, not a 412 that no retry can clear', async () => {
        await breakFile();
        for (let i = 0; i < 2; i++) {
            const res = await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': await etag() }));
            expect(res.status).toBe(409);
            expect(await res.json()).toEqual({ message: 'config.yaml was changed by hand and no longer loads. Fix the file, then retry.' });
        }
    });

    it('keeps the password and key hashes out of the log', async () => {
        const path = join(stack.dir, 'config.yaml');
        const seeded = await readFile(path, 'utf8');
        const passwordHash = await hashPassword('unused-here');
        await writeFile(path, seeded.replace('  username: admin', `  username: admin\n  password_hash: '${passwordHash}'`), 'utf8');
        await stack.runtime.reload();
        attachLogStore(stack.logs);
        try {
            await breakFile();
            await api('/settings/imdb', json('PUT', { enabled: true }));
            const text = await (await api('/log?limit=300')).text();
            expect(text).toContain('does not load');
            expect(text).not.toContain(passwordHash);
            expect(text).not.toContain(hashToken(KEY));
            expect(text).not.toContain(hashToken(MCP));
        } finally {
            detachLogStore();
        }
    });
});
