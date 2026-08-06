import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';

/**
 * The config UI driven through the real Hono app — same routes, same session
 * cookie, same form parsing a browser hits.
 *
 * These use a real temp directory rather than a fake filesystem because the
 * thing most worth testing is that a save reaches disk, survives a reload, and
 * comes back through the loader that the process actually starts from.
 */

const PASSWORD = 'test-password-1234';
const BEARER = 'a'.repeat(64);

let dir: string;
let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let logs: LogStore;
let audit: WriteAudit;

const seed = async (extra = '') => {
    dir = await mkdtemp(join(tmpdir(), 'arr-mcp-ui-'));
    await writeFile(
        join(dir, 'config.yaml'),
        `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${hashPassword(PASSWORD)}\n  allowed_hosts: []\nservices:${extra === '' ? ' {}' : `\n${extra}`}\n`,
        'utf8'
    );

    const { config } = await loadConfig(dir);
    audit = WriteAudit.ephemeral();
    logs = LogStore.ephemeral();
    runtime = Runtime.fromConfig(config, audit, { configDir: dir });
    app = buildApp({ runtime, audit, logs });
};

beforeEach(async () => {
    await seed();
});

afterEach(() => {
    logs.close();
    audit.close();
});

let cookie = '';

const call = async (path: string, opts: RequestInit = {}) => {
    const res = await app.request(`http://localhost:6060${path}`, {
        ...opts,
        headers: { ...(opts.headers ?? {}), ...(cookie === '' ? {} : { cookie }) }
    });
    const set = res.headers.get('set-cookie');
    if (set !== null) cookie = set.split(';')[0] ?? '';
    return res;
};

const form = (body: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
});

const signIn = async () => {
    cookie = '';
    await call('/ui/login', form({ username: 'admin', password: PASSWORD }));
};

const csrfFrom = async (): Promise<string> => {
    const page = await (await call('/ui/config')).text();
    return /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
};

describe('access control', () => {
    it('sends an anonymous visitor to the login page', async () => {
        cookie = '';
        const res = await call('/ui');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/login');
    });

    it('refuses the log API without a session rather than redirecting it', async () => {
        cookie = '';
        expect((await call('/ui/logs.json')).status).toBe(401);
    });

    // An unstyled login page looks broken, and the CSS reveals nothing.
    it('serves the stylesheet without a session', async () => {
        cookie = '';
        const res = await call('/ui/app.css');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/css');
    });

    it('rejects a wrong password', async () => {
        cookie = '';
        expect((await call('/ui/login', form({ username: 'admin', password: 'nope' }))).status).toBe(401);
    });

    it('rejects a wrong username with the same status and message', async () => {
        cookie = '';
        const res = await call('/ui/login', form({ username: 'root', password: PASSWORD }));
        expect(res.status).toBe(401);
        // Naming which half was wrong would confirm valid usernames.
        expect(await res.text()).toContain('Wrong username or password');
    });

    it('signs in and reaches the dashboard', async () => {
        await signIn();
        const res = await call('/ui');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('MCP endpoint');
    });

    it('signs out', async () => {
        await signIn();
        await call('/ui/logout', { method: 'POST' });
        expect((await call('/ui')).status).toBe(302);
    });
});

describe('secrets', () => {
    it('never renders an API key back into the form', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: super-secret-key\n');
        await signIn();

        const page = await (await call('/ui/config')).text();
        expect(page).toContain('192.0.2.10:7878');
        expect(page).not.toContain('super-secret-key');
    });

    it('never renders the password hash', async () => {
        await signIn();
        expect(await (await call('/ui/config')).text()).not.toContain('scrypt$');
    });

    // It is the one secret the UI exists to hand out, so it is shown — but
    // masked until asked for.
    it('shows the bearer token on the dashboard, in a masked field', async () => {
        await signIn();
        const page = await (await call('/ui')).text();
        expect(page).toContain(BEARER);
        expect(page).toContain('type="password"');
    });
});

describe('saving configuration', () => {
    it('refuses a forged CSRF token', async () => {
        await signIn();
        const res = await call('/ui/config', form({ csrf: 'forged', 'svc.radarr.enabled': 'on' }));
        expect(res.status).toBe(403);
    });

    it('refuses a service switched on with no URL', async () => {
        await signIn();
        const res = await call(
            '/ui/config',
            form({ csrf: await csrfFrom(), 'svc.radarr.enabled': 'on', 'svc.radarr.url': '' })
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('no URL');
    });

    it('refuses a service switched on with no API key', async () => {
        await signIn();
        const res = await call(
            '/ui/config',
            form({
                csrf: await csrfFrom(),
                'svc.radarr.enabled': 'on',
                'svc.radarr.url': 'http://192.0.2.10:7878',
                'svc.radarr.api_key': ''
            })
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('no API key');
    });

    it('writes the service to disk', async () => {
        await signIn();
        await call(
            '/ui/config',
            form({
                csrf: await csrfFrom(),
                'svc.radarr.enabled': 'on',
                'svc.radarr.url': 'http://192.0.2.10:7878',
                'svc.radarr.api_key': 'k',
                'svc.radarr.timeout_ms': '4000',
                'auth.username': 'admin'
            })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('192.0.2.10:7878');
        expect(onDisk).toContain('timeout_ms: 4000');
    });

    // The reason hot reload exists: editing config from a web page and then
    // telling the user to restart would be worse than the YAML it replaces.
    it('applies without a restart', async () => {
        await signIn();
        expect(runtime.current.adapters).toHaveLength(0);

        await call(
            '/ui/config',
            form({
                csrf: await csrfFrom(),
                'svc.radarr.enabled': 'on',
                'svc.radarr.url': 'http://192.0.2.10:7878',
                'svc.radarr.api_key': 'k',
                'auth.username': 'admin'
            })
        );

        expect(runtime.current.adapters.map(a => a.id)).toEqual(['radarr']);
    });

    it('keeps an existing key when the field is left blank', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: keep-me\n');
        await signIn();

        await call(
            '/ui/config',
            form({
                csrf: await csrfFrom(),
                'svc.radarr.enabled': 'on',
                'svc.radarr.url': 'http://192.0.2.10:9999',
                'svc.radarr.api_key': '',
                'auth.username': 'admin'
            })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('keep-me');
        expect(onDisk).toContain('192.0.2.10:9999');
    });

    it('removes a service that was switched off', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();

        await call('/ui/config', form({ csrf: await csrfFrom(), 'auth.username': 'admin' }));

        expect(runtime.current.adapters).toHaveLength(0);
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).not.toContain('192.0.2.10');
    });

    it('rotates the bearer token only when asked', async () => {
        await signIn();
        await call('/ui/config', form({ csrf: await csrfFrom(), 'auth.username': 'admin' }));
        expect(runtime.config.auth.bearer_token).toBe(BEARER);

        await call('/ui/config', form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.rotate_token': 'on' }));
        expect(runtime.config.auth.bearer_token).not.toBe(BEARER);
        expect(runtime.config.auth.bearer_token).toMatch(/^[0-9a-f]{64}$/);
    });

    // Rotating from the UI has to take effect on the very next MCP request,
    // or the old token keeps working until a restart.
    it('makes a rotated token effective immediately on /mcp', async () => {
        await signIn();
        await call('/ui/config', form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.rotate_token': 'on' }));

        const res = await app.request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${BEARER}`
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });
        expect(res.status).toBe(401);
    });

    it('changes the password, and the old one stops working', async () => {
        await signIn();
        await call(
            '/ui/config',
            form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.password': 'a-new-password' })
        );

        cookie = '';
        expect((await call('/ui/login', form({ username: 'admin', password: PASSWORD }))).status).toBe(401);
        expect((await call('/ui/login', form({ username: 'admin', password: 'a-new-password' }))).status).toBe(302);
    });

    it('leaves the password alone when the field is blank', async () => {
        await signIn();
        await call('/ui/config', form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.password': '' }));

        cookie = '';
        expect((await call('/ui/login', form({ username: 'admin', password: PASSWORD }))).status).toBe(302);
    });
});

describe('allowed_hosts', () => {
    const get = (host: string) => call('/healthz', { headers: { host } });

    it('accepts any Host when nothing is pinned', async () => {
        expect((await get('192.168.1.50:6060')).status).toBe(200);
    });

    // The whole reason this moved out of the adapter: pinning from the config
    // UI must apply at once, or a security setting appears to have worked when
    // it has not.
    it('applies a pinned host immediately, with no restart', async () => {
        await signIn();
        await call(
            '/ui/config',
            form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.allowed_hosts': 'arr.example.com' })
        );

        expect((await get('arr.example.com')).status).toBe(200);
        expect((await get('evil.example.com')).status).toBe(403);
    });

    // A pinned bare hostname must not stop working because the browser sent a
    // port, which is what every browser does.
    it('matches a pinned bare hostname when the request carries a port', async () => {
        await signIn();
        await call(
            '/ui/config',
            form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.allowed_hosts': 'arr.example.com' })
        );

        expect((await get('arr.example.com:6060')).status).toBe(200);
    });

    /**
     * The lockout the README warns about, demonstrated.
     *
     * Once a host is pinned, the config page is only reachable *through that
     * host* — so the browser you pinned from stops working if you pinned the
     * wrong name. Undoing it therefore has to come from an allowed Host, which
     * is why the second save below sets the header explicitly. From a real
     * browser with no matching name, the only way back is editing config.yaml.
     */
    it('locks out an unlisted host, and can be undone from a listed one', async () => {
        await signIn();
        await call(
            '/ui/config',
            form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.allowed_hosts': 'arr.example.com' })
        );
        expect((await get('other.example.com')).status).toBe(403);

        // Even the config page itself is unreachable from an unlisted host.
        expect((await call('/ui/config', { headers: { host: 'other.example.com' } })).status).toBe(403);

        const page = await (await call('/ui/config', { headers: { host: 'arr.example.com' } })).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
        await call('/ui/config', {
            ...form({ csrf, 'auth.username': 'admin', 'auth.allowed_hosts': '' }),
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                host: 'arr.example.com'
            }
        });

        expect((await get('other.example.com')).status).toBe(200);
    });
});

describe('logs and audit', () => {
    it('serves log rows as JSON', async () => {
        logs.write(JSON.stringify({ level: 30, time: Date.now(), msg: 'hello', service: 'radarr' }));
        await signIn();

        const body = (await (await call('/ui/logs.json')).json()) as { rows: { msg: string }[] };
        expect(body.rows.some(r => r.msg === 'hello')).toBe(true);
    });

    const seedLogs = () => {
        logs.write(JSON.stringify({ level: 30, time: Date.now(), msg: 'radarr-info', service: 'radarr' }));
        logs.write(JSON.stringify({ level: 30, time: Date.now(), msg: 'sonarr-info', service: 'sonarr' }));
        logs.write(JSON.stringify({ level: 50, time: Date.now(), msg: 'sonarr-error', service: 'sonarr' }));
    };

    const streamRows = async (query: string): Promise<string[]> => {
        const body = (await (await call(`/ui/logs.json${query}`)).json()) as { rows: { msg: string }[] };
        return body.rows.map(r => r.msg).sort();
    };

    // The three streams `logger.ts` has promised since Phase 1.
    it('the "all" stream returns everything', async () => {
        seedLogs();
        await signIn();
        expect(await streamRows('?stream=all')).toEqual(['radarr-info', 'sonarr-error', 'sonarr-info']);
    });

    it('the "problems" stream returns only warnings and errors', async () => {
        seedLogs();
        await signIn();
        expect(await streamRows('?stream=problems')).toEqual(['sonarr-error']);
    });

    it('the "by service" stream returns one service at every level', async () => {
        seedLogs();
        await signIn();
        expect(await streamRows('?stream=service&service=sonarr')).toEqual(['sonarr-error', 'sonarr-info']);
    });

    // Picking a service and then switching to Problems must not keep filtering.
    it('ignores a service on a stream that is not the by-service one', async () => {
        seedLogs();
        await signIn();
        expect(await streamRows('?stream=all&service=sonarr')).toHaveLength(3);
    });

    it('falls back to the first service that logged, so the tab is never blank', async () => {
        seedLogs();
        await signIn();
        expect(await streamRows('?stream=service')).toEqual(['radarr-info']);
    });

    it('falls back to the all stream when asked for one that does not exist', async () => {
        seedLogs();
        await signIn();
        expect(await streamRows('?stream=nonsense')).toHaveLength(3);
    });

    it('ignores a service filter that is not a real service id', async () => {
        seedLogs();
        await signIn();
        const rows = await streamRows('?stream=service&service=%27%20OR%201=1--');
        // Falls back to the first real service rather than reaching the store.
        expect(rows).toEqual(['radarr-info']);
    });

    it('renders the audit page', async () => {
        await signIn();
        const res = await call('/ui/audit');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('Write audit');
    });
});
