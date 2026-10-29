import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigByService } from '../src/config/schema.ts';
import { DelugeAdapter } from '../src/services/deluge.ts';
import { jsonResponse } from './helpers/serve.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'deluge', name), 'utf8'));
const answer = (name: string): unknown => (fixture(name) as { result: unknown }).result;

const PASSWORD = 'web-ui-password';
const config = (password = PASSWORD): ConfigByService['deluge'] => ({
    url: 'http://192.0.2.10:8112',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: true },
    password
});

const HASH = 'a'.repeat(40);

type Call = { method: string; params: unknown[]; authed: boolean };
type Handler = (params: unknown[]) => unknown;

/**
 * A Deluge Web UI. A call without its session cookie is "Not authenticated",
 * `auth.login` takes the password, and a daemon call made while `connected`
 * is false throws, where the real Web UI would never answer at all.
 */
function webUi(routes: Record<string, unknown>, opts: { connected?: boolean; cookie?: boolean; rejectSession?: boolean } = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
        const { method, params } = JSON.parse(String(init?.body)) as Call;
        const authed = !opts.rejectSession && new Headers(init?.headers).get('cookie') === '_session_id=s3ss10n';
        calls.push({ method, params, authed });
        if (method === 'auth.login') {
            if (params[0] !== PASSWORD) return jsonResponse(fixture('login-refused.json'));
            return new Response(JSON.stringify({ result: true, error: null, id: 1 }), {
                headers: { 'content-type': 'application/json', ...(opts.cookie === false ? {} : { 'set-cookie': '_session_id=s3ss10n; Path=/' }) }
            });
        }
        if (!authed) return jsonResponse(fixture('not-authenticated.json'));
        if (method === 'web.connected') return jsonResponse({ result: opts.connected ?? true, error: null, id: 1 });
        if (opts.connected === false && !method.startsWith('web.')) throw new Error(`${method} sent with no daemon behind the Web UI`);
        if (!(method in routes)) return jsonResponse(fixture('unknown-method.json'));
        const route = routes[method];
        if (route instanceof Error) return jsonResponse({ result: null, error: { message: route.message, code: 4 }, id: 1 });
        return jsonResponse({ result: typeof route === 'function' ? (route as Handler)(params) : route, error: null, id: 1 });
    }) as unknown as typeof fetch;
    const sent = (method: string) => calls.filter(c => c.authed && c.method === method);
    return { fetchImpl, calls, sent };
}

const queueRoutes = (torrents: unknown, sessionPaused = false) => ({
    'core.get_torrents_status': torrents,
    'core.is_session_paused': sessionPaused,
    'core.get_config_values': answer('config-values.json')
});

const one = (row: Record<string, unknown>) => ({ [HASH]: { name: 'Some.Release', trackers: [], ...row } });

/** What a whole-client resume leaves as it was, on every read of the session. */
const SESSION_NOTE = "Every torrent not paused on its own starts again, as Deluge's Queue settings allow, and uses bandwidth.";

describe('DelugeAdapter: the Web UI session', () => {
    it('logs in on the first call and answers it, with no login ahead of time', async () => {
        const ui = webUi({ 'daemon.get_version': '2.2.0' });
        expect(await new DelugeAdapter(config(), ui.fetchImpl).getVersion()).toBe('2.2.0');
        expect(ui.calls.map(c => c.method)).toEqual(['web.connected', 'auth.login', 'web.connected', 'daemon.get_version']);
    });

    it('shares one login between calls that start together', async () => {
        const ui = webUi(queueRoutes(answer('torrents-status.json')));
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        await Promise.all([a.getQueue(), a.getSeedLimits()]);
        expect(ui.calls.filter(c => c.method === 'auth.login')).toHaveLength(1);
    });

    it('reports a wrong password as AuthFailed, naming the Web UI password', async () => {
        const ui = webUi({ 'daemon.get_version': '2.2.0' });
        await expect(new DelugeAdapter(config('not-it'), ui.fetchImpl).getVersion()).rejects.toMatchObject({
            kind: 'AuthFailed',
            detail: 'the Web UI refused the password',
            remedy: expect.stringMatching(/Preferences > Interface > WebUI Password/)
        });
    });

    it('fails a login that sets no session cookie', async () => {
        const ui = webUi({ 'daemon.get_version': '2.2.0' }, { cookie: false });
        await expect(new DelugeAdapter(config(), ui.fetchImpl).getVersion()).rejects.toMatchObject({
            kind: 'AuthFailed',
            detail: 'login succeeded but set no session cookie'
        });
    });

    it('fails as AuthFailed when the new session is refused too, pointing at what drops the cookie', async () => {
        const ui = webUi({ 'daemon.get_version': '2.2.0' }, { rejectSession: true });
        await expect(new DelugeAdapter(config(), ui.fetchImpl).getVersion()).rejects.toMatchObject({
            kind: 'AuthFailed',
            detail: 'the Web UI refused the session it had just issued',
            remedy: 'Deluge accepted the password but not the session cookie sent back with the next call. Check that nothing between arr-mcp and the Web UI, such as a reverse proxy, drops the Cookie header.'
        });
        expect(ui.calls.filter(c => c.method === 'auth.login')).toHaveLength(1);
    });

    // The auth check reads a copy of each answer; a long one used to wait on
    // that copy for good.
    it('fails an answer that breaks off part-way as the service failing, not with a TypeError', async () => {
        const fetchImpl = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(c) {
                        c.enqueue(new TextEncoder().encode('{"result": tr'));
                        c.error(new TypeError('terminated'));
                    }
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )) as unknown as typeof fetch;
        await expect(new DelugeAdapter(config(), fetchImpl).getVersion()).rejects.toMatchObject({ name: 'ServiceError', service: 'deluge' });
    });

    it('reads an answer longer than the not-authenticated check', async () => {
        const torrents = answer('torrents-status.json');
        expect(JSON.stringify(torrents).length).toBeGreaterThan(512);
        const ui = webUi(queueRoutes(torrents));
        expect(await new DelugeAdapter(config(), ui.fetchImpl).getQueue()).toHaveLength(3);
    });
});

describe('DelugeAdapter: the daemon behind the Web UI', () => {
    it('asks web.connected once for a get_stack_health pass', async () => {
        const ui = webUi({ ...queueRoutes(answer('torrents-status.json')), 'core.get_free_space': answer('free-space.json') });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        await Promise.all([a.getDiskSpace(), a.getSeedLimits(), a.getQueue()]);
        expect(ui.sent('web.connected')).toHaveLength(1);
        expect(ui.sent('core.get_config_values')).toHaveLength(1);
    });

    it('fails a read at once while the Web UI has no daemon behind it, and keeps that for the window', async () => {
        const ui = webUi(queueRoutes(answer('torrents-status.json')), { connected: false });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        for (const read of [() => a.getQueue(), () => a.getDiskSpace()]) {
            await expect(read()).rejects.toMatchObject({
                kind: 'Unreachable',
                detail: 'the Web UI is not connected to a Deluge daemon, so nothing behind it can be read',
                remedy: expect.stringMatching(/Connection Manager/)
            });
        }
        expect(ui.sent('web.connected')).toHaveLength(1);
        expect(ui.calls.filter(c => !c.method.startsWith('web.') && c.method !== 'auth.login')).toEqual([]);
    });

    it('passes the connection test on a connected daemon, with its version', async () => {
        const ui = webUi({ 'daemon.get_version': answer('daemon-version.json') });
        expect(await new DelugeAdapter(config(), ui.fetchImpl).testConnection()).toMatchObject({ ok: true, version: '2.2.0' });
    });

    it('tells a stopped daemon from one the Web UI is not connected to', async () => {
        const test = async (status: string) =>
            (
                await new DelugeAdapter(
                    config(),
                    webUi({ 'web.get_hosts': answer('hosts.json'), 'web.get_host_status': answer(status) }, { connected: false }).fetchImpl
                ).testConnection()
            ).error;

        expect(await test('host-status-online.json')).toEqual({
            kind: 'Unreachable',
            detail: 'the Web UI answers, but it is not connected to the Deluge daemon, which is running',
            remedy: "Connect to the daemon in the Web UI's Connection Manager."
        });
        expect(await test('host-status-offline.json')).toEqual({
            kind: 'Unreachable',
            detail: 'the Web UI answers, but no Deluge daemon answers at the address its Connection Manager lists',
            remedy: "Start deluged, or correct the daemon's address in the Web UI's Connection Manager, then connect to it there."
        });
    });

    it('says when the Connection Manager lists no daemon at all', async () => {
        const ui = webUi({ 'web.get_hosts': [] }, { connected: false });
        expect((await new DelugeAdapter(config(), ui.fetchImpl).testConnection()).error).toMatchObject({
            kind: 'Unreachable',
            detail: 'the Web UI is not connected to a Deluge daemon, and its Connection Manager lists none'
        });
    });

    it('falls back to the plain refusal when the daemon status cannot be read', async () => {
        const ui = webUi({ 'web.get_hosts': answer('hosts.json') }, { connected: false });
        expect((await new DelugeAdapter(config(), ui.fetchImpl).testConnection()).error).toMatchObject({
            kind: 'Unreachable',
            detail: 'the Web UI is not connected to a Deluge daemon, so nothing behind it can be read'
        });
    });

    it('asks again in the connection test, rather than trusting the last answer', async () => {
        const ui = webUi({ 'daemon.get_version': '2.2.0' });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        await a.getVersion();
        await a.testConnection();
        expect(ui.sent('web.connected')).toHaveLength(2);
    });

    it('fails the connection test on a daemon that answers no version', async () => {
        const ui = webUi({ 'daemon.get_version': '' });
        expect((await new DelugeAdapter(config(), ui.fetchImpl).testConnection()).error).toMatchObject({
            kind: 'UpstreamError',
            detail: 'daemon.get_version returned no version'
        });
    });

    it('accepts the 2.0.3 version string linuxserver ships, and refuses Deluge 1.3', async () => {
        const at = async (version: string) =>
            new DelugeAdapter(config(), webUi({ 'daemon.get_version': version }).fetchImpl).testConnection();
        expect(await at('2.0.3-2-201906121747-ubuntu18.04.1')).toMatchObject({ ok: true, version: '2.0.3-2-201906121747-ubuntu18.04.1' });
        expect((await at('1.3.15')).error).toMatchObject({ kind: 'VersionUnsupported' });
    });
});

describe('DelugeAdapter: get_queue', () => {
    it('maps the captured torrents', async () => {
        const rows = await new DelugeAdapter(config(), webUi(queueRoutes(answer('torrents-status.json'))).fetchImpl).getQueue();
        const byId = Object.fromEntries(rows.map(r => [r.id, r]));
        const trackers = ['tracker-1.example.test', 'tracker-2.example.test'];

        expect(byId['1'.repeat(40)]).toEqual({
            service: 'deluge',
            id: '1'.repeat(40),
            title: '<<untrusted:deluge.name>>Release.Name.1.1080p.WEB-DL.x264-GROUP<</>>',
            status: 'seeding',
            protocol: 'torrent',
            sizeBytes: 4294967296,
            remainingBytes: 0,
            private: false,
            seeding: { ratio: 0.25, seedingSeconds: 0 },
            torrent: {
                hash: '1'.repeat(40),
                category: 'category',
                tags: [],
                trackerDomains: trackers,
                savePath: '/data/torrents',
                private: false,
                stopped: false,
                seeding: true
            }
        });
        expect(byId['2'.repeat(40)]).toMatchObject({ status: 'paused', remainingBytes: 0, torrent: { stopped: true, seeding: true } });
        expect(byId['3'.repeat(40)]).toMatchObject({ status: 'downloading', remainingBytes: 1073741824, torrent: { stopped: false, seeding: false } });
        expect(byId['3'.repeat(40)]).not.toHaveProperty('seeding');
        // `eta` is 0 on all three: no estimate, so none is reported.
        expect(rows.filter(r => 'etaSeconds' in r || 'heldBy' in r || 'errorMessage' in r)).toEqual([]);
    });

    it("reads a session pause from each torrent's own flag", async () => {
        const rows = await new DelugeAdapter(
            config(),
            webUi(queueRoutes(answer('torrents-status-session-paused.json'), answer('session-paused.json') as boolean)).fetchImpl
        ).getQueue();
        expect(rows.map(r => [r.id.slice(0, 1), r.status, r.heldBy])).toEqual([
            ['1', 'queued to seed', 'queue'],
            ['2', 'paused', 'queue'],
            ['3', 'queued', 'queue']
        ]);
    });

    it("reads Deluge's own queue apart from a session pause, and a state it does not know", async () => {
        const rows = async (row: Record<string, unknown>, sessionPaused = false) =>
            new DelugeAdapter(config(), webUi(queueRoutes(one(row), sessionPaused)).fetchImpl).getQueue();
        expect(await rows({ state: 'Queued', paused: true, is_finished: false })).toMatchObject([{ status: 'queued' }]);
        expect((await rows({ state: 'Queued', paused: true, is_finished: false }))[0]).not.toHaveProperty('heldBy');
        expect(await rows({ state: 'Queued', paused: true, is_finished: true })).toMatchObject([{ status: 'queued to seed' }]);
        expect(await rows({ state: 'Queued', paused: true, is_finished: false }, true)).toMatchObject([{ status: 'queued', heldBy: 'queue' }]);
        expect(await rows({ state: 'Checking' })).toMatchObject([{ status: 'checking' }]);
        expect(await rows({ state: 'Somewhere' })).toMatchObject([{ status: 'unknown' }]);
    });

    it("carries an errored torrent's message, and no one else's", async () => {
        const torrents = {
            [HASH]: { name: 'a', state: 'Error', paused: true, message: 'Permission denied', trackers: [] },
            ['b'.repeat(40)]: { name: 'b', state: 'Downloading', paused: false, message: 'OK', trackers: [] },
            ['c'.repeat(40)]: { name: 'c', state: 'Error', paused: true, message: '', trackers: [] }
        };
        const rows = await new DelugeAdapter(config(), webUi(queueRoutes(torrents)).fetchImpl).getQueue();
        expect(rows.map(r => [r.status, r.errorMessage])).toEqual([
            ['error', '<<untrusted:deluge.message>>Permission denied<</>>'],
            ['downloading', undefined],
            ['error', undefined]
        ]);
    });

    it('reports an ETA only for a torrent still downloading with an estimate', async () => {
        const eta = async (row: Record<string, unknown>) =>
            (await new DelugeAdapter(config(), webUi(queueRoutes(one(row))).fetchImpl).getQueue())[0]?.etaSeconds;
        expect(await eta({ state: 'Downloading', is_finished: false, eta: 120 })).toBe(120);
        expect(await eta({ state: 'Downloading', is_finished: false, eta: 0 })).toBeUndefined();
        expect(await eta({ state: 'Downloading', is_finished: false, eta: -1 })).toBeUndefined();
        // On a finished torrent it counts down to the stop ratio.
        expect(await eta({ state: 'Seeding', is_finished: true, eta: 300 })).toBeUndefined();
    });

    it("reads a torrent's own stop ratio against the client's default", async () => {
        const seeding = async (row: Record<string, unknown>) =>
            (await new DelugeAdapter(config(), webUi(queueRoutes(one({ state: 'Seeding', is_finished: true, ...row }))).fetchImpl).getQueue())[0]
                ?.seeding;
        expect(await seeding({ stop_at_ratio: true, stop_ratio: 1.5, ratio: 1.6 })).toEqual({
            ratio: 1.6,
            ratioLimit: 1.5,
            ownLimit: true,
            overLimit: true
        });
        expect(await seeding({ stop_at_ratio: false, stop_ratio: 2, ratio: 0.5 })).toEqual({ ratio: 0.5 });
        // -1 while nothing has downloaded: no ratio to report.
        expect(await seeding({ stop_at_ratio: false, ratio: -1, seeding_time: 60 })).toEqual({ seedingSeconds: 60 });
        // Radarr and Sonarr set the flag to 1 (`DelugeProxy`), which Deluge reads as on, and 0 as off.
        expect(await seeding({ stop_at_ratio: 1, stop_ratio: 1.5, ratio: 1.6 })).toEqual({ ratio: 1.6, ratioLimit: 1.5, ownLimit: true, overLimit: true });
        expect(await seeding({ stop_at_ratio: 0, stop_ratio: 1.5, ratio: 1.6 })).toEqual({ ratio: 1.6 });
        // A torrent with no flag in its answer is not read as having its own limit.
        expect(await seeding({ ratio: 0.5 })).toEqual({ ratio: 0.5 });
    });

    it("tells a torrent's own ratio from the client's default one, and reads no default as none", async () => {
        const seeding = async (row: Record<string, unknown>, defaults: unknown) =>
            (
                await new DelugeAdapter(
                    config(),
                    webUi({ ...queueRoutes(one({ state: 'Seeding', is_finished: true, ratio: 0.5, ...row })), 'core.get_config_values': defaults }).fetchImpl
                ).getQueue()
            )[0]?.seeding;
        const defaults = { stop_seed_at_ratio: true, stop_seed_ratio: 2 };
        expect(await seeding({ stop_at_ratio: true, stop_ratio: 2 }, defaults)).toEqual({ ratio: 0.5, ratioLimit: 2 });
        expect(await seeding({ stop_at_ratio: 1, stop_ratio: 3 }, defaults)).toEqual({ ratio: 0.5, ratioLimit: 3, ownLimit: true });
        // An answer with no flag says nothing of the torrent's own limit, even where the default stops.
        expect(await seeding({}, defaults)).toEqual({ ratio: 0.5 });
        expect(await seeding({ stop_at_ratio: true, stop_ratio: 3 }, {})).toEqual({ ratio: 0.5, ratioLimit: 3 });
        expect(await seeding({ stop_at_ratio: true, stop_ratio: 3 }, null)).toEqual({ ratio: 0.5, ratioLimit: 3 });
    });

    it("leaves the category empty without the Label plugin's label", async () => {
        const rows = await new DelugeAdapter(config(), webUi(queueRoutes(one({ state: 'Seeding', is_finished: true }))).fetchImpl).getQueue();
        expect(rows[0]?.torrent?.category).toBe('');
    });

    it('skips rows that are not torrents, and fields that are not what Deluge sends', async () => {
        const torrents = {
            'not-a-hash': { state: 'Seeding' },
            ['b'.repeat(40)]: null,
            [HASH]: { state: 'Seeding', trackers: [null, { url: 'not a url' }] },
            ['c'.repeat(40)]: { state: 'Seeding', name: 7, label: 3, download_location: ['/data'], trackers: 'tracker.example.test' }
        };
        const rows = await new DelugeAdapter(config(), webUi(queueRoutes(torrents)).fetchImpl).getQueue();
        expect(rows.map(r => [r.id.slice(0, 1), r.title, r.torrent?.category, r.torrent?.savePath, r.torrent?.trackerDomains])).toEqual([
            ['a', '', '', undefined, []],
            ['c', '', '', undefined, []]
        ]);
    });

    it('leaves out what a failed side read would add, rather than the queue', async () => {
        const rows = async (routes: Record<string, unknown>) =>
            new DelugeAdapter(
                config(),
                webUi({ ...queueRoutes(one({ state: 'Paused', paused: false, is_finished: true, stop_at_ratio: true, stop_ratio: 1, ratio: 2 }), true), ...routes }).fetchImpl
            ).getQueue();
        // No config: no `ownLimit`, and the session pause reads as one by hand.
        const noConfig = (await rows({ 'core.get_config_values': new Error('ConfigError: unreadable') }))[0];
        expect(noConfig).toMatchObject({ status: 'queued to seed', heldBy: 'queue', seeding: { ratio: 2, ratioLimit: 1, overLimit: true } });
        expect(noConfig?.seeding).not.toHaveProperty('ownLimit');
        // A Scheduler state that cannot be read leaves the pause one by hand too.
        const scheduled = { ...(answer('config-values.json') as object), enabled_plugins: ['Label', 'Scheduler'] };
        expect((await rows({ 'core.get_config_values': scheduled, 'scheduler.get_state': new Error('PluginError: gone') }))[0]).toMatchObject({ heldBy: 'queue' });
        // No session state: no `heldBy`, and a torrent only the session holds reads as paused.
        const noSession = (await rows({ 'core.is_session_paused': new Error('RuntimeError: gone') }))[0];
        expect(noSession).toMatchObject({ status: 'paused' });
        expect(noSession).not.toHaveProperty('heldBy');
    });

    it('reads an answer that is not a torrent list as an empty queue', async () => {
        expect(await new DelugeAdapter(config(), webUi(queueRoutes(null)).fetchImpl).getQueue()).toEqual([]);
    });
});

describe('DelugeAdapter: disk, seed limits and speed', () => {
    it('reports free space at the download folder, and nothing for -1', async () => {
        const disk = async (free: unknown) =>
            new DelugeAdapter(config(), webUi({ 'core.get_config_values': answer('config-values.json'), 'core.get_free_space': free }).fetchImpl).getDiskSpace();
        expect(await disk(answer('free-space.json'))).toEqual([
            { service: 'deluge', path: '/data/torrents', label: 'Deluge download_location', freeSpace: answer('free-space.json') }
        ]);
        expect(await disk(-1)).toEqual([]);
    });

    it('names the setting when the config read has no download folder', async () => {
        const ui = webUi({ 'core.get_config_values': null, 'core.get_free_space': 1024 });
        expect(await new DelugeAdapter(config(), ui.fetchImpl).getDiskSpace()).toEqual([
            { service: 'deluge', path: 'download_location', label: 'Deluge download_location', freeSpace: 1024 }
        ]);
    });

    it('reads the default seed ratio, and what Deluge does at it', async () => {
        const limits = async (values: Record<string, unknown>) =>
            new DelugeAdapter(config(), webUi({ 'core.get_config_values': values }).fetchImpl).getSeedLimits();
        expect(await limits(answer('config-values.json') as Record<string, unknown>)).toEqual({ service: 'deluge', action: 'stop' });
        expect(await limits({ stop_seed_at_ratio: true, stop_seed_ratio: 2, remove_seed_at_ratio: true })).toEqual({
            service: 'deluge',
            ratioLimit: 2,
            action: 'remove'
        });
        expect(
            await new DelugeAdapter(config(), webUi({ 'core.get_config_values': null }).fetchImpl).getSeedLimits()
        ).toEqual({ service: 'deluge', action: 'stop' });
    });

    it('reads the download limit in KiB/s, and -1 as none', async () => {
        const limit = async (max: number) =>
            new DelugeAdapter(config(), webUi({ 'core.get_config_values': { max_download_speed: max } }).fetchImpl).readSpeedLimit();
        expect(await limit(-1)).toEqual({ service: 'deluge' });
        expect(await limit(0)).toEqual({ service: 'deluge' });
        expect(await limit(512)).toEqual({ service: 'deluge', kbps: 512 });
        expect(await limit(99.6)).toEqual({ service: 'deluge', kbps: 100 });
        expect(await limit('512' as unknown as number)).toEqual({ service: 'deluge' });
    });

    it('sets and clears the limit, and reads the config again after', async () => {
        const ui = webUi({ 'core.get_config_values': { max_download_speed: -1 }, 'core.set_config': null });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        await a.readSpeedLimit();
        await a.setSpeedLimit(256);
        await a.setSpeedLimit(undefined);
        await a.readSpeedLimit();
        expect(ui.sent('core.set_config').map(c => c.params)).toEqual([[{ max_download_speed: 256 }], [{ max_download_speed: -1 }]]);
        // The read before; the second write's Scheduler check, since the first
        // write dropped the shared read; and the read after.
        expect(ui.sent('core.get_config_values')).toHaveLength(3);
    });
});

describe('DelugeAdapter: pause', () => {
    it("pauses and resumes the whole client with Deluge's session pause", async () => {
        const ui = webUi({
            'core.is_session_paused': answer('session-running.json'),
            'core.get_config_values': answer('config-values.json'),
            'core.pause_session': null,
            'core.resume_session': null
        });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        expect(await a.readPauseState()).toEqual({ paused: false, scope: 'the Deluge session', endsOnRestart: true, resumeNote: SESSION_NOTE });
        await a.setPaused(true);
        await a.setPaused(false);
        expect(ui.calls.filter(c => c.method.endsWith('_session')).map(c => c.method)).toEqual(['core.pause_session', 'core.resume_session']);
    });

    // The Scheduler applies the hour's state a minute past each hour: Paused
    // (`Red`) pauses the session, any other resumes it, and Throttled
    // (`Yellow`) sets the limits in its Throttled Settings.
    // `enabled_plugins` keeps the name of a plugin the daemon could not load,
    // whose calls then answer "Unknown method" (code 2).
    it('counts a Scheduler the daemon has not loaded as off, and fails on any other error from it', async () => {
        const routes = {
            'core.is_session_paused': false,
            'core.get_config_values': { ...(answer('config-values.json') as object), enabled_plugins: ['Label', 'Scheduler'] },
            'core.pause_session': null,
            'core.set_config': null
        };
        const ui = webUi(routes);
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        expect(await a.readPauseState()).not.toHaveProperty('scheduler');
        expect(await a.readSpeedLimit()).toEqual({ service: 'deluge' });
        await a.setPaused(true);
        await a.setSpeedLimit(100);
        expect(ui.sent('core.pause_session')).toHaveLength(1);
        expect(ui.sent('core.set_config')).toHaveLength(1);
        const failing = new DelugeAdapter(config(), webUi({ ...routes, 'scheduler.get_state': new Error('RuntimeError: boom') }).fetchImpl);
        await expect(failing.readPauseState()).rejects.toMatchObject({ kind: 'UpstreamError' });
    });

    describe('with the Scheduler plugin on', () => {
        const scheduler = (slot: unknown, sessionPaused = false) =>
            webUi({
                'core.is_session_paused': sessionPaused,
                'core.get_config_values': { ...(answer('config-values.json') as object), enabled_plugins: ['Label', 'Scheduler'] },
                'scheduler.get_state': slot,
                'scheduler.get_config': { low_down: 300, low_up: 50, button_state: [] },
                'core.get_torrent_status': { state: sessionPaused ? 'Paused' : 'Downloading', paused: false },
                'core.get_torrents_status': { [HASH]: { name: 'Some.Release', state: 'Paused', paused: true, trackers: [] } },
                'core.pause_session': null,
                'core.resume_session': null,
                'core.pause_torrent': null,
                'core.set_config': null
            });
        const PAUSE = /^Deluge's Scheduler plugin is on at deluge, and its Schedule runs the session this hour, so it would resume a pause the next time it runs in an hour it does not mark Paused, or sooner, when a limit it controls changes\./;
        const RESUME = /^Deluge's Scheduler plugin is on at deluge, and its Schedule marks this hour Paused, so it would pause the session the next time it runs in an hour it marks Paused, or sooner, when a limit it controls changes\./;

        it('refuses a pause in a Normal hour, and lets a resume and a limit through', async () => {
            const ui = scheduler('Green');
            const a = new DelugeAdapter(config(), ui.fetchImpl);
            expect(await a.readPauseState()).toEqual({ paused: false, scope: 'the Deluge session', endsOnRestart: true, resumeNote: SESSION_NOTE, scheduler: 'run' });
            await expect(a.setPaused(true)).rejects.toThrow(PAUSE);
            await a.setPaused(false);
            expect(await a.readSpeedLimit()).toEqual({ service: 'deluge' });
            await a.setSpeedLimit(100);
            expect(ui.sent('core.pause_session')).toEqual([]);
            expect(ui.sent('core.resume_session')).toHaveLength(1);
            expect(ui.sent('core.set_config').map(c => c.params)).toEqual([[{ max_download_speed: 100 }]]);
            expect(ui.sent('scheduler.get_state')).toHaveLength(1);
            // The limit's confirm reads no session state: its preview did.
            expect(ui.sent('core.is_session_paused')).toHaveLength(2);
        });

        it('refuses a resume in a Paused hour, and names the Scheduler as what holds each torrent', async () => {
            const ui = scheduler('Red', true);
            const a = new DelugeAdapter(config(), ui.fetchImpl);
            expect(await a.readPauseState()).toMatchObject({ paused: true, scheduler: 'stop' });
            await expect(a.setPaused(false)).rejects.toThrow(RESUME);
            await expect(a.setPaused(false)).rejects.toThrow(/Mark this hour Normal or Throttled in the Schedule, or turn the plugin off in Deluge's Plugins preferences; either resumes the session at once, or keeps it running\.$/);
            expect(ui.sent('core.resume_session')).toEqual([]);
            expect(await a.readPauseState(HASH)).toEqual({ paused: false, scope: `torrent ${HASH}`, heldBy: 'scheduler' });
            expect((await a.getQueue()).map(r => [r.status, r.heldBy])).toEqual([['paused', 'scheduler']]);
        });

        it('holds a paused session by hand outside a Paused hour as the queue, not the Scheduler', async () => {
            const a = new DelugeAdapter(config(), scheduler('Green', true).fetchImpl);
            expect(await a.readPauseState(HASH)).toEqual({ paused: false, scope: `torrent ${HASH}`, heldBy: 'queue' });
            expect((await a.getQueue()).map(r => r.heldBy)).toEqual(['queue']);
        });

        it("reads a Throttled hour's own limit as the one in force, and refuses a new one", async () => {
            const ui = scheduler('Yellow');
            const a = new DelugeAdapter(config(), ui.fetchImpl);
            expect(await a.readSpeedLimit()).toEqual({ service: 'deluge', kbps: 300, scheduled: true });
            await expect(a.setSpeedLimit(100)).rejects.toThrow(
                "Deluge's Scheduler plugin is on at deluge, and its Schedule marks this hour Throttled, so the download limit in its Throttled Settings (300 KiB/s) is in force through every Throttled hour."
            );
            expect(await a.readPauseState()).toMatchObject({ scheduler: 'run' });
            expect(ui.sent('core.set_config')).toEqual([]);
        });

        it('says a new limit resumes a paused session in a Normal hour, and pauses a running one in a Paused hour', async () => {
            const limit = async (slot: string, sessionPaused: boolean) => new DelugeAdapter(config(), scheduler(slot, sessionPaused).fetchImpl).readSpeedLimit();
            expect(await limit('Green', true)).toEqual({ service: 'deluge', sessionChange: 'resume' });
            expect(await limit('Red', false)).toEqual({ service: 'deluge', sessionChange: 'pause' });
            expect(await limit('Green', false)).toEqual({ service: 'deluge' });
            expect(await limit('Red', true)).toEqual({ service: 'deluge' });
        });

        it('refuses a pause in a Throttled hour too, and lets a resume through', async () => {
            const ui = scheduler('Yellow', true);
            const a = new DelugeAdapter(config(), ui.fetchImpl);
            await expect(a.setPaused(true)).rejects.toThrow(PAUSE);
            await a.setPaused(false);
            expect(ui.sent('core.resume_session')).toHaveLength(1);
        });

        it('lets a pause through in a Paused hour, which the Schedule agrees with', async () => {
            const ui = scheduler('Red', false);
            await new DelugeAdapter(config(), ui.fetchImpl).setPaused(true);
            expect(ui.sent('core.pause_session')).toHaveLength(1);
        });

        it("reads the hour's state again in the connection test, rather than trusting the last answer", async () => {
            let slot = 'Green';
            const ui = scheduler(() => slot);
            const a = new DelugeAdapter(config(), ui.fetchImpl);
            expect(await a.readPauseState()).toMatchObject({ scheduler: 'run' });
            slot = 'Red';
            await a.testConnection();
            expect(await a.readPauseState()).toMatchObject({ scheduler: 'stop' });
        });

        it("leaves one torrent's pause to work every hour", async () => {
            const ui = scheduler('Red', true);
            const a = new DelugeAdapter(config(), ui.fetchImpl);
            await a.setPaused(true, HASH);
            expect(ui.sent('core.pause_torrent')).toHaveLength(1);
        });

        it('fails on a state it does not know, rather than guessing', async () => {
            const a = new DelugeAdapter(config(), scheduler('Blue').fetchImpl);
            await expect(a.readPauseState()).rejects.toThrow('scheduler.get_state answered <<untrusted:deluge.slot>>"Blue"<</>>, not Green, Yellow or Red');
        });

        it('asks for no state while the plugin is off', async () => {
            const ui = webUi({ 'core.is_session_paused': false, 'core.get_config_values': answer('config-values.json') });
            await new DelugeAdapter(config(), ui.fetchImpl).readPauseState();
            expect(ui.calls.map(c => c.method)).not.toContain('scheduler.get_state');
        });
    });

    it("reads one torrent's pause, and what else holds it", async () => {
        const state = async (row: Record<string, unknown>, sessionPaused = false) =>
            new DelugeAdapter(
                config(),
                webUi({ 'core.get_torrent_status': row, 'core.is_session_paused': sessionPaused, 'core.get_config_values': answer('config-values.json') }).fetchImpl
            ).readPauseState(HASH);
        const scope = `torrent ${HASH}`;
        const atRatio = { is_finished: true, stop_ratio: 2, ratio: 2.1 };
        const RATIO_NOOP = 'has reached its stop ratio of 2, so Deluge does not restart it: raise its "Stop seed at ratio" or turn it off in Deluge first.';
        const ERROR_NOTE =
            'A resume clears an error libtorrent raised, but not one Deluge raised itself, such as missing data or a failed move, which a Force Recheck in Deluge clears and which can keep the torrent from restarting.';

        expect(await state({ state: 'Paused', paused: true })).toEqual({ paused: true, scope });
        expect(await state({ state: 'Downloading', paused: false })).toEqual({ paused: false, scope });
        expect(await state({ state: 'Queued', paused: true })).toEqual({
            paused: false,
            scope,
            resumeNoop: 'is queued: Deluge starts it by itself as its Queue settings allow.'
        });
        expect(await state({ state: 'Paused', paused: false }, true)).toEqual({ paused: false, scope, heldBy: 'queue' });
        expect(await state({ state: 'Paused', paused: true }, true)).toEqual({ paused: true, scope, heldBy: 'queue' });
        // At its stop ratio a torrent only the session holds keeps that hold; only one in Error leaves it out.
        expect(await state({ state: 'Paused', paused: false, stop_at_ratio: true, ...atRatio }, true)).toEqual({ paused: false, scope, heldBy: 'queue' });
        expect(await state({ state: 'Paused', paused: true, stop_at_ratio: true, ...atRatio })).toEqual({ paused: true, scope, resumeNoop: RATIO_NOOP });
        // The *arrs' 1 is on too, and one still seeding is running.
        expect(await state({ state: 'Paused', paused: true, stop_at_ratio: 1, ...atRatio })).toEqual({ paused: true, scope, resumeNoop: RATIO_NOOP });
        expect(await state({ state: 'Seeding', paused: false, stop_at_ratio: true, ...atRatio })).toEqual({ paused: false, scope });
        // An error at the ratio is cleared by the resume all the same, and the torrent stays paused (`Torrent.resume`).
        expect(await state({ state: 'Error', paused: true, stop_at_ratio: true, ...atRatio })).toEqual({
            paused: true,
            scope,
            resumeNote: `It is in Error. ${ERROR_NOTE} It has reached its stop ratio of 2, so Deluge leaves it paused even once the error is cleared.`
        });
        expect(await state({ state: 'Error', paused: true, message: 'Permission denied' })).toEqual({
            paused: true,
            scope,
            resumeNote: `It is in Error (<<untrusted:deluge.message>>Permission denied<</>>). ${ERROR_NOTE}`
        });
        expect(await state({ state: 'Error', paused: true, message: '' })).toEqual({ paused: true, scope, resumeNote: `It is in Error. ${ERROR_NOTE}` });
        // One in Error is held whatever its flag says, so the resume that clears the error is sent.
        expect(await state({ state: 'Error', paused: false, message: '' })).toEqual({ paused: true, scope, resumeNote: `It is in Error. ${ERROR_NOTE}` });
        // A session pause holds a torrent in error or moving too, though
        // Deluge keeps showing it as such (`Torrent.update_state`), and a
        // torrent being moved keeps its own pause flag beside `Moving`.
        expect(await state({ state: 'Moving', paused: false }, true)).toEqual({ paused: false, scope, heldBy: 'queue' });
        expect(await state({ state: 'Moving', paused: true }, true)).toMatchObject({ paused: true, scope, heldBy: 'queue' });
        // Deluge's queue sets the flag too, and `Moving` hides which, so the resume says so.
        expect(await state({ state: 'Moving', paused: true })).toEqual({
            paused: true,
            scope,
            resumeNote: "It is being moved, so Deluge does not show whether its own pause or Deluge's queue holds it; a resume restarts it only in the first case."
        });
        expect(await state({ state: 'Error', paused: true, message: 'Permission denied' }, true)).toMatchObject({ paused: true, heldBy: 'queue' });
        // At its stop ratio the session's resume would not start it either, so no hold is named.
        expect(await state({ state: 'Error', paused: true, stop_at_ratio: true, ...atRatio }, true)).toEqual({
            paused: true,
            scope,
            resumeNote: `It is in Error. ${ERROR_NOTE} It has reached its stop ratio of 2, so Deluge leaves it paused even once the error is cleared.`
        });
        // On 2.0.3 the state can lag a pause or resume just made, while the flag
        // a one-torrent read gets is fresh, so the flag decides.
        expect(await state({ state: 'Downloading', paused: true })).toEqual({ paused: true, scope });
        expect(await state({ state: 'Paused', paused: false })).toEqual({ paused: false, scope });
    });

    it('refuses a torrent Deluge does not have, and an id that is not an info hash', async () => {
        const ui = webUi({ 'core.get_torrent_status': answer('torrent-status-unknown.json'), 'core.is_session_paused': false });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        await expect(a.readPauseState(HASH)).rejects.toMatchObject({ kind: 'NotFound', detail: `no torrent with id "${HASH}"` });
        await expect(a.readPauseState('17')).rejects.toMatchObject({ kind: 'NotFound', detail: '"17" is not a Deluge torrent id' });
        expect(ui.sent('core.get_torrent_status')).toHaveLength(1);
    });

    it('pauses and resumes one torrent by its hash, in lower case', async () => {
        const ui = webUi({ 'core.pause_torrent': null, 'core.resume_torrent': null });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        await a.setPaused(true, ` ${HASH.toUpperCase()} `);
        await a.setPaused(false, HASH);
        expect(ui.calls.filter(c => c.method.endsWith('_torrent')).map(c => [c.method, c.params])).toEqual([
            ['core.pause_torrent', [HASH]],
            ['core.resume_torrent', [HASH]]
        ]);
    });
});

describe('DelugeAdapter: remove and add', () => {
    it('removes a torrent, deleting its data only when asked', async () => {
        const ui = webUi({ 'core.remove_torrent': true });
        const a = new DelugeAdapter(config(), ui.fetchImpl);
        await a.removeQueueItem(HASH, { removeFromClient: true, blocklist: true });
        await a.removeQueueItem(HASH.toUpperCase(), { removeFromClient: false, blocklist: false });
        expect(ui.sent('core.remove_torrent').map(c => c.params)).toEqual([
            [HASH, true],
            [HASH, false]
        ]);
        expect(a.supportsBlocklist).toBe(false);
    });

    it('fails when libtorrent refuses the removal, and on a torrent Deluge does not have', async () => {
        await expect(
            new DelugeAdapter(config(), webUi({ 'core.remove_torrent': false }).fetchImpl).removeQueueItem(HASH, { removeFromClient: false, blocklist: false })
        ).rejects.toMatchObject({ kind: 'UpstreamError', detail: `Deluge did not remove torrent ${HASH}` });
        const missing = new Error(`InvalidTorrentError: torrent_id ${HASH} not in session.`);
        await expect(
            new DelugeAdapter(config(), webUi({ 'core.remove_torrent': missing }).fetchImpl).removeQueueItem(HASH, { removeFromClient: false, blocklist: false })
        ).rejects.toMatchObject({ kind: 'UpstreamError', detail: expect.stringMatching(/^core\.remove_torrent failed: .*not in session/) });
    });

    it('adds a magnet with the client defaults, and returns its hash', async () => {
        const ui = webUi({ 'core.get_torrent_status': {}, 'core.add_torrent_magnet': HASH.toUpperCase() });
        const uri = `magnet:?xt=urn:btih:${HASH}&dn=Some.Release`;
        expect(await new DelugeAdapter(config(), ui.fetchImpl).addMagnet(uri)).toEqual({ id: HASH, duplicate: false });
        expect(ui.sent('core.add_torrent_magnet').map(c => c.params)).toEqual([[uri, {}]]);
    });

    it('reports a torrent it already has as a duplicate, without adding it again', async () => {
        const ui = webUi({ 'core.get_torrent_status': { name: 'Some.Release' }, 'core.add_torrent_magnet': HASH });
        expect(await new DelugeAdapter(config(), ui.fetchImpl).addMagnet(`magnet:?xt=urn:btih:${HASH}`)).toEqual({
            id: HASH,
            title: '<<untrusted:deluge.name>>Some.Release<</>>',
            duplicate: true
        });
        expect(ui.sent('core.add_torrent_magnet')).toEqual([]);
    });

    it('adds a magnet with no info hash it can read without looking it up, and reports what Deluge leaves out', async () => {
        const ui = webUi({ 'core.get_torrent_status': { name: 'Some.Release' }, 'core.add_torrent_magnet': null });
        expect(await new DelugeAdapter(config(), ui.fetchImpl).addMagnet('magnet:?xt=urn:btmh:1220abcd&dn=Some.Release')).toEqual({ duplicate: false });
        expect(ui.sent('core.get_torrent_status')).toEqual([]);
        const noName = webUi({ 'core.get_torrent_status': { label: 'radarr' } });
        expect(await new DelugeAdapter(config(), noName.fetchImpl).addMagnet(`magnet:?xt=urn:btih:${HASH}`)).toEqual({ id: HASH, duplicate: true });
    });

    it('looks a base32 btih up by its hex hash', async () => {
        const ui = webUi({ 'core.get_torrent_status': {}, 'core.add_torrent_magnet': '0123' });
        await new DelugeAdapter(config(), ui.fetchImpl).addMagnet('magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH');
        expect(ui.sent('core.get_torrent_status')[0]?.params).toEqual(['0123456789abcdef0123456789abcdef01234567', ['name']]);
    });

    it('names the magnet as the problem when Deluge refuses it', async () => {
        const refused = new Error('AddTorrentError: Unable to add magnet, invalid magnet info');
        await expect(
            new DelugeAdapter(config(), webUi({ 'core.get_torrent_status': {}, 'core.add_torrent_magnet': refused }).fetchImpl).addMagnet(
                `magnet:?xt=urn:btih:${HASH}`
            )
        ).rejects.toMatchObject({ kind: 'UpstreamError', remedy: 'Deluge refused the magnet. Check the link is complete.' });
    });
});

describe('DelugeAdapter: failed calls', () => {
    it('fails a call Deluge does not know, naming it', async () => {
        const ui = webUi({ 'core.get_config_values': {} });
        await expect(new DelugeAdapter(config(), ui.fetchImpl).getDiskSpace()).rejects.toMatchObject({
            kind: 'UpstreamError',
            detail: 'core.get_free_space failed: <<untrusted:deluge.error>>Unknown method<</>>'
        });
    });

    it('fails an answer that is not JSON-RPC', async () => {
        const fetchImpl = (async () => jsonResponse(null)) as unknown as typeof fetch;
        await expect(new DelugeAdapter(config(), fetchImpl).getVersion()).rejects.toMatchObject({
            kind: 'UpstreamError',
            detail: 'web.connected answered with no JSON-RPC body'
        });
    });
});
