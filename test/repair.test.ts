import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, validateConfigText } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword, Sessions } from '../src/core/session.ts';
import { repairPage, unreadableAuthPage } from '../src/web/repairPage.ts';
import { ConfigInvalidError } from '../src/config/load.ts';
import { buildRepairApp } from '../src/repair.ts';
import type { Config } from '../src/config/schema.ts';

const BEARER = 'a'.repeat(64);

const seedDir = async (text: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-repair-'));
    await writeFile(join(dir, 'config.yaml'), text, 'utf8');
    return dir;
};

describe('Runtime session injection', () => {
    it('uses the Sessions instance it is given, so a token survives a rebuild', async () => {
        const dir = await seedDir(
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices: {}\n`
        );
        const audit = WriteAudit.ephemeral();
        const sessions = new Sessions();
        const token = sessions.issue();

        const { runtime } = await Runtime.start(dir, audit, { sessions });

        expect(runtime.sessions).toBe(sessions);
        expect(runtime.sessions.verify(token).valid).toBe(true);
        audit.close();
    });

    it('still builds its own when none is given', async () => {
        const dir = await seedDir(
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices: {}\n`
        );
        const audit = WriteAudit.ephemeral();
        const { config } = await loadConfig(dir);
        const runtime = Runtime.fromConfig(config, audit, { configDir: dir });

        expect(runtime.sessions).toBeInstanceOf(Sessions);
        audit.close();
    });
});

describe('repair pages', () => {
    const detail = 'services.radarr.url\n  ✖ must be an http:// or https:// URL';

    it('renders the error and the file in an editable form', () => {
        const page = repairPage({ version: '1.2.3', raw: 'auth:\n  username: admin\n', detail, csrf: 'tok' });
        expect(page).toContain('must be an http');
        expect(page).toContain('<textarea');
        expect(page).toContain('name="config"');
        expect(page).toContain('value="tok"');
    });

    it('escapes the file rather than injecting it into the document', () => {
        const page = repairPage({ version: '1.2.3', raw: 'note: </textarea><script>x()</script>', detail, csrf: 'tok' });
        expect(page).not.toContain('<script>x()</script>');
        expect(page).toContain('&lt;/textarea&gt;');
    });

    // The page is the operator's only route back in, so a nav bar of links to
    // pages that do not exist in this mode would be a lie.
    it('renders no navigation', () => {
        expect(repairPage({ version: '1.2.3', raw: '', detail, csrf: 'tok' })).not.toContain('<nav>');
    });

    it('shows the error alone when auth is unreadable, with no way to submit', () => {
        const page = unreadableAuthPage({ version: '1.2.3', detail: 'auth\n  ✖ Invalid input' });
        expect(page).toContain('Invalid input');
        expect(page).not.toContain('<textarea');
        expect(page).not.toContain('<form');
    });
});

const AUTH_OK: Config['auth'] = {
    bearer_token: BEARER,
    username: 'admin',
    allow_token_in_url: false,
    allowed_hosts: []
};

const repairApp = async (opts: { auth: Config['auth'] | undefined; raw?: string }) => {
    const dir = await seedDir(opts.raw ?? 'auth: {}\n');
    return buildRepairApp({
        configDir: dir,
        sessions: new Sessions(),
        version: '1.2.3',
        failure: new ConfigInvalidError('services.radarr.url\n  ✖ bad', opts.raw ?? 'auth: {}\n', opts.auth),
        onPromote: async () => ({ ok: true })
    });
};

const get = (app: Awaited<ReturnType<typeof repairApp>>, path: string, init: RequestInit = {}) =>
    app.request(`http://localhost:6060${path}`, init);

describe('repair server, always-on routes', () => {
    it('reports degraded health with a 200, so the container is not restart-looped', async () => {
        const res = await get(await repairApp({ auth: AUTH_OK }), '/healthz');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; reason: string };
        expect(body.status).toBe('degraded');
        expect(body.reason).toContain('services.radarr.url');
    });

    // 503 not 404: a client that gets 404 goes looking for the wrong URL.
    it('refuses /mcp with 503 and the reason', async () => {
        const res = await get(await repairApp({ auth: AUTH_OK }), '/mcp', { method: 'POST' });
        expect(res.status).toBe(503);
        expect(JSON.stringify(await res.json())).toContain('services.radarr.url');
    });

    // Both posts here are unauthenticated, and an OOM in this mode takes away
    // the operator's only route back to a working instance.
    it('refuses a body over the limit before parsing it', async () => {
        const res = await get(await repairApp({ auth: AUTH_OK }), '/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `username=${'x'.repeat(5 * 1024 * 1024)}`
        });
        expect(res.status).toBe(413);
    });

    it('serves the stylesheet, so the page is not unstyled', async () => {
        const res = await get(await repairApp({ auth: AUTH_OK }), '/ui/app.css');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/css');
    });
});

// A YAML syntax error is the case that reaches all three of these at once:
// unparseable YAML means no `auth` block, so the read-only page is what
// renders, and none of the three sits behind a session or the Host allowlist.
describe('repair server, unauthenticated surfaces', () => {
    const SECRET = 'MY-SUPER-SECRET';
    const BROKEN = `auth:\n  bearer_token: ${BEARER}\n  api_key: ${SECRET}: oops\n`;

    const leaky = async () => {
        const verdict = validateConfigText(BROKEN);
        expect(verdict.ok).toBe(false);
        if (verdict.ok) throw new Error('unreachable');
        const dir = await seedDir(BROKEN);
        return buildRepairApp({
            configDir: dir,
            sessions: new Sessions(),
            version: '1.2.3',
            failure: new ConfigInvalidError(verdict.detail, BROKEN, verdict.auth),
            onPromote: async () => ({ ok: true })
        });
    };

    it('locates the error on /healthz without repeating the line', async () => {
        const res = await get(await leaky(), '/healthz');
        const body = await res.text();
        expect(body).toContain('line 3');
        expect(body).not.toContain(SECRET);
    });

    it('locates the error on /mcp without repeating the line', async () => {
        const res = await get(await leaky(), '/mcp', { method: 'POST' });
        expect(res.status).toBe(503);
        const body = await res.text();
        expect(body).toContain('line 3');
        expect(body).not.toContain(SECRET);
    });

    it('locates the error on the read-only page without repeating the line', async () => {
        const res = await get(await leaky(), '/ui/repair');
        expect(res.status).toBe(503);
        const page = await res.text();
        expect(page).not.toContain('<textarea');
        expect(page).toContain('line 3');
        expect(page).not.toContain(SECRET);
    });
});

describe('repair server with an unreadable auth block', () => {
    it('renders the read-only page instead of the editor', async () => {
        const res = await get(await repairApp({ auth: undefined }), '/ui/repair');
        expect(res.status).toBe(503);
        const page = await res.text();
        expect(page).not.toContain('<textarea');
    });

    // The regression that matters most: falling back to setup here would let
    // anyone claim the instance by corrupting its config.
    it('never offers the setup page', async () => {
        const page = await (await get(await repairApp({ auth: undefined }), '/ui/setup')).text();
        expect(page).not.toContain('Claim this instance');
    });

    it('accepts no POST on any path', async () => {
        const app = await repairApp({ auth: undefined });
        for (const path of ['/ui/setup', '/ui/login', '/ui/repair']) {
            const res = await get(app, path, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'username=x&password=abcdefghijkl&confirm=abcdefghijkl'
            });
            expect(res.status).toBe(503);
            expect(await res.text()).not.toContain('<textarea');
        }
    });

    it('still serves health and the stylesheet', async () => {
        const app = await repairApp({ auth: undefined });
        expect((await get(app, '/healthz')).status).toBe(200);
        expect((await get(app, '/ui/app.css')).status).toBe(200);
    });
});

const PASSWORD = 'test-password-1234';

describe('repair server sign-in', () => {
    const claimed = async () =>
        repairApp({ auth: { ...AUTH_OK, password_hash: await hashPassword(PASSWORD) } });

    it('sends an anonymous visitor to the login page', async () => {
        const res = await get(await claimed(), '/ui/repair');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/login');
    });

    it('sends an anonymous visitor to setup when nobody has claimed the instance', async () => {
        const res = await get(await repairApp({ auth: AUTH_OK }), '/ui/repair');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/setup');
    });

    it('renders the editor after a correct sign-in', async () => {
        const app = await claimed();
        const login = await get(app, '/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: PASSWORD }).toString()
        });
        expect(login.status).toBe(302);
        const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
        expect(cookie).not.toBe('');

        const page = await get(app, '/ui/repair', { headers: { cookie } });
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('<textarea');
        expect(page.headers.get('cache-control')).toBe('no-store');
    });

    it('refuses a wrong password', async () => {
        const res = await get(await claimed(), '/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: 'wrong-password' }).toString()
        });
        expect(res.status).toBe(401);
    });

    // Claiming fixes the credential, not the config, so it lands on the editor.
    it('claims an unclaimed instance and lands on the editor', async () => {
        const app = await repairApp({
            auth: AUTH_OK,
            raw: `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices:\n  radarr:\n    url: bad\n`
        });
        const res = await get(app, '/ui/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                username: 'admin',
                password: PASSWORD,
                confirm: PASSWORD
            }).toString()
        });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/repair');

        const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
        const page = await get(app, '/ui/repair', { headers: { cookie } });
        expect(await page.text()).toContain('<textarea');
    });

    it('refuses a cross-origin claim', async () => {
        const res = await get(await repairApp({ auth: AUTH_OK }), '/ui/setup', {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                origin: 'http://evil.example'
            },
            body: new URLSearchParams({
                username: 'admin',
                password: PASSWORD,
                confirm: PASSWORD
            }).toString()
        });
        expect(res.status).toBe(403);
    });

    it('sends an unknown path to the editor', async () => {
        const res = await get(await claimed(), '/ui/logs');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/repair');
    });

    // A pinned host is a security setting the operator chose, and it parsed —
    // a wrong value never reaches this mode, because it is not a schema error.
    it('honours a pinned allowed_hosts', async () => {
        const app = await repairApp({ auth: { ...AUTH_OK, allowed_hosts: ['arr.example.com'] } });
        expect((await get(app, '/ui/repair', { headers: { host: 'evil.example' } })).status).toBe(403);
        expect((await get(app, '/ui/repair', { headers: { host: 'arr.example.com:6060' } })).status).toBe(302);
    });

    it('leaves health reachable on any host, so the container healthcheck still works', async () => {
        const app = await repairApp({ auth: { ...AUTH_OK, allowed_hosts: ['arr.example.com'] } });
        expect((await get(app, '/healthz', { headers: { host: 'localhost:6060' } })).status).toBe(200);
    });

    it('lets only one of two concurrent claims win', async () => {
        const raw = `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices:\n  radarr:\n    url: bad\n`;
        const dir = await seedDir(raw);
        const app = buildRepairApp({
            configDir: dir,
            sessions: new Sessions(),
            version: '1.2.3',
            failure: new ConfigInvalidError('services.radarr.url\n  ✖ bad', raw, AUTH_OK),
            onPromote: async () => ({ ok: true })
        });

        const post = () =>
            get(app, '/ui/setup', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ username: 'admin', password: PASSWORD, confirm: PASSWORD }).toString()
            });

        const [a, b] = await Promise.all([post(), post()]);
        expect(a.status).toBe(302);
        expect(b.status).toBe(302);
        const locations = [a.headers.get('location'), b.headers.get('location')];
        expect(locations).toContain('/ui/repair');
        expect(locations).toContain('/ui/login');

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect((onDisk.match(/password_hash/g) ?? []).length).toBe(1);
    });

    // The claim must land on disk, and it must not clobber a fix the operator
    // made directly to config.yaml while the server was up — the failure this
    // server exists to survive is exactly the kind an editor fixes in place.
    it('keeps an operator\'s on-disk edit when claiming, rather than reverting to the startup snapshot', async () => {
        const staleRaw = `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices:\n  radarr:\n    url: bad\n`;
        const dir = await seedDir(staleRaw);
        const app = buildRepairApp({
            configDir: dir,
            sessions: new Sessions(),
            version: '1.2.3',
            failure: new ConfigInvalidError('services.radarr.url\n  ✖ bad', staleRaw, AUTH_OK),
            onPromote: async () => ({ ok: true })
        });

        // The operator fixes the file directly while the server is still up.
        const fixedRaw = `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices:\n  radarr:\n    url: http://radarr.example.com\n`;
        await writeFile(join(dir, 'config.yaml'), fixedRaw, 'utf8');

        const res = await get(app, '/ui/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: PASSWORD, confirm: PASSWORD }).toString()
        });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/repair');

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('http://radarr.example.com');
        expect(onDisk).toContain('password_hash');
    });

    // A disk edit that changes auth's shape entirely (not just its content) is
    // the case setIn cannot walk, distinct from the write-failure case the
    // catch is deliberately not scoped to cover.
    it('refuses a claim when auth on disk is no longer a mapping setIn can walk', async () => {
        const staleRaw = `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices:\n  radarr:\n    url: bad\n`;
        const dir = await seedDir(staleRaw);
        const app = buildRepairApp({
            configDir: dir,
            sessions: new Sessions(),
            version: '1.2.3',
            failure: new ConfigInvalidError('services.radarr.url\n  ✖ bad', staleRaw, AUTH_OK),
            onPromote: async () => ({ ok: true })
        });

        await writeFile(join(dir, 'config.yaml'), 'auth: nope\nservices:\n  radarr:\n    url: bad\n', 'utf8');

        const res = await get(app, '/ui/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: PASSWORD, confirm: PASSWORD }).toString()
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('changed on disk');
        expect(res.headers.get('set-cookie')).toBeNull();
    });
});

describe('repair server save', () => {
    const VALID = `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: PLACEHOLDER\n  allowed_hosts: []\nservices: {}\n`;

    const signedIn = async (onPromote: () => Promise<{ ok: true } | { ok: false; detail: string }>) => {
        const hash = await hashPassword(PASSWORD);
        const dir = await seedDir('auth: {}\n');
        const app = buildRepairApp({
            configDir: dir,
            sessions: new Sessions(),
            version: '1.2.3',
            failure: new ConfigInvalidError('services.radarr.url\n  ✖ bad', 'auth: {}\n', {
                ...AUTH_OK,
                password_hash: hash
            }),
            onPromote
        });
        const login = await get(app, '/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: PASSWORD }).toString()
        });
        const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
        const page = await (await get(app, '/ui/repair', { headers: { cookie } })).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
        return { app, dir, cookie, csrf };
    };

    const save = (
        ctx: Awaited<ReturnType<typeof signedIn>>,
        config: string
    ) =>
        get(ctx.app, '/ui/repair', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ctx.cookie },
            body: new URLSearchParams({ csrf: ctx.csrf, config }).toString()
        });

    it('re-renders the new error and keeps what was typed, without writing', async () => {
        const ctx = await signedIn(async () => ({ ok: true }));
        // The marker is not part of the YAML error message itself, so finding
        // it in the page proves the typed text was rendered, not just the error.
        const res = await save(ctx, '# keep-this-marker\nauth: [unclosed\n');
        expect(res.status).toBe(400);
        const page = await res.text();
        expect(page).toContain('not valid YAML');
        expect(page).toContain('keep-this-marker');
        expect(await readFile(join(ctx.dir, 'config.yaml'), 'utf8')).toBe('auth: {}\n');
    });

    it('writes the file and promotes on valid text', async () => {
        let promoted = 0;
        const ctx = await signedIn(async () => {
            promoted += 1;
            return { ok: true };
        });
        const hash = await hashPassword(PASSWORD);
        const res = await save(ctx, VALID.replace('PLACEHOLDER', hash));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui');
        expect(promoted).toBe(1);
        expect(await readFile(join(ctx.dir, 'config.yaml'), 'utf8')).toContain('bearer_token');
    });

    // The validator gives a good message; loadConfig is the authority. If they
    // ever disagree the result must be a worse message, not a broken instance.
    it('stays degraded when promotion rejects what the validator accepted', async () => {
        const ctx = await signedIn(async () => ({ ok: false, detail: 'loader said no' }));
        const hash = await hashPassword(PASSWORD);
        const res = await save(ctx, VALID.replace('PLACEHOLDER', hash));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('loader said no');
    });

    it('refuses a save with a bad CSRF token', async () => {
        const ctx = await signedIn(async () => ({ ok: true }));
        const res = await get(ctx.app, '/ui/repair', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ctx.cookie },
            body: new URLSearchParams({ csrf: 'wrong', config: 'services: {}\n' }).toString()
        });
        expect(res.status).toBe(403);
    });

    it('refuses a save with no session', async () => {
        const ctx = await signedIn(async () => ({ ok: true }));
        const res = await get(ctx.app, '/ui/repair', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf: ctx.csrf, config: 'services: {}\n' }).toString()
        });
        expect(res.status).toBe(302);
        // Distinguishes the route's own redirect (to entry()) from the
        // catch-all's redirect to /ui/repair, which would also answer 302.
        expect(res.headers.get('location')).toBe('/ui/login');
    });
});

describe('promotion', () => {
    // The cookie must survive the swap, or a save lands the operator on a
    // login page having just typed their password.
    it('hands over an app that serves /ui to the session issued before the save', async () => {
        const hash = await hashPassword(PASSWORD);
        const dir = await seedDir(
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${hash}\n  allowed_hosts: []\nservices: {}\n`
        );
        const audit = WriteAudit.ephemeral();
        const logs = LogStore.ephemeral();
        const sessions = new Sessions();

        let live = buildRepairApp({
            configDir: dir,
            sessions,
            version: '1.2.3',
            failure: new ConfigInvalidError('bad', 'auth: {}\n', { ...AUTH_OK, password_hash: hash }),
            onPromote: async () => {
                const { runtime } = await Runtime.start(dir, audit, { sessions });
                live = buildApp({ runtime, audit, logs });
                return { ok: true };
            }
        });

        const login = await live.request('http://localhost:6060/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: PASSWORD }).toString()
        });
        const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

        const page = await (await live.request('http://localhost:6060/ui/repair', { headers: { cookie } })).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';

        const saved = await live.request('http://localhost:6060/ui/repair', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
            body: new URLSearchParams({
                csrf,
                config: `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${hash}\n  allowed_hosts: []\nservices: {}\n`
            }).toString()
        });
        expect(saved.status).toBe(302);

        const dashboard = await live.request('http://localhost:6060/ui', { headers: { cookie } });
        expect(dashboard.status).toBe(200);

        logs.close();
        audit.close();
    });
});
