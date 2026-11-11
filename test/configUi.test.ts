import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { FREE_ATTEMPTS } from '../src/core/loginThrottle.ts';
import { Runtime } from '../src/core/runtime.ts';
import { attachLogStore, detachLogStore, logger } from '../src/core/logger.ts';
import { hashPassword } from '../src/core/session.ts';
import * as session from '../src/core/session.ts';
import { hashToken } from '../src/core/secrets.ts';
import { CONFIG_TABS, configTabForPost } from '../src/web/configPage.ts';
import { isLoopbackHost } from '../src/web/jwksProbe.ts';
import { buildMcpConfig } from '../src/web/routes.ts';

/**
 * The config UI driven through the real Hono app — same routes, same session
 * cookie, same form parsing a browser hits.
 *
 * These use a real temp directory rather than a fake filesystem because the
 * thing most worth testing is that a save reaches disk, survives a reload, and
 * comes back through the loader that the process actually starts from.
 */

const PASSWORD = 'test-password-1234';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const BEARER = 'a'.repeat(64);

let dir: string;
let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let logs: LogStore;
let audit: WriteAudit;

/**
 * The same fixture as `seed`, minus `password_hash` — an *unclaimed* instance,
 * which is what a fresh install looks like before anyone visits it.
 *
 * `release` comes first because `beforeEach` has already opened a claimed
 * fixture by the time this runs.
 */
const seedUnclaimed = async () => {
    await release();

    dir = await mkdtemp(join(tmpdir(), 'arr-mcp-ui-'));
    await writeFile(
        join(dir, 'config.yaml'),
        `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices: {}\n`,
        'utf8'
    );

    const { config } = await loadConfig(dir);
    audit = WriteAudit.ephemeral();
    logs = LogStore.ephemeral();
    runtime = Runtime.fromConfig(config, audit, { configDir: dir });
    app = buildApp({ runtime, audit, logs });
    seeded = true;
};

let seeded = false;

/** Closes the stores and removes the temp dir. Safe to call twice. */
const release = async () => {
    if (!seeded) return;
    seeded = false;
    runtime.dataset?.close();
    logs.close();
    audit.close();
    await rm(dir, { recursive: true, force: true });
};

const seed = async (extra = '', authExtra = '') => {
    await release();
    dir = await mkdtemp(join(tmpdir(), 'arr-mcp-ui-'));
    await writeFile(
        join(dir, 'config.yaml'),
        `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${PASSWORD_HASH}\n  allowed_hosts: []\n${authExtra}services:${extra === '' ? ' {}' : `\n${extra}`}\n`,
        'utf8'
    );

    const { config } = await loadConfig(dir);
    audit = WriteAudit.ephemeral();
    logs = LogStore.ephemeral();
    runtime = Runtime.fromConfig(config, audit, { configDir: dir });
    app = buildApp({ runtime, audit, logs });
    seeded = true;
};

beforeEach(async () => {
    await seed();
});

afterEach(async () => {
    await release();
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

/**
 * The whole configuration, across its tabs. Reading one tab would let every
 * "does not contain" below pass only because the card is on another tab.
 */
const everyConfigTab = async (): Promise<string> =>
    (await Promise.all(CONFIG_TABS.map(async t => (await call(`/ui/config?tab=${t.key}`)).text()))).join('\n');

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

// Both from one page load, as a browser's form would carry them.
const keysFrom = (page: string): { csrf: string; etag: string } => ({
    csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '',
    etag: (/name="etag" value="([^"]+)"/.exec(page)?.[1] ?? '').replaceAll('&quot;', '"')
});

describe('staying signed in', () => {
    const HOUR = 60 * 60 * 1000;
    let time = 0;

    /** The same fixture, with a clock the test can move. */
    const seedWithClock = async () => {
        const { config } = await loadConfig(dir);
        time = 1_000_000;
        runtime = Runtime.fromConfig(config, audit, {
            configDir: dir,
            sessions: new session.Sessions({ now: () => time })
        });
        app = buildApp({ runtime, audit, logs });
        await signIn();
    };

    const bare = (path: string, sessionCookie: string) =>
        app.request(`http://localhost:6060${path}`, { headers: { cookie: sessionCookie } });

    it('renews the cookie on a page load once it is over an hour old, for the full window', async () => {
        await seedWithClock();
        time += 2 * HOUR;
        const res = await bare('/ui/config', cookie);
        expect(res.status).toBe(200);
        const set = res.headers.get('set-cookie') ?? '';
        expect(set).toContain(`Max-Age=${Math.floor(session.SESSION_TTL_MS / 1000)}`);
        expect(set).toContain('HttpOnly');
        expect(set).toContain('SameSite=Strict');
    });

    it('sets nothing on a page load inside the hour', async () => {
        await seedWithClock();
        time += HOUR - 1;
        expect((await bare('/ui/config', cookie)).headers.get('set-cookie')).toBeNull();
    });

    // An open Logs tab polls every four seconds, and would otherwise keep a
    // forgotten browser signed in for good.
    it('does not count background polling or assets as coming back', async () => {
        await seedWithClock();
        time += 2 * HOUR;
        expect((await bare('/ui/logs.json', cookie)).headers.get('set-cookie')).toBeNull();
        expect((await bare('/ui/app.css', cookie)).headers.get('set-cookie')).toBeNull();
    });

    it('lets someone who keeps visiting stay signed in past the window', async () => {
        await seedWithClock();
        for (let visit = 0; visit < 4; visit++) {
            time += session.SESSION_TTL_MS - HOUR;
            expect((await call('/ui/config')).status).toBe(200);
        }
    });

    it('signs out someone who stays away for the whole window', async () => {
        await seedWithClock();
        time += session.SESSION_TTL_MS;
        const res = await call('/ui/config');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/login');
    });

    it('accepts a form from before the renewal', async () => {
        await seedWithClock();
        const csrf = await csrfFrom();
        time += 2 * HOUR;
        await call('/ui/config');
        const res = await call('/ui/logout', form({ csrf }));
        expect(res.headers.get('location')).toBe('/ui/login');
        expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('does not let a renewal bring back the cookie sign-out just cleared', async () => {
        await seedWithClock();
        const csrf = await csrfFrom();
        const before = cookie;
        time += 2 * HOUR;
        await call('/ui/logout', form({ csrf }));
        expect((await bare('/ui/config', before)).headers.get('location')).toBe('/ui/login');
    });

    it('does not renew on an instance with no password, whatever cookie it is sent', async () => {
        await seedWithClock();
        const before = cookie;
        await seedUnclaimed();
        expect((await bare('/ui/setup', before)).headers.get('set-cookie')).toBeNull();
    });

    it('ends the session when config.yaml changes the password by hand and is reloaded', async () => {
        await seedWithClock();
        const text = await readFile(join(dir, 'config.yaml'), 'utf8');
        await writeFile(join(dir, 'config.yaml'), text.replace(PASSWORD_HASH, await hashPassword('another-password-1')), 'utf8');
        await runtime.reload();
        expect((await call('/ui/config')).headers.get('location')).toBe('/ui/login');
    });
});

describe('access control', () => {
    it('sends an anonymous visitor to the login page', async () => {
        cookie = '';
        const res = await call('/ui');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/login');
    });

    it('treats an undecodable session cookie as signed out rather than failing', async () => {
        cookie = 'arr_mcp_session=%E0%A4';
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

    // A browser asks for the favicon before anyone has signed in, and a
    // redirect to the login page in its place is a broken tab icon.
    it('serves the mark without a session, and the page points at it', async () => {
        cookie = '';
        const icon = await call('/ui/icon.svg');
        expect(icon.status).toBe(200);
        expect(icon.headers.get('content-type')).toContain('image/svg+xml');
        expect(await icon.text()).toMatch(/^<svg/);

        expect(await (await call('/ui/login')).text()).toContain('rel="icon" type="image/svg+xml"');
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

    // The username field routinely catches a password typed into the wrong
    // box, and this record is rendered at /ui/logs and in `docker logs`.
    //
    // `attachLogStore` is what routes logger output into the store — without
    // it `recent()` is empty and the assertion below cannot fail, which is how
    // this test first passed against the unfixed route.
    it('does not log the attempted username when a sign-in is rejected', async () => {
        cookie = '';
        const typo = 'hunter2-typed-in-the-wrong-box';

        attachLogStore(logs);
        try {
            await call('/ui/login', form({ username: typo, password: 'nope' }));
        } finally {
            detachLogStore();
        }

        const written = JSON.stringify(logs.recent({ limit: 50 }));
        expect(written).toContain('rejected config UI sign-in'); // the premise: the store saw it
        expect(written).not.toContain(typo);
    });

    // The clock is frozen because the block only lasts a second, and each POST
    // runs a deliberate scrypt hash: under full-suite load one has been measured
    // at 1096ms, which expires the block before the next request arrives. Frozen,
    // this asserts the throttle's logic rather than the machine's speed.
    it('blocks sign-in after repeated failures, and says so', async () => {
        cookie = '';
        vi.useFakeTimers({ toFake: ['Date'] });

        try {
            for (let i = 0; i < FREE_ATTEMPTS; i++) {
                const res = await call('/ui/login', form({ username: 'admin', password: 'wrong' }));
                expect(res.status).toBe(401);
            }

            const blocked = await call('/ui/login', form({ username: 'admin', password: 'wrong' }));
            expect(blocked.status).toBe(429);
            expect(blocked.headers.get('retry-after')).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('marks the session cookie Secure only when the page was reached over https', async () => {
        const right = form({ username: 'admin', password: PASSWORD });
        cookie = '';
        const plain = await call('/ui/login', right);
        expect(plain.headers.get('set-cookie')).not.toContain('Secure');

        cookie = '';
        const proxied = await call('/ui/login', {
            ...right,
            headers: { ...right.headers, 'x-forwarded-proto': 'https' }
        });
        expect(proxied.headers.get('set-cookie')).toContain('Secure');
    });

    it('blocks a proxied burst without blocking a direct sign-in', async () => {
        cookie = '';
        vi.useFakeTimers({ toFake: ['Date'] });

        try {
            const wrong = form({ username: 'admin', password: 'wrong' });
            const forwarded = { ...wrong, headers: { ...wrong.headers, 'x-forwarded-for': '203.0.113.9' } };
            for (let i = 0; i < FREE_ATTEMPTS; i++) await call('/ui/login', forwarded);
            const blocked = await call('/ui/login', forwarded);
            expect(blocked.status).toBe(429);

            const direct = await call('/ui/login', wrong);
            expect(direct.status).toBe(401);
        } finally {
            vi.useRealTimers();
        }
    });

    // Regression guard for the race the throttle exists to close: a burst of
    // concurrent posts all read `blockedFor() === 0` before any of them
    // resolves `verifyPassword`, so the reservation has to happen ahead of
    // that await or the free-attempt count bounds nothing under concurrency.
    it('reserves an attempt before verifying, so a concurrent burst cannot outrun the throttle', async () => {
        cookie = '';
        const spy = vi.spyOn(session, 'verifyPassword');
        try {
            const total = FREE_ATTEMPTS + 5;
            await Promise.all(
                Array.from({ length: total }, () =>
                    call('/ui/login', form({ username: 'admin', password: 'wrong' }))
                )
            );
            expect(spy.mock.calls.length).toBeLessThanOrEqual(FREE_ATTEMPTS);
        } finally {
            spy.mockRestore();
        }
    });

    it('does not reveal which field was wrong', async () => {
        cookie = '';

        const badUser = await call('/ui/login', form({ username: 'nobody', password: 'wrong' }));
        const badPass = await call('/ui/login', form({ username: 'admin', password: 'wrong' }));

        expect(badUser.status).toBe(badPass.status);
        expect(await badUser.text()).toBe(await badPass.text());
    });

    it('signs in and reaches the dashboard', async () => {
        await signIn();
        const res = await call('/ui');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('MCP endpoint');
    });

    it('builds the dashboard without the full-detail reads', async () => {
        const realFetch = globalThis.fetch;
        const paths: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            paths.push(new URL(String(input)).pathname);
            return new Response('{}', { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        try {
            await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
            await signIn();

            expect((await call('/ui')).status).toBe(200);
        } finally {
            globalThis.fetch = realFetch;
        }

        expect(paths.filter(p => p.includes('/api/v3/log') || p.includes('/api/v3/qualityprofile'))).toEqual([]);
    });

    it('signs out', async () => {
        await signIn();
        await call('/ui/logout', form({ csrf: await csrfFrom() }));
        expect((await call('/ui')).status).toBe(302);
    });
});

describe('secrets', () => {
    it('never renders an API key back into the form', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: super-secret-key\n');
        await signIn();

        const page = await everyConfigTab();
        expect(page).toContain('192.0.2.10:7878');
        expect(page).not.toContain('super-secret-key');
    });

    it('never renders the password hash', async () => {
        await signIn();
        expect(await everyConfigTab()).not.toContain('scrypt$');
    });

    it('never renders an MCP token on the dashboard', async () => {
        await signIn();
        const page = await (await call('/ui')).text();
        expect(page).not.toContain(BEARER);
        expect(page).not.toContain('id="bearer"');
    });
});

/**
 * Every field on this page already carried `autocomplete="off"`, and it made no
 * difference: a card is a form holding a URL text input followed by a password
 * input, which is exactly what browsers and manager extensions recognise as a
 * login form — so on every load the URL field was overwritten with the saved
 * username and the key field with the saved password. `autocomplete="off"` is
 * ignored for credential fields on purpose, by all of them.
 *
 * The fix is structural rather than a request: this page has no password input
 * for anything to recognise. These tests are the guard on that.
 */
describe('password managers', () => {
    const BOTH_KINDS =
        '  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n' +
        '  transmission:\n    url: http://192.0.2.11:9091\n    username: t\n    password: p\n';

    it('renders no password input anywhere on the configuration page', async () => {
        await seed(BOTH_KINDS);
        await signIn();

        expect(await everyConfigTab()).not.toContain('type="password"');
    });

    it('masks the secret fields all the same', async () => {
        await seed(BOTH_KINDS);
        await signIn();
        const page = await everyConfigTab();

        for (const name of ['api_key', 'password', 'auth.password']) {
            expect(page).toMatch(new RegExp(`class="secret"[^>]*name="${name.replace('.', '\\.')}"`));
        }
    });

    it('opts every field out for the managers that honour an attribute', async () => {
        await seed(BOTH_KINDS);
        await signIn();
        const page = await everyConfigTab();

        for (const attr of ['data-1p-ignore', 'data-lpignore="true"', 'data-bwignore', 'data-protonpass-ignore']) {
            expect(page).toContain(attr);
        }
        // Dashlane reads it off the form, so it has to be there too.
        expect(page).toContain('data-form-type="other"');
    });

    /** The one form on the site a manager *should* fill, left alone. */
    it('leaves the sign-in form fillable', async () => {
        cookie = '';
        const page = await (await call('/ui/login')).text();

        expect(page).toContain('autocomplete="current-password"');
        expect(page).toContain('type="password"');
    });
});

describe('MCP endpoint', () => {
    it('shows the endpoint built from the host the browser reached it on', async () => {
        await signIn();
        expect(await (await call('/ui')).text()).toContain('http://localhost:6060/mcp');
    });

    it('renders an https endpoint behind a TLS-terminating proxy', async () => {
        await signIn();
        const page = await (await call('/ui', { headers: { 'x-forwarded-proto': 'https' } })).text();
        expect(page).toContain('https://localhost:6060/mcp');
        expect(page).not.toContain('http://localhost:6060/mcp');
    });

    it('has no client config or token buttons on the dashboard', async () => {
        await signIn();
        const page = await (await call('/ui')).text();
        expect(page).not.toContain('data-copy-config');
        expect(page).not.toContain('id="mcp-config"');
        expect(page).not.toContain('data-copy-url-token');
    });
});

describe('the MCP endpoint form', () => {
    it('turns the URL token on and off', () => {
        const base = ConfigSchema.parse({ auth: { bearer_token: 'a'.repeat(64) }, services: {} });

        const on = buildMcpConfig(base, { 'auth.allow_token_in_url': 'on', 'auth.allowed_hosts': '' });
        expect(on.auth.allow_token_in_url).toBe(true);

        const off = buildMcpConfig(on, { 'auth.allowed_hosts': '' });
        expect(off.auth.allow_token_in_url).toBe(false);
    });
});

describe('the URL token checkbox while oauth is configured', () => {
    /** Same fixture shape as `seed`, with an `auth.oauth` block added. */
    const seedWithOAuth = async () => {
        await release();

        dir = await mkdtemp(join(tmpdir(), 'arr-mcp-ui-'));
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${PASSWORD_HASH}\n  allowed_hosts: []\n  oauth:\n    issuer: https://auth.example.com\n    audience: arr-mcp\n    jwks_uri: https://auth.example.com/.well-known/jwks.json\nservices: {}\n`,
            'utf8'
        );

        const { config } = await loadConfig(dir);
        audit = WriteAudit.ephemeral();
        logs = LogStore.ephemeral();
        runtime = Runtime.fromConfig(config, audit, { configDir: dir });
        app = buildApp({ runtime, audit, logs });
        seeded = true;
    };

    it('refuses the URL-token checkbox in a sentence, not a schema dump', async () => {
        await seedWithOAuth();
        await signIn();

        const body = await (
            await call(
                '/ui/config/mcp',
                form({ csrf: await csrfFrom(), 'auth.allow_token_in_url': 'on', 'auth.allowed_hosts': '' })
            )
        ).text();

        expect(body).toContain('OAuth is configured');
        expect(body).not.toContain('invalid_union');
    });
});

describe('adding an instance', () => {
    const addForm = (over: Record<string, string> = {}) => ({
        type: 'radarr',
        url: 'http://192.0.2.10:7878',
        api_key: 'k',
        ...over
    });

    it('refuses a forged CSRF token', async () => {
        await signIn();
        const res = await call('/ui/config/add', form({ csrf: 'forged', ...addForm() }));
        expect(res.status).toBe(403);
    });

    it('refuses an instance with no URL', async () => {
        await signIn();
        const res = await call('/ui/config/add', form({ csrf: await csrfFrom(), ...addForm({ url: '' }) }));
        expect(res.status).toBe(400);
    });

    it('refuses an instance with no API key', async () => {
        await signIn();
        const res = await call('/ui/config/add', form({ csrf: await csrfFrom(), ...addForm({ api_key: '' }) }));
        expect(res.status).toBe(400);
    });

    it('writes the instance to disk', async () => {
        await signIn();
        const r = await call('/ui/config/add', form({ csrf: await csrfFrom(), ...addForm({ timeout_ms: '4000' }) }));
        if (r.status !== 200) { const t = await r.text(); console.error('MSG', /class="msg[^"]*">([^<]*)</.exec(t)?.[1]); }

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('192.0.2.10:7878');
        expect(onDisk).toContain('timeout_ms: 4000');
    });

    // The reason hot reload exists: editing config from a web page and then
    // telling the user to restart would be worse than the YAML it replaces.
    it('applies without a restart', async () => {
        await signIn();
        expect(runtime.current.adapters).toHaveLength(0);

        await call('/ui/config/add', form({ csrf: await csrfFrom(), ...addForm() }));

        expect(runtime.current.adapters.map(a => a.id)).toEqual(['radarr']);
    });

    /**
     * The rename that adding a second instance forces. That id is the
     * permission key, the audit column and what the agent passes, so it is
     * never changed without the user having said what to change it to.
     */
    it('refuses a second instance unless the existing one is named too', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();

        const res = await call(
            '/ui/config/add',
            form({ csrf: await csrfFrom(), ...addForm({ name: '4k', url: 'http://192.0.2.11:7878' }) })
        );

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('naming the one you already have');
        expect(runtime.current.adapters.map(a => a.id)).toEqual(['radarr']);
    });

    it('renames the existing instance when told what to call it', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();

        await call(
            '/ui/config/add',
            form({
                csrf: await csrfFrom(),
                ...addForm({ name: '4k', rename_existing_to: 'hd', url: 'http://192.0.2.11:7878' })
            })
        );

        expect(runtime.current.adapters.map(a => a.id)).toEqual(['radarr/4k', 'radarr/hd']);
    });

    it('refuses a second instance of a service that may only have one', async () => {
        await seed('  seerr:\n    url: http://192.0.2.10:5055\n    api_key: k\n');
        await signIn();

        const res = await call(
            '/ui/config/add',
            form({ csrf: await csrfFrom(), ...addForm({ type: 'seerr', name: 'second' }) })
        );
        expect(res.status).toBe(400);
    });
});

describe('the configuration tabs', () => {
    const onTab = (page: string, key: string) => page.includes(`href="/ui/config?tab=${key}" class="on" aria-current="page"`);
    const actionsOn = (page: string) =>
        [...page.matchAll(/(?:form)?action="(\/ui\/config[^"#]*)/g)].map(m => m[1] as string);

    it('renders only the tab it was asked for', async () => {
        await signIn();
        const access = await (await call('/ui/config?tab=access')).text();
        expect(onTab(access, 'access')).toBe(true);
        expect(access).toContain('id="tokens"');
        // Five columns with a button in the last: letter-by-letter on a phone otherwise.
        expect(access).toContain('<table class="stacked">');
        expect(access).not.toContain('name="metadata.imdb"');
        expect(access).not.toContain('id="add-service"');
    });

    it('opens on Services, and treats a tab it does not know the same way', async () => {
        await signIn();
        for (const path of ['/ui/config', '/ui/config?tab=nonsense']) {
            const page = await (await call(path)).text();
            expect(onTab(page, 'services'), path).toBe(true);
            expect(page).toContain('id="add-service"');
        }
    });

    // The page answering a post is a render of one tab, so a form whose route is
    // not mapped to its own tab would save and then show you a different page.
    it('brings every form back to the tab it is on', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();
        await call('/ui/config/oauth', form({ ...keysFrom(await everyConfigTab()), 'auth.oauth.issuer': 'https://auth.example.com/', 'auth.oauth.audience': 'arr-mcp', 'auth.oauth.jwks_uri': 'https://auth.example.com/jwks/' }));

        for (const { key } of CONFIG_TABS) {
            const actions = actionsOn(await (await call(`/ui/config?tab=${key}`)).text());
            expect(actions.length, key).toBeGreaterThan(0);
            for (const action of actions) expect(configTabForPost(action), action).toBe(key);
        }
    });

    // Shown once, in the answer to the post, and nowhere else ever again.
    it('reveals a new token on the Access tab', async () => {
        await signIn();
        const res = await call('/ui/config/tokens/add', form({ csrf: await csrfFrom(), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' }));
        const page = await res.text();
        expect(onTab(page, 'access')).toBe(true);
        expect(page).toMatch(/value="amcp_[0-9a-f]{64}"/);
    });

    it('reveals a new management key on the Access tab, scrolled to its card', async () => {
        await signIn();
        const before = await (await call('/ui/config?tab=access')).text();
        expect(before).toContain('action="/ui/config/api-keys/add#management-api"');

        const res = await call('/ui/config/api-keys/add', form({ csrf: await csrfFrom(), 'api-key.name': 'phone', 'api-key.tier': 'read' }));
        const page = await res.text();
        expect(onTab(page, 'access')).toBe(true);
        expect(page).toContain('id="management-key"');
    });

    it('keeps a refused save on the tab it came from', async () => {
        await signIn();
        const res = await call('/ui/config/imdb', form({ csrf: 'stale' }));
        expect(res.status).toBe(403);
        expect(onTab(await res.text(), 'settings')).toBe(true);
    });

    it('builds the tabs the same way as the Logs page', async () => {
        await signIn();
        const bar = (page: string) => /<nav style="margin-bottom:\.75rem">[\s\S]*?<\/nav>/.exec(page)?.[0] ?? '';
        const shape = (html: string) => html.replace(/href="[^"]*"/g, 'href').replace(/>[^<]+</g, '><').replace(/\s+/g, ' ');
        const logs = bar(await (await call('/ui/logs')).text());
        const config = bar(await (await call('/ui/config')).text());

        expect(logs).toContain('aria-current="page"');
        expect(config).toContain('aria-current="page"');
        expect(shape(config).split('</a>')[0]).toBe(shape(logs).split('</a>')[0]);
    });
});

describe('the configuration page', () => {
    it('shows an empty state rather than eight blank fieldsets', async () => {
        await signIn();
        const page = await everyConfigTab();

        expect(page).toContain('Nothing is configured yet');
        expect(page).not.toContain('name="instance"');
    });

    it('lists configured instances alphabetically by id', async () => {
        await seed(
            '  sonarr:\n    url: http://192.0.2.10:8989\n    api_key: k\n' +
                '  radarr:\n  - name: hd\n    url: http://192.0.2.10:7878\n    api_key: k\n' +
                '  - name: 4k\n    url: http://192.0.2.11:7878\n    api_key: k\n'
        );
        await signIn();
        const page = await everyConfigTab();

        const order = [...page.matchAll(/name="instance" value="([^"]+)"/g)].map(m => m[1]);
        expect(order).toEqual(['radarr/4k', 'radarr/hd', 'sonarr']);
    });
});

/**
 * The add form is a dialog opened by a button, and its fields follow the picker
 * — both of which need scripting. Neither may become a requirement: with
 * scripting off the dialog is styled back into the flow and every field shows,
 * which is exactly the page as it was before, and the server still refuses what
 * does not make sense.
 */
describe('the add dialog', () => {
    it('is opened by a button rather than sitting under the cards', async () => {
        await signIn();
        const page = await everyConfigTab();

        expect(page).toContain('data-open="add-service"');
        expect(page).toContain('<dialog id="add-service"');
        expect(page).toContain('action="/ui/config/add"');
    });

    it('falls back to an inline form when scripting is off', async () => {
        await signIn();
        const page = await everyConfigTab();

        expect(page).toContain('<noscript>');
        expect(page).toMatch(/<noscript><style>[^<]*dialog\b/);
    });

    it('says which service each field belongs to, so the picker can hide the rest', async () => {
        await signIn();
        const page = await everyConfigTab();

        // The two torrent clients and NZBGet are the services with no API key,
        // and the only ones with a username and password.
        const apiKey = /data-only="([^"]*)"[^>]*>\s*<label for="add\.api_key"/.exec(page)?.[1] ?? '';
        expect(apiKey.split(' ')).not.toContain('nzbget');
        expect(apiKey.split(' ')).not.toContain('transmission');
        expect(apiKey.split(' ')).not.toContain('qbittorrent');
        expect(apiKey.split(' ')).toContain('radarr');

        for (const field of ['username', 'password']) {
            const only = new RegExp(`data-only="([^"]*)"[^>]*>\\s*<label for="add\\.${field}"`).exec(page)?.[1];
            expect(only?.split(' ').sort()).toEqual(['grimmory', 'nzbget', 'qbittorrent', 'transmission']);
        }
    });

    it('the add dialog does not call the username optional', async () => {
        await signIn();
        const page = await (await call('/ui/config?tab=services')).text();
        expect(page).not.toContain('Username (optional)');
        expect(page).toContain('Grimmory needs one.');
    });

    it('grimmory card asks for username and password, not a key', async () => {
        await seed('  grimmory:\n    url: http://192.0.2.10:6060\n    username: reader\n    password: s3cr3tpw\n');
        await signIn();
        const page = await (await call('/ui/config?tab=services')).text();
        const card = page.split('<details class="svc"').find(c => c.includes('192.0.2.10:6060'))?.split('</details>')[0] ?? '';
        expect(card).toMatch(/name="username"/);
        expect(card).toMatch(/name="password"/);
        expect(card).not.toMatch(/name="api_key"/);
        expect(card).not.toContain('s3cr3tpw');
    });

    /** Offering a service that can only have one instance, when it already has
     *  one, is a click whose only outcome is "already configured". */
    it('drops a configured single-instance service from the picker', async () => {
        await seed(
            '  seerr:\n    url: http://192.0.2.10:5055\n    api_key: k\n' +
                '  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n'
        );
        await signIn();
        const page = await everyConfigTab();

        const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
        expect(offered).not.toContain('seerr');
        // Radarr takes more than one, so it stays.
        expect(offered).toContain('radarr');
        expect(page).toContain('Already configured, and limited to one instance');
    });

    describe('two media servers', () => {
        const JF = '  jellyfin:\n    url: http://192.0.2.10:8096\n    api_key: k\n';
        const PX = '  plex:\n    url: http://192.0.2.10:32400\n    api_key: k\n';

        it('offers plex once jellyfin is configured', async () => {
            await seed(JF);
            await signIn();
            const page = await everyConfigTab();
            const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
            expect(offered).toContain('plex');
        });

        it('offers jellyfin once plex is configured', async () => {
            await seed(PX);
            await signIn();
            const page = await everyConfigTab();
            const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
            expect(offered).toContain('jellyfin');
        });

        it('shows a primary selector only when both are configured', async () => {
            await seed(JF + PX + 'primary_media_server: jellyfin\n');
            await signIn();
            const page = await everyConfigTab();
            expect(page).toContain('name="primary_media_server"');
        });

        it('has no primary selector with one', async () => {
            await seed(JF);
            await signIn();
            expect(await everyConfigTab()).not.toContain('name="primary_media_server"');
        });

        it('saves the primary from the Media servers card', async () => {
            await seed(JF + PX + 'primary_media_server: jellyfin\n');
            await signIn();
            const keys = keysFrom(await everyConfigTab());
            await call('/ui/config/media-servers', form({ ...keys, primary_media_server: 'plex' }));
            const { config } = await loadConfig(dir);
            expect(config.primary_media_server).toBe('plex');
        });

        it('refuses an invalid primary instead of saying it saved', async () => {
            await seed(JF + PX + 'primary_media_server: jellyfin\n');
            await signIn();
            const keys = keysFrom(await everyConfigTab());
            const res = await call('/ui/config/media-servers', form({ ...keys, primary_media_server: 'nope' }));
            expect(await res.text()).not.toContain('Primary media server saved.');
            const { config } = await loadConfig(dir);
            expect(config.primary_media_server).toBe('jellyfin');
        });

        it('adding plex to a jellyfin install keeps jellyfin primary', async () => {
            await seed(JF);
            await signIn();
            const keys = keysFrom(await everyConfigTab());
            await call('/ui/config/add', form({ ...keys, type: 'plex', url: 'http://192.0.2.10:32400', api_key: 'k' }));
            const { config } = await loadConfig(dir);
            expect(config.primary_media_server).toBe('jellyfin');
        });
    });

    it('offers a name only for the services that already have an instance', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();
        const page = await everyConfigTab();

        const only = /data-only="([^"]*)"[^>]*>\s*<label for="add\.name"/.exec(page)?.[1];
        expect(only).toBe('radarr');
    });

    /** A rejected add re-renders the page; the message and the form it is about
     *  have to arrive together, or the dialog has swallowed the reason. */
    it('comes back open when the add was refused', async () => {
        await signIn();
        const res = await call('/ui/config/add', form({ csrf: await csrfFrom(), type: 'radarr', url: '', api_key: 'k' }));

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('<dialog id="add-service" open');
    });

    it('stays shut after a save that worked', async () => {
        await signIn();
        const res = await call(
            '/ui/config/add',
            form({ csrf: await csrfFrom(), type: 'radarr', url: 'http://192.0.2.10:7878', api_key: 'k' })
        );

        expect(res.status).toBe(200);
        expect(await res.text()).not.toContain('<dialog id="add-service" open');
    });
});

/**
 * `default_user` is a name the service already knows, and typing it from memory
 * is how you get a Jellyfin that answers every library question with "no such
 * user". So the field suggests the real ones — as a datalist rather than a
 * dropdown, because the service is often unreachable at exactly the moment you
 * are configuring it and an empty dropdown would make the field unfillable.
 */
describe('the default user field', () => {
    const JELLYFIN = '  jellyfin:\n    url: http://192.0.2.10:8096\n    api_key: k\n    default_user: me\n';

    const withUsers = (names: string[]) => {
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).includes('/Users')) {
                return new Response(JSON.stringify(names.map((Name, i) => ({ Id: `id-${i}`, Name }))), {
                    headers: { 'content-type': 'application/json' }
                });
            }
            return new Response('{}', { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
    };

    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    const usersJson = async () =>
        (await (await call('/ui/config/users.json', { headers: { accept: 'application/json' } })).json()) as unknown;

    // The mock goes in before `seed`, because that is when the adapters are
    // built and each one captures the `fetch` it will use.
    it('renders the field without asking the service', async () => {
        let asked = 0;
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).includes('/Users')) asked += 1;
            return new Response('[]', { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        await seed(JELLYFIN);
        await signIn();

        const page = await everyConfigTab();

        expect(asked).toBe(0);
        expect(page).toContain('data-users-for="jellyfin"');
        expect(page).toContain('<datalist id="svc.jellyfin.default_user.options">');
        expect(page).toContain('value="me"');
        expect(page).toContain('With scripting on, the users jellyfin reports');
    });

    it('suggests the users the service reported', async () => {
        withUsers(['bartus', 'guest']);
        await seed(JELLYFIN);
        await signIn();

        expect(await usersJson()).toEqual({
            users: {
                jellyfin: {
                    names: ['bartus', 'guest'],
                    note: expect.stringContaining('Pick one of the 2 users jellyfin reported')
                }
            }
        });
    });

    /** The field has to stay usable when the service is down — that is most of
     *  why anyone opens this page. */
    it('says when the service does not answer', async () => {
        globalThis.fetch = (async () => {
            throw new Error('connection refused');
        }) as typeof fetch;
        await seed(JELLYFIN);
        await signIn();

        expect(await usersJson()).toEqual({
            users: { jellyfin: { note: expect.stringContaining('did not answer when asked who its users are') } }
        });
        // Still an editable field holding what is configured.
        const page = await everyConfigTab();
        expect(page).toContain('name="default_user"');
        expect(page).toContain('value="me"');
    });

    it('says so when the service reports no users at all', async () => {
        withUsers([]);
        await seed(JELLYFIN);
        await signIn();

        expect(await usersJson()).toEqual({
            users: { jellyfin: { names: [], note: expect.stringContaining('jellyfin reports no users yet') } }
        });
    });

    it('never lets the users list be cached', async () => {
        withUsers(['bartus']);
        await seed(JELLYFIN);
        await signIn();

        const res = await call('/ui/config/users.json', { headers: { accept: 'application/json' } });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('asks again after the config is saved', async () => {
        let asked = 0;
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).includes('/Users')) asked += 1;
            return new Response('[]', { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        await seed(JELLYFIN);
        await signIn();

        await usersJson();
        await usersJson();
        expect(asked).toBe(1);

        const saved = await call(
            '/ui/config/save',
            form({ csrf: await csrfFrom(), instance: 'jellyfin', url: 'http://192.0.2.10:8096', api_key: 'k2', default_user: 'me' })
        );
        expect(saved.status).toBe(200);

        await usersJson();
        expect(asked).toBe(2);
    });

    it('asks again once the cached list is 30 seconds old, and not before', async () => {
        let asked = 0;
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).includes('/Users')) asked += 1;
            return new Response('[]', { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        await seed(JELLYFIN);
        await signIn();

        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            await usersJson();
            vi.setSystemTime(Date.now() + 29_000);
            await usersJson();
            expect(asked).toBe(1);

            vi.setSystemTime(Date.now() + 1_000);
            await usersJson();
            expect(asked).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses the users list without a session', async () => {
        withUsers(['bartus']);
        await seed(JELLYFIN);
        cookie = '';

        const res = await call('/ui/config/users.json');
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });
});

/**
 * The loop this replaces is "save it and see if the dashboard goes green",
 * which writes a URL you already suspect is wrong and answers on another page.
 */
describe('testing a connection', () => {
    const RADARR = '  radarr:\n    url: http://192.0.2.10:7878\n    api_key: saved-key\n';
    const realFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /**
     * The page is a stack inventory before it is eight forms, so a card is a
     * closed row until you open it. The risk that buys is a card collapsing
     * over the answer to what you just did — hence the three reopen cases.
     */
    describe('collapsing', () => {
        const TWO =
            '  radarr:\n    url: http://192.0.2.10:7878\n    api_key: saved-key\n' +
            '  sonarr:\n    url: http://192.0.2.11:8989\n    api_key: saved-key\n' +
            '    permissions:\n      destructive: true\n';

        it('starts every card closed, with the row still saying what it is', async () => {
            await seed(TWO);
            await signIn();
            const page = await everyConfigTab();

            expect(page).toContain('<details class="svc">');
            expect(page).not.toContain('<details class="svc" open>');
            expect(page).toContain('http://192.0.2.10:7878');
            expect(page).toContain('read-only');
            expect(page).toContain('destructive');
        });

        it('reopens the card you just saved', async () => {
            await seed(TWO);
            await signIn();
            const page = await (
                await call(
                    '/ui/config/save',
                    form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: '' })
                )
            ).text();

            // The saved one only, so the page does not simply expand.
            expect(/<details class="svc" open>[\s\S]*?radarr/.exec(page)).not.toBeNull();
            expect(page.match(/<details class="svc" open>/g)).toHaveLength(1);
        });

        it('reopens the card whose Test you pressed, where the result is', async () => {
            await seed(TWO);
            globalThis.fetch = (async () =>
                new Response(JSON.stringify({ version: '5.1.0' }), {
                    headers: { 'content-type': 'application/json' }
                })) as typeof fetch;
            await signIn();

            const page = await (
                await call(
                    '/ui/config/test',
                    form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: '' })
                )
            ).text();

            expect(page).toContain('Reachable in');
            expect(page.match(/<details class="svc" open>/g)).toHaveLength(1);
        });

        it('reopens the card waiting on a removal confirmation', async () => {
            await seed(TWO);
            await signIn();
            const page = await (
                await call('/ui/config/remove', form({ csrf: await csrfFrom(), instance: 'sonarr' }))
            ).text();

            expect(page).toContain('Yes, remove');
            expect(page.match(/<details class="svc" open>/g)).toHaveLength(1);
        });

        it('sends a connection test result uncached, like every other page behind a session', async () => {
            await seed(TWO);
            globalThis.fetch = (async () =>
                new Response(JSON.stringify({ version: '5.1.0' }), {
                    headers: { 'content-type': 'application/json' }
                })) as typeof fetch;
            await signIn();
            const res = await call(
                '/ui/config/test',
                form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: '' })
            );

            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toBe('no-store');
        });
    });

    it('reports a service that answers', async () => {
        await seed(RADARR);
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ version: '5.1.0' }), {
                headers: { 'content-type': 'application/json' }
            })) as typeof fetch;
        await signIn();

        const res = await call(
            '/ui/config/test',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: '' })
        );

        expect(res.status).toBe(200);
        expect(await res.text()).toContain('Reachable in');
    });

    it('reports what is wrong, and what to do, when it does not', async () => {
        await seed(RADARR);
        globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
        await signIn();

        const res = await call(
            '/ui/config/test',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: 'wrong' })
        );

        expect(res.status).toBe(200);
        expect(await res.text()).toContain('msg err');
    });

    it('unfences a failed login body on the card and in the add dialog JSON response', async () => {
        await seed('  qbittorrent:\n    url: http://192.0.2.10:8080\n    username: admin\n    password: saved\n');
        globalThis.fetch = (async (input: string | URL | Request) =>
            String(input).includes('/auth/login')
                ? new Response('Fails. <bad>', { status: 200 })
                : new Response('Forbidden', { status: 403 })) as typeof fetch;
        await signIn();

        const pageRes = await call(
            '/ui/config/test',
            form({ csrf: await csrfFrom(), instance: 'qbittorrent', url: 'http://192.0.2.10:8080', username: 'admin', password: 'wrong' })
        );
        const page = await pageRes.text();
        expect(page).toContain('login returned Fails. &lt;bad&gt;');
        expect(page).not.toContain('untrusted');

        const jsonRes = await call(
            '/ui/config/test',
            {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: new URLSearchParams({
                    csrf: await csrfFrom(),
                    type: 'qbittorrent',
                    name: 'second',
                    rename_existing_to: 'first',
                    url: 'http://192.0.2.20:8080',
                    username: 'admin',
                    password: 'wrong'
                }).toString()
            }
        );
        const body = (await jsonRes.json()) as { ok: boolean; error?: { detail: string } };
        expect(body.ok).toBe(false);
        expect(body.error?.detail).toContain('login returned Fails. <bad>');
        expect(body.error?.detail).not.toContain('untrusted');
    });

    it('will not test the stored key against a new host, and keeps the card open', async () => {
        await seed(RADARR);
        let fetched = false;
        globalThis.fetch = (async () => {
            fetched = true;
            return new Response('{}');
        }) as typeof fetch;
        await signIn();

        const res = await call(
            '/ui/config/test',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://203.0.113.5:7878', api_key: '' })
        );

        expect(res.status).toBe(400);
        const html = await res.text();
        expect(html).toContain('enter the api_key again');
        expect(html).toMatch(/<details class="svc[^"]*" open/);
        expect(fetched).toBe(false);
    });

    /** The whole point: it must be safe to test a URL you have not committed to. */
    it('writes nothing to disk, whatever the answer', async () => {
        await seed(RADARR);
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ version: '5.1.0' }), {
                headers: { 'content-type': 'application/json' }
            })) as typeof fetch;
        await signIn();

        await call(
            '/ui/config/test',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.99:7878', api_key: 'typed-key' })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('192.0.2.10:7878');
        expect(onDisk).not.toContain('192.0.2.99');
        expect(onDisk).toContain('saved-key');
        expect(onDisk).not.toContain('typed-key');
    });

    it('refuses a forged CSRF token', async () => {
        await seed(RADARR);
        await signIn();

        const res = await call('/ui/config/test', form({ csrf: 'forged', instance: 'radarr' }));
        expect(res.status).toBe(403);
    });

    it('answers with the validation message when the fields cannot even be built', async () => {
        await seed(RADARR);
        await signIn();

        const res = await call(
            '/ui/config/test',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'not-a-url' })
        );

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('msg err');
    });
});

/**
 * The same route, driven by the add dialog, which has no instance to name
 * because it is describing one that does not exist yet.
 */
describe('testing from the add dialog', () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    const reachable = () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ version: '5.1.0' }), {
                headers: { 'content-type': 'application/json' }
            })) as typeof fetch;
    };

    const json = (body: Record<string, string>): RequestInit => ({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(body).toString()
    });

    it('offers a Test button in the dialog', async () => {
        await signIn();
        const page = await everyConfigTab();
        const dialog = page.slice(page.indexOf('<dialog id="add-service"'));

        expect(dialog).toContain('formaction="/ui/config/test"');
        expect(dialog).toContain('id="add-test-result"');
    });

    it('tests a service that is not configured yet', async () => {
        reachable();
        await signIn();

        const res = await call(
            '/ui/config/test',
            json({ csrf: await csrfFrom(), type: 'radarr', url: 'http://192.0.2.10:7878', api_key: 'typed-key' })
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, version: '5.1.0' });
    });

    it('adds nothing to the config, whatever the answer', async () => {
        reachable();
        await signIn();

        await call(
            '/ui/config/test',
            json({ csrf: await csrfFrom(), type: 'radarr', url: 'http://192.0.2.10:7878', api_key: 'typed-key' })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).not.toContain('192.0.2.10');
        expect(onDisk).not.toContain('typed-key');
    });

    // The reason the scripted path exists at all: a re-render would have to put
    // the key back in the HTML to keep the dialog usable, and this file never
    // renders a secret back.
    it('never echoes the typed key back, on either path', async () => {
        globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
        await signIn();
        const csrf = await csrfFrom();
        const fields = { csrf, type: 'radarr', url: 'http://192.0.2.10:7878', api_key: 'typed-key' };

        expect(JSON.stringify(await (await call('/ui/config/test', json(fields))).json())).not.toContain('typed-key');
        expect(await (await call('/ui/config/test', form(fields))).text()).not.toContain('typed-key');
    });

    // Unscripted, the answer has to come back on a page with the dialog open —
    // a diagnosis behind a closed dialog is a diagnosis nobody reads.
    it('reopens the dialog when it answers as a page', async () => {
        reachable();
        await signIn();

        const res = await call(
            '/ui/config/test',
            form({ csrf: await csrfFrom(), type: 'radarr', url: 'http://192.0.2.10:7878', api_key: 'k' })
        );

        const page = await res.text();
        expect(page).toContain('<dialog id="add-service" open>');
        expect(page).toContain('Reachable in');
    });

    // It builds its candidate through `addInstance`, so it refuses exactly what
    // Add would refuse — and says the same thing about it.
    it('answers with the add validation message rather than a latency', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: saved-key\n');
        reachable();
        await signIn();

        const res = await call(
            '/ui/config/test',
            json({ csrf: await csrfFrom(), type: 'radarr', url: 'http://192.0.2.20:7878', api_key: 'k' })
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false, detail: expect.stringContaining('Name the new radarr') });
    });

    it('refuses a forged CSRF token as JSON when JSON was asked for', async () => {
        await signIn();
        const res = await call('/ui/config/test', json({ csrf: 'forged', type: 'radarr' }));

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ ok: false });
    });
});

describe('the Plex repair switch', () => {
    const PLEX = '  plex:\n    url: http://192.0.2.10:32400\n    api_key: k\n';
    const savePlex = async (extra: Record<string, string> = {}) =>
        call('/ui/config/save', form({ csrf: await csrfFrom(), instance: 'plex', url: 'http://192.0.2.10:32400', api_key: '', ...extra }));

    it('shows on the Plex card only, marked experimental', async () => {
        await seed(`${PLEX}  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n`);
        await signIn();
        const page = await everyConfigTab();

        expect(page.match(/name="allow_metadata_repair"/g)).toHaveLength(1);
        expect(page).not.toContain('experimental');
        expect(page).toContain('needs destructive');
    });

    it('turns the repair on and off from the card', async () => {
        await seed(PLEX);
        await signIn();

        await savePlex({ allow_metadata_repair: 'on' });
        expect(runtime.config.services.plex?.allow_metadata_repair).toBe(true);
        expect(await everyConfigTab()).toMatch(/name="allow_metadata_repair"[^>]*checked/);

        await savePlex();
        expect(runtime.config.services.plex?.allow_metadata_repair).toBe(false);
    });

    it('never writes the switch onto another service', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();

        const res = await call(
            '/ui/config/save',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: '', allow_metadata_repair: 'on' })
        );
        expect(res.status).toBe(200);
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).not.toContain('allow_metadata_repair');
    });
});

describe('a URL with credentials in it', () => {
    const WITH_USERINFO = '  radarr:\n    url: http://proxyuser:proxy-secret@192.0.2.10:7878\n    api_key: keep-me\n';
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('is shown without them', async () => {
        await seed(WITH_USERINFO);
        await signIn();

        const page = await everyConfigTab();
        expect(page).not.toContain('proxy-secret');
        expect(page).toContain('http://192.0.2.10:7878/');
    });

    it('keeps them when the page sends the shown URL back', async () => {
        await seed(WITH_USERINFO);
        await signIn();

        await call('/ui/config/save', form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878/', api_key: '' }));

        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('proxyuser:proxy-secret@192.0.2.10:7878');
    });

    it('tests with them when the page sends the shown URL back', async () => {
        await seed(WITH_USERINFO);
        let auth: string | null = null;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization');
            return new Response(JSON.stringify({ version: '5.1.0' }), { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        await signIn();

        await call('/ui/config/test', form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: '' }));

        expect(auth).toBe(`Basic ${Buffer.from('proxyuser:proxy-secret').toString('base64')}`);
    });
});

describe('saving an instance', () => {
    it('keeps an existing key when the field is left blank', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: keep-me\n');
        await signIn();

        await call(
            '/ui/config/save',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:7878/radarr', api_key: '' })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('keep-me');
        expect(onDisk).toContain('192.0.2.10:7878/radarr');
    });

    it('asks for the key again before moving an instance to another host', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: keep-me\n');
        await signIn();

        const res = await call(
            '/ui/config/save',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:9999', api_key: '' })
        );

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('enter the api_key again');
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).not.toContain('192.0.2.10:9999');
    });

    it('leaves every other instance untouched', async () => {
        await seed(
            '  radarr:\n  - name: hd\n    url: http://192.0.2.10:7878\n    api_key: hd-key\n' +
                '  - name: 4k\n    url: http://192.0.2.11:7878\n    api_key: fourk-key\n'
        );
        await signIn();

        await call(
            '/ui/config/save',
            form({ csrf: await csrfFrom(), instance: 'radarr/4k', url: 'http://192.0.2.11:7878/4k' })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('hd-key');
        expect(onDisk).toContain('fourk-key');
        expect(onDisk).toContain('192.0.2.10:7878');
        expect(onDisk).toContain('192.0.2.11:7878/4k');
    });
});

describe('a page left open while the config changed', () => {
    const KEY = `amk_${'1'.repeat(64)}`;
    const STALE = 'This page is out of date: the configuration changed after it loaded. Your edit was not saved. Review the page and make it again.';
    const seedKeyed = () =>
        seed(
            '  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n',
            `  management_key: { hash: '${hashToken(KEY)}', created: '2026-09-29' }\n`
        );
    const putSafeWrite = () =>
        app.request('http://localhost:6060/api/v1/app/radarr', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-api-key': KEY },
            body: JSON.stringify({ safeWrite: true })
        });
    const saveCard = (keys: { csrf: string; etag: string }) =>
        call(
            '/ui/config/save',
            form({ ...keys, instance: 'radarr', url: 'http://192.0.2.10:7878', api_key: '', timeout_ms: '20000' })
        );
    const onDisk = () => readFile(join(dir, 'config.yaml'), 'utf8');

    it('refuses the save instead of undoing an API change the page never saw', async () => {
        await seedKeyed();
        await signIn();
        const keys = keysFrom(await everyConfigTab());
        expect(keys.etag).not.toBe('');

        expect((await putSafeWrite()).status).toBe(200);
        const res = await saveCard(keys);

        expect(res.status).toBe(409);
        expect(await res.text()).toContain(STALE);
        expect(runtime.config.services.radarr).toMatchObject({ permissions: { safe_write: true } });
        expect(await onDisk()).toMatch(/safe_write: true/);
        expect(await onDisk()).not.toContain('20000');
    });

    it('saves once the page is reloaded', async () => {
        await seedKeyed();
        await signIn();
        await putSafeWrite();
        const keys = keysFrom(await everyConfigTab());

        const res = await saveCard(keys);

        expect(res.status).toBe(200);
        expect(runtime.config.services.radarr).toMatchObject({ timeout_ms: 20000 });
    });

    it('carries the etag through a two-step revoke', async () => {
        await seedKeyed();
        await signIn();
        await call('/ui/config/tokens/add', form({ ...keysFrom(await everyConfigTab()), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' }));

        const asked = await call('/ui/config/tokens/revoke', form({ ...keysFrom(await everyConfigTab()), token: 'phone' }));
        const confirm = keysFrom(await asked.text());
        expect(confirm.etag).not.toBe('');
        const res = await call('/ui/config/tokens/revoke', form({ ...confirm, token: 'phone', confirm: 'yes' }));

        expect(res.status).toBe(200);
        expect(runtime.config.auth.tokens.some(t => t.name === 'phone')).toBe(false);
    });

    it('refuses a stale confirm the same way', async () => {
        await seedKeyed();
        await signIn();
        await call('/ui/config/tokens/add', form({ ...keysFrom(await everyConfigTab()), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' }));
        const asked = keysFrom(await (await call('/ui/config/tokens/revoke', form({ ...keysFrom(await everyConfigTab()), token: 'phone' }))).text());

        await putSafeWrite();
        const res = await call('/ui/config/tokens/revoke', form({ ...asked, token: 'phone', confirm: 'yes' }));

        expect(res.status).toBe(409);
        expect(await res.text()).toContain(STALE);
        expect(runtime.config.auth.tokens.some(t => t.name === 'phone')).toBe(true);
    });

    // Ask, then confirm from the asking page, as a browser would.
    const confirmFlow = async (path: string, fields: Record<string, string> = {}) => {
        const asked = await call(path, form({ ...keysFrom(await everyConfigTab()), ...fields }));
        expect(asked.status).toBe(200);
        const keys = keysFrom(await asked.text());
        expect(keys.etag).not.toBe('');
        return call(path, form({ ...keys, ...fields, confirm: 'yes' }));
    };

    it('carries the etag through a two-step app removal', async () => {
        await seedKeyed();
        await signIn();
        expect((await confirmFlow('/ui/config/remove', { instance: 'radarr' })).status).toBe(200);
        expect(runtime.config.services.radarr).toBeUndefined();
    });

    it('carries the etag through revoking a management key', async () => {
        await seedKeyed();
        await signIn();
        expect((await confirmFlow('/ui/config/api-keys/revoke', { key: 'default' })).status).toBe(200);
        expect(runtime.config.auth.management_keys).toBeUndefined();
    });

    it('carries the etag through removing OAuth', async () => {
        await seed(
            '',
            '  oauth:\n    issuer: https://auth.example.com\n    audience: arr-mcp\n    jwks_uri: https://auth.example.com/.well-known/jwks.json\n'
        );
        await signIn();
        expect((await confirmFlow('/ui/config/oauth/remove')).status).toBe(200);
        expect(runtime.config.auth.oauth).toBeUndefined();
    });

    it('logs a hand edit that no longer loads once, at warn', async () => {
        await seedKeyed();
        await signIn();
        const keys = keysFrom(await everyConfigTab());
        await writeFile(join(dir, 'config.yaml'), 'services: 5\n', 'utf8');
        const warn = vi.spyOn(logger, 'warn');
        const error = vi.spyOn(logger, 'error');
        try {
            const res = await saveCard(keys);
            expect(await res.text()).toContain('no longer loads. Fix the file, then retry.');
            expect(warn).toHaveBeenCalledTimes(1);
            expect(error).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            error.mockRestore();
        }
    });

    it('puts the etag on every form that saves', async () => {
        await seedKeyed();
        await signIn();
        await call('/ui/config/oauth', form({ ...keysFrom(await everyConfigTab()), 'auth.oauth.issuer': 'https://auth.example.com/', 'auth.oauth.audience': 'arr-mcp', 'auth.oauth.jwks_uri': 'https://auth.example.com/jwks/' }));
        const page = await everyConfigTab();

        const forms = [...page.matchAll(/<form method="post"[^>]*action="([^"#]+)[^>]*>([\s\S]*?)<\/form>/g)]
            .map(m => ({ action: m[1] as string, body: m[2] as string }))
            .filter(f => f.action.startsWith('/ui/config'));
        expect(forms.map(f => f.action).sort()).toEqual([
            '/ui/config/account',
            '/ui/config/add',
            '/ui/config/api-keys/add',
            '/ui/config/api-keys/revoke',
            '/ui/config/appearance',
            '/ui/config/imdb',
            '/ui/config/mcp',
            '/ui/config/save',
            '/ui/config/tokens/add',
            '/ui/config/tokens/revoke',
            '/ui/config/webhooks'
        ]);
        for (const f of forms) expect(f.body, f.action).toMatch(/name="etag" value="&quot;[0-9a-f]{16}&quot;"/);
        expect(/<form id="oauth"[\s\S]*?<\/form>/.exec(page)?.[0]).toMatch(/name="etag"/);
    });
});

describe('removing an instance', () => {
    const seedTwo = () =>
        seed(
            '  radarr:\n  - name: hd\n    url: http://192.0.2.10:7878\n    api_key: k\n' +
                '  - name: 4k\n    url: http://192.0.2.11:7878\n    api_key: k\n'
        );

    /**
     * Server-side rather than a `confirm()` call. With scripting unavailable a
     * JS confirmation would delete on the first click, which is precisely the
     * failure a confirmation exists to prevent.
     */
    it('removes nothing on the first click, and asks', async () => {
        await seedTwo();
        await signIn();

        const res = await call('/ui/config/remove', form({ csrf: await csrfFrom(), instance: 'radarr/4k' }));

        expect(res.status).toBe(200);
        expect(await res.text()).toContain('Yes, remove radarr/4k');
        expect(runtime.current.adapters.map(a => a.id)).toEqual(['radarr/4k', 'radarr/hd']);
    });

    it('removes exactly one once confirmed', async () => {
        await seedTwo();
        await signIn();

        await call('/ui/config/remove', form({ csrf: await csrfFrom(), instance: 'radarr/4k', confirm: 'yes' }));

        expect(runtime.current.adapters.map(a => a.id)).toEqual(['radarr/hd']);
    });

    // Collapsing `radarr/hd` back to `radarr` would be a second silent rename,
    // undoing the one the user was explicitly asked to approve.
    it('leaves the last instance named rather than collapsing it', async () => {
        await seedTwo();
        await signIn();

        await call('/ui/config/remove', form({ csrf: await csrfFrom(), instance: 'radarr/4k', confirm: 'yes' }));

        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('name: hd');
    });

    it('removes the service entirely when its last instance goes', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();

        await call('/ui/config/remove', form({ csrf: await csrfFrom(), instance: 'radarr', confirm: 'yes' }));

        expect(runtime.current.adapters).toHaveLength(0);
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).not.toContain('192.0.2.10');
    });
});

/**
 * Three cards where there was one form, each saving only itself.
 *
 * The page had a single button at the bottom covering Config UI credentials,
 * the IMDb dataset and the MCP endpoint at once — which read as a global save
 * because it was the last thing on the page, while every service card above
 * saved itself. Two save models on one page, and no way to tell which button
 * owned what you had just typed.
 *
 * Splitting them introduces exactly one new way to be wrong, and it is a bad
 * one: a form that no longer carries a field can look identical to a user
 * clearing it. Saving the IMDb card must not wipe `allowed_hosts` just because
 * that input is now on a different card, and saving the MCP card must not
 * switch the dataset off. These tests exist for that, and each one failed
 * against the naive split.
 */
describe('each access card saves only itself', () => {
    /**
     * A host worth pinning, and the reason every call below carries it.
     *
     * `app.request()` sends no `Host` header of its own, and a non-empty
     * `allowed_hosts` rejects a request with no matching one — so a fixture
     * that pins a host and then posts without setting it gets 403 on every
     * save. The first draft did exactly that, and two of these tests passed
     * anyway because they asserted values the failed save would have left
     * alone. Hence `post`, and hence the explicit status assertion in it.
     */
    const PINNED = 'arr.example.com';

    /**
     * A config with all three cards' settings non-default at once, so a save
     * that clobbers one is visible. Sign in *before* calling this: pinning
     * locks out `/ui/login` too.
     */
    const withDataset = async () => {
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${PASSWORD_HASH}\n  allowed_hosts: [${PINNED}]\nservices: {}\nmetadata:\n  imdb:\n    enabled: true\n`,
            'utf8'
        );
        await runtime.reload();
    };

    /** A save through the pinned host, asserting it was actually accepted —
     *  without which every test here risks passing on a 403. */
    const post = async (path: string, body: Record<string, string> = {}) => {
        const page = await (await call('/ui/config', { headers: { host: PINNED } })).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';

        const res = await call(path, {
            ...form({ csrf, ...body }),
            headers: { 'content-type': 'application/x-www-form-urlencoded', host: PINNED }
        });
        expect(res.status).toBe(200);
        return res;
    };

    const ready = async () => {
        await signIn();
        await withDataset();
    };

    it('saving the IMDb card leaves the pinned hosts and the token alone', async () => {
        await ready();

        const tokens = runtime.config.auth.tokens;
        await post('/ui/config/imdb', { 'metadata.imdb': 'on' });

        expect(runtime.config.auth.allowed_hosts).toEqual([PINNED]);
        expect(runtime.config.auth.tokens).toEqual(tokens);
        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
    });

    it('saving the MCP card does not switch the dataset off', async () => {
        await ready();

        await post('/ui/config/mcp', { 'auth.allowed_hosts': PINNED });

        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
    });

    it('saving the account card touches neither the dataset, the hosts nor the token', async () => {
        await ready();

        const tokens = runtime.config.auth.tokens;
        await post('/ui/config/account', { 'auth.username': 'someone-else' });

        expect(runtime.config.auth.username).toBe('someone-else');
        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
        expect(runtime.config.auth.allowed_hosts).toEqual([PINNED]);
        expect(runtime.config.auth.tokens).toEqual(tokens);
    });

    /** The dataset still has to be switchable *off*, which is the one case the
     *  "absent means unchanged" rule above cannot express — so the IMDb card
     *  reads its own checkbox as authoritative, and only its own. */
    it('still switches the dataset off from its own card', async () => {
        await ready();

        await post('/ui/config/imdb');

        expect(runtime.config.metadata).toBeUndefined();
        expect(runtime.config.auth.allowed_hosts).toEqual([PINNED]);
    });

    /**
     * The service cards are held to the same rule, and were the one path that
     * broke it: the config algebra rebuilt the file from `auth` and `services`,
     * so `metadata` went missing and `saveConfig` deleted the block. Adding a
     * service, or nudging a timeout on one, switched the IMDb dataset off and
     * closed the database — a card away from anything the user had touched.
     *
     * Asserted against the file as well as the runtime: the runtime reads back
     * from disk on reload, but naming the block makes the failure say what went
     * wrong rather than "expected true, got undefined".
     */
    const addRadarr = () =>
        post('/ui/config/add', {
            type: 'radarr',
            url: 'http://192.0.2.10:7878',
            api_key: 'k'
        });

    const onDisk = async () => await readFile(join(dir, 'config.yaml'), 'utf8');

    it('adding a service does not switch the dataset off', async () => {
        await ready();

        await addRadarr();

        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
        expect(await onDisk()).toContain('metadata:');
    });

    it('editing a service does not switch the dataset off', async () => {
        await ready();
        await addRadarr();

        await post('/ui/config/save', {
            instance: 'radarr',
            url: 'http://192.0.2.10:7878',
            timeout_ms: '12000'
        });

        // The edit landed, so the save really ran — without which the dataset
        // would still be on for the boring reason.
        expect(runtime.config.services.radarr).toMatchObject({ timeout_ms: 12_000 });
        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
        expect(await onDisk()).toContain('metadata:');
    });

    it('removing a service does not switch the dataset off', async () => {
        await ready();
        await addRadarr();

        await post('/ui/config/remove', { instance: 'radarr', confirm: 'yes' });

        expect(runtime.config.services.radarr).toBeUndefined();
        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
        expect(await onDisk()).toContain('metadata:');
    });

    it('gives each card its own button, and the page no button that spans them', async () => {
        await signIn();
        const page = await everyConfigTab();

        expect(page).toContain('/ui/config/account');
        expect(page).toContain('/ui/config/imdb');
        expect(page).toContain('/ui/config/mcp');
        expect(page).not.toContain('Save access settings');
    });
});

describe('access settings', () => {
    it('leaves the tokens alone when the MCP card is saved', async () => {
        await signIn();
        const tokens = runtime.config.auth.tokens;
        await call('/ui/config/mcp', form({ csrf: await csrfFrom() }));
        expect(runtime.config.auth.tokens).toEqual(tokens);
    });

    it('does not disturb configured services', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();

        await call('/ui/config/account', form({ csrf: await csrfFrom(), 'auth.username': 'admin' }));

        expect(runtime.current.adapters.map(a => a.id)).toEqual(['radarr']);
    });

    it('changes the password, and the old one stops working', async () => {
        await signIn();
        await call(
            '/ui/config/account',
            form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.password': 'a-new-password' })
        );

        cookie = '';
        expect((await call('/ui/login', form({ username: 'admin', password: PASSWORD }))).status).toBe(401);
        expect((await call('/ui/login', form({ username: 'admin', password: 'a-new-password' }))).status).toBe(302);
    });

    it('leaves the password alone when the field is blank', async () => {
        await signIn();
        await call('/ui/config/account', form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.password': '' }));

        cookie = '';
        expect((await call('/ui/login', form({ username: 'admin', password: PASSWORD }))).status).toBe(302);
    });
});

describe('MCP tokens', () => {
    const mcp = (token: string) =>
        app.request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });
    const created = (page: string) => /value="(amcp_[0-9a-f]{64})"/.exec(page)?.[1];

    it('creates a token, shows it once, and it works on the next request', async () => {
        await signIn();
        const res = await call('/ui/config/tokens/add', form({ csrf: await csrfFrom(), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' }));
        expect(res.headers.get('cache-control')).toBe('no-store');
        const page = await res.text();
        const token = created(page);
        expect(token).toBeDefined();
        expect((await mcp(token as string)).status).toBe(200);

        const later = await everyConfigTab();
        expect(later).not.toContain(token as string);
        expect(later).toContain('phone');
    });

    // The duplicate-name check is what refuses it: `expected` is captured at
    // POST time, so the drift check has nothing to catch.
    it('refuses a resubmitted create instead of making a second token', async () => {
        await signIn();
        const body = { csrf: await csrfFrom(), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' };
        await call('/ui/config/tokens/add', form(body));
        const again = await call('/ui/config/tokens/add', form(body));
        expect(again.status).toBe(400);
        expect(await again.text()).not.toContain('amcp_');
        expect(runtime.config.auth.tokens.filter(t => t.name === 'phone')).toHaveLength(1);
    });

    it('asks before revoking, then revokes, and the token stops working', async () => {
        await signIn();
        const token = created(await (await call('/ui/config/tokens/add', form({ csrf: await csrfFrom(), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' }))).text()) as string;

        const asked = await (await call('/ui/config/tokens/revoke', form({ csrf: await csrfFrom(), token: 'phone' }))).text();
        expect(asked).toContain('Yes, revoke phone');
        expect(runtime.config.auth.tokens.some(t => t.name === 'phone')).toBe(true);

        await call('/ui/config/tokens/revoke', form({ csrf: await csrfFrom(), token: 'phone', confirm: 'yes' }));
        expect((await mcp(token)).status).toBe(401);
    });

    it('warns harder before revoking the last token', async () => {
        await signIn();
        const only = runtime.config.auth.tokens[0]?.name as string;
        const asked = await (await call('/ui/config/tokens/revoke', form({ csrf: await csrfFrom(), token: only }))).text();
        expect(asked).toContain('every MCP client will be refused until you create a new token');
    });

    it('marks expired tokens and plaintext still on disk', async () => {
        await seed();
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  username: admin\n  password_hash: ${PASSWORD_HASH}\n  allowed_hosts: []\n  tokens:\n` +
                `    - { name: old, tier: read, hash: '${hashToken('x'.repeat(40))}', expires: '2020-01-01' }\n` +
                `    - { name: ci, tier: write, token: '${'y'.repeat(40)}' }\nservices: {}\n`,
            'utf8'
        );
        const { config, plaintextOnDisk } = await loadConfig(dir, {
            write: () => Promise.reject(new Error('read-only'))
        });
        expect(plaintextOnDisk).toEqual(['ci']);
        logs.close();
        audit.close();
        audit = WriteAudit.ephemeral();
        logs = LogStore.ephemeral();
        runtime = Runtime.fromConfig(config, audit, { configDir: dir, plaintextOnDisk });
        app = buildApp({ runtime, audit, logs });
        await signIn();

        const page = await everyConfigTab();
        expect(page).toMatch(/>old<\/td>[\s\S]*?<strong>expired<\/strong> 2020-01-01/);
        expect(page).toContain('still plaintext in config.yaml');
        expect(page).not.toContain('y'.repeat(40));
    });
});

describe('allowed_hosts', () => {
    // `/ui/app.css`, not `/healthz`: health sits ahead of the allowlist so the
    // container probe keeps working, so it would pass whether the pin applied
    // or not. The stylesheet is unauthenticated but gated.
    const get = (host: string) => call('/ui/app.css', { headers: { host } });

    it('accepts any Host when nothing is pinned', async () => {
        expect((await get('192.168.1.50:6060')).status).toBe(200);
    });

    // The whole reason this moved out of the adapter: pinning from the config
    // UI must apply at once, or a security setting appears to have worked when
    // it has not.
    it('applies a pinned host immediately, with no restart', async () => {
        await signIn();
        await call(
            '/ui/config/mcp',
            form({ csrf: await csrfFrom(), 'auth.allowed_hosts': 'arr.example.com' })
        );

        expect((await get('arr.example.com')).status).toBe(200);
        expect((await get('evil.example.com')).status).toBe(403);
    });

    // A pinned bare hostname must not stop working because the browser sent a
    // port, which is what every browser does.
    it('matches a pinned bare hostname when the request carries a port', async () => {
        await signIn();
        await call(
            '/ui/config/mcp',
            form({ csrf: await csrfFrom(), 'auth.allowed_hosts': 'arr.example.com' })
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
            '/ui/config/mcp',
            form({ csrf: await csrfFrom(), 'auth.allowed_hosts': 'arr.example.com' })
        );
        expect((await get('other.example.com')).status).toBe(403);

        // Even the config page itself is unreachable from an unlisted host.
        expect((await call('/ui/config', { headers: { host: 'other.example.com' } })).status).toBe(403);

        const page = await (await call('/ui/config', { headers: { host: 'arr.example.com' } })).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
        await call('/ui/config/mcp', {
            ...form({ csrf, 'auth.allowed_hosts': '' }),
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                host: 'arr.example.com'
            }
        });

        expect((await get('other.example.com')).status).toBe(200);
    });
});

/**
 * These call `app.request` directly rather than the `call` helper above: `call`
 * reads and writes the module-level `cookie`, which is never reset between
 * tests, so a signed-in test earlier in the file would poison the `set-cookie`
 * assertions here.
 */
describe('an unclaimed instance', () => {
    const claim = (body: Record<string, string>) =>
        app.request('http://localhost:6060/ui/setup', form(body));

    const GOOD = { username: 'me', password: 'correct-horse-battery', confirm: 'correct-horse-battery' };

    beforeEach(async () => {
        await seedUnclaimed();
    });

    it('sends every UI route to the setup page', async () => {
        for (const path of ['/', '/ui', '/ui/login', '/ui/logs', '/ui/audit', '/ui/config']) {
            const res = await app.request(`http://localhost:6060${path}`);
            expect(res.status, path).toBe(302);
            expect(res.headers.get('location'), path).toBe('/ui/setup');
        }
    });

    it('serves the setup page rather than a login form', async () => {
        const body = await (await app.request('http://localhost:6060/ui/setup')).text();
        expect(body).toContain('Claim this instance');
    });

    it('claims on the first post, and signs that person in', async () => {
        const res = await claim(GOOD);

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui');
        expect(res.headers.get('set-cookie')).toContain('arr_mcp_session=');
        expect(runtime.config.auth.username).toBe('me');
        expect(runtime.config.auth.password_hash).toBeTypeOf('string');
    });

    it('refuses a second claim, leaving the first owner in place', async () => {
        await claim(GOOD);
        const second = await claim({
            username: 'attacker',
            password: 'another-long-one',
            confirm: 'another-long-one'
        });

        expect(second.status).toBe(302);
        expect(second.headers.get('location')).toBe('/ui/login');
        expect(second.headers.get('set-cookie')).toBeNull();
        expect(runtime.config.auth.username).toBe('me');
    });

    it.each([
        ['a short password', { username: 'me', password: 'short', confirm: 'short' }],
        ['a mismatched confirmation', { username: 'me', password: 'correct-horse-battery', confirm: 'nope-not-that' }],
        ['a blank username', { username: '   ', password: 'correct-horse-battery', confirm: 'correct-horse-battery' }]
    ])('rejects %s without claiming', async (_label, body) => {
        const res = await claim(body);

        expect(res.status).toBe(400);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(runtime.config.auth.password_hash).toBeUndefined();
    });

    it('survives a restart as an unclaimed instance rather than repairing itself', async () => {
        const { config } = await loadConfig(dir);
        expect(config.auth.password_hash).toBeUndefined();
    });
});

describe('a claimed instance', () => {
    it('will not serve the setup page', async () => {
        const res = await app.request('http://localhost:6060/ui/setup');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/ui/login');
    });

    it('will not let a post to setup overwrite the password', async () => {
        const before = runtime.config.auth.password_hash;
        const res = await app.request(
            'http://localhost:6060/ui/setup',
            form({ username: 'attacker', password: 'another-long-one', confirm: 'another-long-one' })
        );

        expect(res.status).toBe(302);
        expect(runtime.config.auth.password_hash).toBe(before);
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

    it('filters by an instance id, which is what a second Radarr logs under', async () => {
        // Log rows carry the *instance* id — `radarr/4k` — and the dropdown is
        // built from those same values. Validating the choice against the bare
        // eight-service enum threw it away and returned every line from every
        // service, so anyone running two Radarrs could not filter their logs
        // at all, and the failure looked like "nothing was logged".
        logs.write(JSON.stringify({ level: 30, time: Date.now(), msg: 'hd-info', service: 'radarr/hd' }));
        logs.write(JSON.stringify({ level: 30, time: Date.now(), msg: '4k-info', service: 'radarr/4k' }));
        await signIn();

        expect(await streamRows('?stream=service&service=radarr%2F4k')).toEqual(['4k-info']);
    });

    it('filters by a source id, which is what a fan-out read logs under', async () => {
        // `gather` logs per *source*, so `jellyfin:seasons` reaches the column
        // and the dropdown as well.
        seedLogs();
        logs.write(JSON.stringify({ level: 40, time: Date.now(), msg: 'seasons-warn', service: 'jellyfin:seasons' }));
        await signIn();

        expect(await streamRows('?stream=service&service=jellyfin%3Aseasons')).toEqual(['seasons-warn']);
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

/**
 * A background ingest with no visible state is one nobody can tell has failed.
 * The state that matters most is the middle one — enabled, first ingest not
 * finished — where silence is indistinguishable from a broken download.
 */
describe('the IMDb dataset in the config UI', () => {
    const seedWithDataset = async () => {
        await seed();
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${PASSWORD_HASH}\n  allowed_hosts: []\nservices: {}\nmetadata:\n  imdb:\n    enabled: true\n`,
            'utf8'
        );
        await runtime.reload();
    };

    it('says nothing at all on the dashboard when the dataset is not configured', async () => {
        await signIn();
        expect(await (await call('/ui')).text()).not.toContain('IMDb dataset');
    });

    it('says the first ingest has not finished rather than staying silent', async () => {
        await seedWithDataset();
        await signIn();

        const page = await (await call('/ui')).text();
        expect(page).toContain('IMDb dataset');
        expect(page).toContain('still downloading');
    });

    it('offers the toggle on the configuration page', async () => {
        await signIn();
        expect(await everyConfigTab()).toContain('name="metadata.imdb"');
    });

    /** The toggle has to reach config.yaml — `saveConfig` edits the document in
     *  place, so a key nothing writes is a key that silently never persists. */
    it('writes the block to disk when switched on', async () => {
        await signIn();
        await call('/ui/config/imdb', form({ csrf: await csrfFrom(), 'metadata.imdb': 'on' }));

        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('metadata:');
        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
    });

    /**
     * Off is the block disappearing, not `enabled: false`. Written as null it
     * would fail the strict schema on the next start — a save that produces an
     * instance which will not boot.
     */
    it('removes the block entirely when switched off', async () => {
        await seedWithDataset();
        await signIn();
        await call('/ui/config/imdb', form({ csrf: await csrfFrom() }));

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).not.toContain('metadata:');
        expect(onDisk).not.toContain('null');
        expect(runtime.config.metadata).toBeUndefined();
    });
});

/**
 * /ui/logs.json already sends no-store; the pages that can carry a credential
 * sent nothing, so they persisted in disk cache and bfcache after a sign-out.
 */
describe('authenticated page caching', () => {
    it('sends no-store on every authenticated page', async () => {
        await signIn();
        for (const path of ['/ui', '/ui/logs', '/ui/audit', '/ui/config']) {
            expect((await call(path)).headers.get('cache-control'), path).toBe('no-store');
        }
    });

    it('does not send no-store on the stylesheet, which is cacheable and reveals nothing', async () => {
        cookie = '';
        expect((await call('/ui/app.css')).headers.get('cache-control')).not.toBe('no-store');
    });
});

describe('ending sessions', () => {
    it('signs existing sessions out when the password changes', async () => {
        await signIn();
        expect((await call('/ui')).status).toBe(200);

        const before = cookie;
        await call(
            '/ui/config/account',
            form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.password': 'a-new-password-1234' })
        );

        // A cookie captured before the change no longer opens the dashboard.
        cookie = before;
        expect((await call('/ui')).status).toBe(302);
    });

    it('keeps the editor signed in after they change their own password', async () => {
        await signIn();
        await call(
            '/ui/config/account',
            form({ csrf: await csrfFrom(), 'auth.username': 'admin', 'auth.password': 'a-new-password-1234' })
        );

        // `call` follows the Set-Cookie the save issued.
        expect((await call('/ui')).status).toBe(200);
    });

    it('does not sign anyone out when only the username changed', async () => {
        await signIn();
        const before = cookie;
        await call('/ui/config/account', form({ csrf: await csrfFrom(), 'auth.username': 'someone-else' }));

        cookie = before;
        expect((await call('/ui')).status).toBe(200);
    });

    it('a signed-out session cookie no longer works if replayed', async () => {
        await signIn();
        const stolen = cookie;
        await call('/ui/logout', form({ csrf: await csrfFrom() }));

        cookie = stolen;
        expect((await call('/ui')).status).toBe(302);
    });

    // Every other state-changing form carries one, and sign-out now ends a
    // session rather than only clearing a cookie.
    it('refuses a sign-out with no CSRF token', async () => {
        await signIn();
        await call('/ui/logout', { method: 'POST' });

        expect((await call('/ui')).status).toBe(200);
    });
});

describe('claiming an instance', () => {
    const claimBody = (password: string) => ({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'admin', password, confirm: password }).toString()
    });

    it('refuses a claim carrying a foreign origin', async () => {
        await seedUnclaimed();
        cookie = '';
        const req = claimBody('a-good-password-1234');
        const res = await call('/ui/setup', {
            ...req,
            headers: { ...req.headers, origin: 'http://evil.example' }
        });

        expect(res.status).toBe(403);
        expect((await loadConfig(dir)).config.auth.password_hash).toBeUndefined();
    });

    it('refuses a claim the browser marked cross-site', async () => {
        await seedUnclaimed();
        cookie = '';
        const req = claimBody('a-good-password-1234');
        const res = await call('/ui/setup', {
            ...req,
            headers: { ...req.headers, 'sec-fetch-site': 'cross-site' }
        });

        expect(res.status).toBe(403);
    });

    it('accepts a claim from its own origin', async () => {
        await seedUnclaimed();
        cookie = '';
        const req = claimBody('a-good-password-1234');
        const res = await call('/ui/setup', {
            ...req,
            headers: { ...req.headers, origin: 'http://localhost:6060' }
        });

        expect(res.status).toBe(302);
    });

    // curl and the setup script send neither header; absence is not evidence.
    it('accepts a claim from a client that sends no origin at all', async () => {
        await seedUnclaimed();
        cookie = '';
        expect((await call('/ui/setup', claimBody('a-good-password-1234'))).status).toBe(302);
    });

    it('only the first of two concurrent claims wins', async () => {
        await seedUnclaimed();
        cookie = '';
        const results = await Promise.all([
            call('/ui/setup', claimBody('first-password-here')),
            call('/ui/setup', claimBody('second-password-here'))
        ]);

        // Both redirect; only the winner is sent to the dashboard. The loser
        // goes to the login page, because the instance is now claimed.
        const destinations = results.map(r => r.headers.get('location')).sort();
        expect(destinations).toEqual(['/ui', '/ui/login']);
    });
});

/**
 * The `fields` a line was logged with — `ip`, `via`, the serialized `err` — were
 * stored from the start and rendered nowhere, so a month of warnings said what
 * had happened and never to whom or why.
 */
describe('the diagnostic fields on a log row', () => {
    it('hands them to the polled table, already flattened', async () => {
        logs.write(
            JSON.stringify({
                level: 40,
                time: Date.now(),
                msg: 'source failed; degrading rather than failing',
                service: 'radarr',
                err: { kind: 'Timeout', stack: 'multi\nline noise' }
            })
        );
        await signIn();

        const body = (await (await call('/ui/logs.json')).json()) as {
            rows: { msg: string; detail: [string, string][] }[];
        };
        const row = body.rows.find(r => r.msg.startsWith('source failed'));
        expect(row?.detail).toEqual([['err.kind', 'Timeout']]);
    });

    it('renders them under the message on the page itself', async () => {
        logs.write(
            JSON.stringify({
                level: 40,
                time: Date.now(),
                msg: 'rejected unauthenticated MCP request',
                ip: '192.168.178.82',
                via: 'none'
            })
        );
        await signIn();

        const page = await (await call('/ui/logs?stream=problems')).text();
        expect(page).toContain('class="fields"');
        expect(page).toContain('192.168.178.82');
    });
});

describe('dashboard MCP card', () => {
    const seedTokens = async (tokens: string) => {
        await seed();
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:
  username: admin
  password_hash: ${PASSWORD_HASH}
  allowed_hosts: []
  tokens:${tokens}
services: {}
`,
            'utf8'
        );
        const { config, plaintextOnDisk } = await loadConfig(dir, {
            write: () => Promise.reject(new Error('read-only'))
        });
        logs.close();
        audit.close();
        audit = WriteAudit.ephemeral();
        logs = LogStore.ephemeral();
        runtime = Runtime.fromConfig(config, audit, { configDir: dir, plaintextOnDisk });
        app = buildApp({ runtime, audit, logs });
        await signIn();
    };
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

    it('never renders a token, and links to manage them', async () => {
        await signIn();
        const page = await (await call('/ui')).text();
        expect(page).not.toContain('id="bearer"');
        expect(page).toMatch(/1 token · <a href="\/ui\/config\?tab=access#tokens">Manage<\/a>/);
    });

    it('prompts for a first token when there are none', async () => {
        await seedTokens(' []');
        const page = await (await call('/ui')).text();
        expect(page).toContain('No MCP tokens yet. Create one to connect a client.');
    });

    it('warns about tokens expiring within 7 days or expired', async () => {
        const soon = day(3);
        await seedTokens(
            `
    - { name: soon, tier: read, hash: '${hashToken('a'.repeat(40))}', expires: '${soon}' }` +
                `
    - { name: old, tier: read, hash: '${hashToken('b'.repeat(40))}', expires: '2020-01-01' }`
        );
        const page = await (await call('/ui')).text();
        expect(page).toContain(`token &#39;soon&#39; expires on ${soon}`);
        expect(page).toContain('token &#39;old&#39; expired on 2020-01-01');
    });

    it('warns about tokens still plaintext on disk', async () => {
        await seedTokens(`
    - { name: ci, tier: write, token: '${'y'.repeat(40)}' }`);
        const page = await (await call('/ui')).text();
        expect(page).toContain('Still plaintext in config.yaml');
        expect(page).not.toContain('y'.repeat(40));
    });
});

describe('the token reveal panel', () => {
    let n = 0;
    const create = async () =>
        (
            await call(
                '/ui/config/tokens/add',
                form({ csrf: await csrfFrom(), 'token.name': `phone${n++}`, 'token.tier': 'read', 'token.expiry': '90' })
            )
        ).text();

    it('offers "Copy URL with token" only while allow_token_in_url is on', async () => {
        await signIn();
        expect(await create()).not.toContain('data-copy-url-token');

        await call(
            '/ui/config/mcp',
            form({ csrf: await csrfFrom(), 'auth.allow_token_in_url': 'on', 'auth.allowed_hosts': '' })
        );
        expect(await create()).toContain('data-copy-url-token');
    });

    it('ships the client config textarea empty and the token exactly once', async () => {
        await signIn();
        await call(
            '/ui/config/mcp',
            form({ csrf: await csrfFrom(), 'auth.allow_token_in_url': 'on', 'auth.allowed_hosts': '' })
        );
        const page = await create();
        const token = /value="(amcp_[0-9a-f]{64})"/.exec(page)?.[1] as string;

        expect(page).toContain('data-copy-config="mcp-config"');
        expect(page).toMatch(/<textarea id="mcp-config"[^>]*><\/textarea>/);
        expect(page.split(token).length - 1).toBe(1);
        expect(page).not.toMatch(/\?token=amcp_/);
    });
});

describe('the OAuth card', async () => {
    const ISSUER = 'https://auth.example.com';

    let mode:
        | 'ok'
        | 'http502'
        | 'html'
        | 'empty'
        | 'oct'
        | 'redirect'
        | 'noContent'
        | 'big'
        | 'bigChunked'
        | 'stringKey'
        | 'enc' = 'ok';
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
    const MIB = 1024 * 1024;
    const json = { 'content-type': 'application/json' };
    let served = 0;
    const jwks = createServer((_req, res) => {
        served += 1;
        if (mode === 'http502') return void res.writeHead(502).end('{}');
        if (mode === 'html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>');
        if (mode === 'empty') return void res.writeHead(200, json).end('{"keys":[]}');
        if (mode === 'redirect') return void res.writeHead(301, { location: "/jwks/'x'?a=1&b=2" }).end();
        if (mode === 'noContent') return void res.writeHead(204).end();
        if (mode === 'big') return void res.writeHead(200, json).end(`{"keys":[],"pad":"${'x'.repeat(MIB + 10)}"}`);
        if (mode === 'bigChunked') {
            // No content-length, so only a running count catches it.
            res.writeHead(200, json);
            res.write(`{"keys":[],"pad":"`);
            for (let i = 0; i < 20; i += 1) res.write('x'.repeat(128 * 1024));
            return void res.end('"}');
        }
        if (mode === 'stringKey') return void res.writeHead(200, json).end('{"keys":["x"]}');
        if (mode === 'enc') return void res.writeHead(200, json).end(JSON.stringify({ keys: [{ ...jwk, use: 'enc' }] }));
        const keys = mode === 'oct' ? [jwk, { kty: 'oct', kid: 'shared', k: 'c2VjcmV0' }] : [jwk];
        res.writeHead(200, json).end(JSON.stringify({ keys }));
    });
    await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve));
    afterAll(() => void jwks.close());
    const JWKS_URI = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;

    // A port that was open a moment ago and is not now.
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const CLOSED_URI = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/jwks`;
    await new Promise<void>(resolve => closed.close(() => resolve()));

    const fields = (over: Record<string, string> = {}) => ({
        'auth.oauth.issuer': ISSUER,
        'auth.oauth.audience': 'arr-mcp',
        'auth.oauth.jwks_uri': JWKS_URI,
        'auth.oauth.scopes.read': 'arr-mcp:read',
        'auth.oauth.scopes.write': 'arr-mcp:write',
        'auth.oauth.scopes.destructive': 'arr-mcp:destructive',
        ...over
    });

    const post = async (path: string, body: Record<string, string> = {}) =>
        call(path, form({ csrf: await csrfFrom(), ...body }));

    const decoded = async (res: Response) =>
        (await res.text()).replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');

    const valueOf = (page: string, name: string) =>
        new RegExp(`name="${name.replaceAll('.', '\\.')}"[^>]*value="([^"]*)"`).exec(page)?.[1];

    const signed = (scope: string) =>
        new SignJWT({ iss: ISSUER, aud: 'arr-mcp', sub: 'client-1', scope })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);

    const mcp = (token: string) =>
        app.request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });

    beforeEach(() => {
        mode = 'ok';
    });

    it('sits in the Access section after the MCP endpoint card, anchored as #oauth', async () => {
        await signIn();
        const page = await everyConfigTab();

        expect(page).toContain('id="oauth"');
        expect(page.indexOf('id="oauth"')).toBeGreaterThan(page.indexOf('/ui/config/mcp'));
        expect(page).toContain('/ui/config/oauth');
        // Nothing to remove yet.
        expect(page).not.toContain('/ui/config/oauth/remove');
    });

    it('pre-fills the scope fields with the defaults when OAuth is absent', async () => {
        await signIn();
        const page = await everyConfigTab();

        expect(valueOf(page, 'auth.oauth.scopes.read')).toBe('arr-mcp:read');
        expect(valueOf(page, 'auth.oauth.scopes.write')).toBe('arr-mcp:write');
        expect(valueOf(page, 'auth.oauth.scopes.destructive')).toBe('arr-mcp:destructive');
        expect(valueOf(page, 'auth.oauth.issuer')).toBe('');
    });

    it('saves OAuth, trimmed, with the pre-filled scopes, and touches nothing else', async () => {
        await signIn();
        const before = runtime.config;
        const page = await everyConfigTab();

        const res = await post('/ui/config/oauth', {
            'auth.oauth.issuer': `  ${ISSUER} `,
            'auth.oauth.audience': ' arr-mcp ',
            'auth.oauth.jwks_uri': JWKS_URI,
            'auth.oauth.scopes.read': valueOf(page, 'auth.oauth.scopes.read') ?? '',
            'auth.oauth.scopes.write': valueOf(page, 'auth.oauth.scopes.write') ?? '',
            'auth.oauth.scopes.destructive': valueOf(page, 'auth.oauth.scopes.destructive') ?? ''
        });

        expect(res.status).toBe(200);
        expect(runtime.config.auth.oauth).toEqual({
            issuer: ISSUER,
            audience: 'arr-mcp',
            jwks_uri: JWKS_URI,
            scopes: { read: 'arr-mcp:read', write: 'arr-mcp:write', destructive: 'arr-mcp:destructive' }
        });
        const { oauth: _oauth, ...restAfter } = runtime.config.auth;
        expect(restAfter).toEqual(before.auth);
        expect(runtime.config.services).toEqual(before.services);
    });

    it('still saves a loopback key set', async () => {
        await signIn();
        expect((await post('/ui/config/oauth', fields())).status).toBe(200);
        expect(runtime.config.auth.oauth?.jwks_uri).toBe(JWKS_URI);
    });

    it('pre-fills every field with the current values once configured', async () => {
        await signIn();
        await post('/ui/config/oauth', fields({ 'auth.oauth.scopes.read': 'mcp.read' }));
        const page = await everyConfigTab();

        expect(valueOf(page, 'auth.oauth.issuer')).toBe(ISSUER);
        expect(valueOf(page, 'auth.oauth.audience')).toBe('arr-mcp');
        expect(valueOf(page, 'auth.oauth.jwks_uri')).toBe(JWKS_URI);
        expect(valueOf(page, 'auth.oauth.scopes.read')).toBe('mcp.read');
        expect(page).toContain('/ui/config/oauth/remove');
    });

    it('refuses a plain-http issuer off loopback, naming the issuer, and saves nothing', async () => {
        await signIn();
        const res = await post('/ui/config/oauth', fields({ 'auth.oauth.issuer': 'http://auth.example.com' }));

        expect(res.status).toBe(400);
        const page = await decoded(res);
        expect(page).toMatch(/[Ii]ssuer/);
        expect(page).toContain('Issuer: must be https, or http on localhost.');
        expect(page).not.toContain('✖');
        expect(runtime.config.auth.oauth).toBeUndefined();
    });

    it('refuses duplicate scope names and saves nothing', async () => {
        await signIn();
        const res = await post('/ui/config/oauth', fields({ 'auth.oauth.scopes.write': 'arr-mcp:read' }));

        expect(res.status).toBe(400);
        expect(await decoded(res)).toContain('Scopes: must name three distinct scopes.');
        expect(runtime.config.auth.oauth).toBeUndefined();
    });

    it('keeps what was typed when a save is refused', async () => {
        await signIn();
        const res = await post('/ui/config/oauth', fields({ 'auth.oauth.issuer': 'http://auth.example.com' }));

        expect(valueOf(await res.text(), 'auth.oauth.issuer')).toBe('http://auth.example.com');
    });

    it('shows the current OAuth config, not the typed draft, when the page was stale', async () => {
        await signIn();
        const stale = keysFrom(await everyConfigTab());
        await post('/ui/config/oauth', fields());

        const res = await call('/ui/config/oauth', form({ ...stale, ...fields({ 'auth.oauth.audience': 'typed' }) }));

        expect(res.status).toBe(409);
        expect(valueOf(await res.text(), 'auth.oauth.audience')).toBe('arr-mcp');
    });

    it('refuses to save while the URL token is on, in a sentence, and saves nothing', async () => {
        await signIn();
        await post('/ui/config/mcp', { 'auth.allow_token_in_url': 'on', 'auth.allowed_hosts': '' });
        expect(runtime.config.auth.allow_token_in_url).toBe(true);

        const res = await post('/ui/config/oauth', fields());

        expect(res.status).toBe(400);
        expect(await decoded(res)).toContain(
            "Turn off 'Accept the token in the URL' on the MCP endpoint card first. A JWT in the URL reaches every proxy log."
        );
        expect(runtime.config.auth.oauth).toBeUndefined();
    });

    it('points the MCP endpoint card at the OAuth card rather than config.yaml', async () => {
        await signIn();
        await post('/ui/config/oauth', fields());

        const page = await everyConfigTab();
        expect(page).toContain('Unavailable while OAuth is configured');
        const refused = await decoded(
            await post('/ui/config/mcp', { 'auth.allow_token_in_url': 'on', 'auth.allowed_hosts': '' })
        );
        expect(refused).toContain('OAuth is configured');
        expect(refused).toContain('OAuth card');
        expect(refused).not.toContain('auth.oauth block from config.yaml');
    });

    it('asks before removing OAuth, then removes it', async () => {
        await signIn();
        await post('/ui/config/oauth', fields());

        const asking = await post('/ui/config/oauth/remove', fields());
        expect(asking.status).toBe(200);
        expect(await asking.text()).toContain('Yes, remove OAuth');
        expect(runtime.config.auth.oauth).toBeDefined();

        const removed = await post('/ui/config/oauth/remove', { confirm: 'yes' });
        expect(removed.status).toBe(200);
        expect(runtime.config.auth.oauth).toBeUndefined();
    });

    describe('Test', () => {
        // Test refuses a loopback key set, so the tests reach the local servers
        // through a public-looking name that fetch maps back.
        const REMOTE = 'https://jwks.example.com/jwks';
        const CLOSED_REMOTE = 'https://closed.example.com/jwks';
        beforeEach(() => {
            const real = globalThis.fetch;
            vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                const target = url === REMOTE ? JWKS_URI : url === CLOSED_REMOTE ? CLOSED_URI : input;
                return real(target, init);
            });
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        const test = async (over: Record<string, string> = {}) => {
            const before = runtime.config;
            const res = await post('/ui/config/oauth/test', fields({ 'auth.oauth.jwks_uri': REMOTE, ...over }));
            const page = await decoded(res);
            // A test never saves, whatever it finds.
            expect(runtime.config).toBe(before);
            return { res, page };
        };

        it('lists each key with its kid and alg, and keeps the typed values', async () => {
            await signIn();
            const { res, page } = await test({ 'auth.oauth.audience': 'typed-audience' });

            expect(res.status).toBe(200);
            expect(page).toContain('test-key');
            expect(page).toContain('RS256');
            expect(valueOf(page, 'auth.oauth.audience')).toBe('typed-audience');
            expect(runtime.config.auth.oauth).toBeUndefined();
        });

        it('reports an HTTP error status', async () => {
            await signIn();
            mode = 'http502';
            expect((await test()).page).toContain('HTTP 502');
        });

        const refused = (page: string) => {
            expect(page).toContain('class="msg err"');
            expect(page).not.toContain('class="msg ok"');
        };

        // jose fetches with `redirect: 'manual'` and wants exactly 200, so a
        // redirect that a browser would follow is a 503 at /mcp.
        it('reports a redirect without following it, and leaves the target out of the page and the log', async () => {
            await signIn();
            mode = 'redirect';
            attachLogStore(logs);
            let raw: string;
            try {
                const res = await post('/ui/config/oauth/test', fields({ 'auth.oauth.jwks_uri': REMOTE }));
                raw = await res.text();
            } finally {
                detachLogStore();
            }

            expect(raw).toContain('HTTP 301');
            expect(raw).toContain('redirects are not followed');
            // The target is the issuer's to name, so it is left out.
            expect(raw).not.toContain('example.com/jwks/');
            expect(raw).not.toContain('&#39;x&#39;');
            expect(raw).not.toContain("'x'?a=1&b");
            expect(raw).not.toContain('test-key');
            expect(JSON.stringify(logs.recent({ limit: 50 }))).not.toContain('/jwks/');
        });

        it('refuses to test a loopback key set, and fetches nothing', async () => {
            await signIn();
            const before = runtime.config;
            const servedBefore = served;
            const res = await post('/ui/config/oauth/test', fields({ 'auth.oauth.jwks_uri': JWKS_URI }));
            const page = await decoded(res);

            expect(res.status).toBe(400);
            expect(page).toContain('class="msg err"');
            expect(page).toContain('will not test a key set on this machine');
            expect(served).toBe(servedBefore);
            expect(runtime.config).toBe(before);
        });

        it.each([
            ['localhost', true],
            ['app.localhost', true],
            ['127.0.0.1', true],
            ['127.1.2.3', true],
            ['[::1]', true],
            ['0.0.0.0', true],
            ['[::]', true],
            ['[::ffff:127.0.0.1]', true],
            ['[::ffff:7f00:1]', true],
            ['[::ffff:7f12:3456]', true],
            ['[::ffff:808:808]', false],
            ['localhost.', true],
            ['foo.localhost.', true],
            ['[0:0:0:0:0:0:0:1]', true],
            ['2130706433', true],
            ['auth.example.com', false]
        ])('isLoopbackHost(new URL(https://%s/).hostname) is %s', (host, expected) => {
            expect(isLoopbackHost(new URL(`https://${host}/`).hostname)).toBe(expected);
        });

        it.each([
            'https://[::ffff:127.0.0.1]/jwks',
            'https://localhost./jwks',
            'https://foo.localhost./jwks'
        ])('refuses %s through the Test button, and fetches nothing', async (uri) => {
            await signIn();
            const servedBefore = served;
            const res = await post('/ui/config/oauth/test', fields({ 'auth.oauth.jwks_uri': uri }));
            const page = await decoded(res);

            expect(res.status).toBe(400);
            expect(page).toContain('will not test a key set on this machine');
            expect(served).toBe(servedBefore);
        });

        it('refuses a 2xx that is not 200', async () => {
            await signIn();
            mode = 'noContent';
            const { page } = await test();
            expect(page).toContain('HTTP 204');
            refused(page);
        });

        it('refuses a key set declared larger than 1 MiB', async () => {
            await signIn();
            mode = 'big';
            const { page } = await test();
            expect(page).toContain('The key set is larger than 1 MiB');
            refused(page);
        });

        it('stops reading a streamed key set past 1 MiB', async () => {
            await signIn();
            mode = 'bigChunked';
            const { page } = await test();
            expect(page).toContain('The key set is larger than 1 MiB');
            refused(page);
        });

        it('flags an entry that is not a key object', async () => {
            await signIn();
            mode = 'stringKey';
            refused((await test()).page);
        });

        it('flags an encryption key', async () => {
            await signIn();
            mode = 'enc';
            const { page } = await test();
            expect(page).toContain('enc');
            refused(page);
        });

        it('tests while the URL token is on, saying Save will be refused', async () => {
            await signIn();
            await post('/ui/config/mcp', { 'auth.allow_token_in_url': 'on', 'auth.allowed_hosts': '' });

            const { res, page } = await test();
            expect(res.status).toBe(200);
            expect(page).toContain('test-key');
            expect(page).toContain("Saving will be refused until 'Accept the token in the URL' is off.");
        });

        it('is never cached', async () => {
            await signIn();
            const { res } = await test();
            expect(res.headers.get('cache-control')).toBe('no-store');
        });

        it('reports a body that is not JSON', async () => {
            await signIn();
            mode = 'html';
            expect((await test()).page).toContain('not JSON');
        });

        it('reports an unreachable key set', async () => {
            await signIn();
            expect((await test({ 'auth.oauth.jwks_uri': CLOSED_REMOTE })).page).toContain('unreachable');
        });

        it('reports a key set with no keys', async () => {
            await signIn();
            mode = 'empty';
            expect((await test()).page).toContain('no keys');
        });

        it('flags a symmetric key arr-mcp will not accept', async () => {
            await signIn();
            mode = 'oct';
            const { page } = await test();
            expect(page).toContain('shared');
            expect(page).toContain('symmetric');
        });

        it('refuses a candidate the schema refuses, with a 400 naming the field', async () => {
            await signIn();
            const { res, page } = await test({ 'auth.oauth.jwks_uri': 'http://keys.example.com/jwks' });
            expect(res.status).toBe(400);
            expect(page).toContain('https, or http on localhost');
        });

        it('refuses a bad CSRF token with 403', async () => {
            await signIn();
            const before = runtime.config;
            const res = await call('/ui/config/oauth/test', form({ csrf: 'forged', ...fields() }));
            expect(res.status).toBe(403);
            expect(runtime.config).toBe(before);
        });

        it('does not save even when OAuth is already configured', async () => {
            await signIn();
            await post('/ui/config/oauth', fields());
            const saved = runtime.config.auth.oauth;

            await test({ 'auth.oauth.audience': 'something-else' });
            expect(runtime.config.auth.oauth).toEqual(saved);
        });
    });

    it('end to end: a token from the saved issuer works, and stops working after Remove', async () => {
        await signIn();
        const token = await signed('arr-mcp:read');
        expect((await mcp(token)).status).toBe(401);

        expect((await post('/ui/config/oauth', fields())).status).toBe(200);
        expect((await mcp(token)).status).toBe(200);

        await post('/ui/config/oauth/remove', { confirm: 'yes' });
        expect((await mcp(token)).status).toBe(401);
        expect((await mcp(BEARER)).status).toBe(200);
    });
});

describe('management API keys', () => {
    const shownKey = (page: string) => /value="(amk_[0-9a-f]{64})"/.exec(page)?.[1];
    const create = async (name: string, tier: string) =>
        call('/ui/config/api-keys/add', form({ csrf: await csrfFrom(), 'api-key.name': name, 'api-key.tier': tier }));
    const revoke = async (name: string, confirm?: string) =>
        call('/ui/config/api-keys/revoke', form({ csrf: await csrfFrom(), key: name, ...(confirm === undefined ? {} : { confirm }) }));
    const status = async (key: string, method = 'GET') =>
        (await app.request('http://localhost:6060/api/v1/settings/imdb', {
            method,
            headers: { 'x-api-key': key, 'content-type': 'application/json' },
            ...(method === 'GET' ? {} : { body: '{"enabled":false}' })
        })).status;

    it('is off until a key is created, then shows it once', async () => {
        await signIn();
        expect(await everyConfigTab()).toContain('until you create a key');

        const res = await create('nzb360', 'read');
        expect(res.headers.get('cache-control')).toBe('no-store');
        const page = await res.text();
        const key = shownKey(page);
        expect(key).toBeDefined();
        expect(page).toContain('http://localhost:6060/api/v1');
        expect(runtime.config.auth.management_keys).toEqual([
            { name: 'nzb360', tier: 'read', hash: hashToken(key as string), created: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string }
        ]);

        const later = await everyConfigTab();
        expect(later).not.toContain(key as string);
        expect(later).toContain('nzb360');
        expect(later).toContain(hashToken(key as string).slice(7, 15));
    });

    it('offers read first, so a key is read-only unless you choose otherwise', async () => {
        await signIn();
        expect(await everyConfigTab()).toMatch(/<option value="read" selected>/);
    });

    it('keeps each tier to what it may do', async () => {
        await signIn();
        const reader = shownKey(await (await create('dash', 'read')).text()) as string;
        const admin = shownKey(await (await create('ops', 'admin')).text()) as string;
        expect(await status(reader)).toBe(200);
        expect(await status(reader, 'PUT')).toBe(403);
        expect(await status(admin)).toBe(200);
        expect(await status(admin, 'PUT')).toBe(200);
    });

    it('refuses a tier it does not offer and a name already taken', async () => {
        await signIn();
        expect((await create('dash', 'destructive')).status).toBe(400);
        expect((await create('dash', 'read')).status).toBe(200);
        const again = await create('DASH', 'admin');
        expect(again.status).toBe(400);
        expect(await again.text()).toContain('already a key named');
        expect(runtime.config.auth.management_keys).toHaveLength(1);
    });

    it('revoking one key stops it at once and leaves the other working', async () => {
        await signIn();
        const one = shownKey(await (await create('one', 'read')).text()) as string;
        const two = shownKey(await (await create('two', 'read')).text()) as string;

        const asked = await (await revoke('one')).text();
        expect(asked).toContain('Yes, revoke one');
        expect(asked).toContain('Apps using it are refused');
        expect(await status(one)).toBe(200);

        await revoke('one', 'yes');
        expect(await status(one)).toBe(401);
        expect(await status(two)).toBe(200);
    });

    it('warns that revoking the last key turns the API off, and then it is off', async () => {
        await signIn();
        const key = shownKey(await (await create('only', 'admin')).text()) as string;
        expect(await (await revoke('only')).text()).toContain('the management API turns off');
        await revoke('only', 'yes');
        expect(runtime.config.auth.management_keys).toBeUndefined();
        expect(await status(key)).toBe(404);
    });

    it('refuses a post without a valid CSRF token', async () => {
        await signIn();
        const res = await call('/ui/config/api-keys/add', form({ csrf: 'nope', 'api-key.name': 'dash', 'api-key.tier': 'read' }));
        expect(res.status).toBe(403);
        expect(runtime.config.auth.management_keys).toBeUndefined();
    });
});

describe('finding services', () => {
    type Row = import('../src/discovery/match.ts').ResultRow;
    type Run = import('../src/discovery/run.ts').RunState;

    const baseRun = (over: Partial<Run> = {}): Run => ({
        id: 'run-1',
        phase: 'quick',
        running: false,
        tried: 3,
        total: 3,
        rows: [],
        skipped: [],
        suggestedRange: '192.168.1.0/24',
        startedAt: '2026-11-08T10:00:00.000Z',
        ...over
    });
    const row = (over: Partial<Row>): Row => ({
        type: 'radarr',
        url: 'http://192.168.1.10:7878',
        version: '5.3.6',
        source: 'host',
        status: 'new',
        ...over
    });

    let state: Run | undefined;
    const quick = vi.fn(async (_host: string | undefined, _config: unknown) => {
        state = state ?? baseRun();
        return state;
    });
    const startSweep = vi.fn((range: string, _config: unknown): Run | { refused: string } => {
        if (range === 'nonsense') return { refused: 'That is not a range arr-mcp can scan.' };
        state = baseRun({ phase: 'sweep', running: true, range, tried: 142, total: 256 });
        return state;
    });

    beforeEach(() => {
        state = undefined;
        quick.mockClear();
        startSweep.mockClear();
        app = buildApp({ runtime, audit, logs, discovery: stub() });
    });

    const stub = () => ({ quick, startSweep, view: async () => state });

    const servicesPage = async (query = ''): Promise<string> =>
        (await call(`/ui/config?tab=services${query}`)).text();

    it('sends a signed-out visitor to sign-in and runs nothing', async () => {
        cookie = '';
        for (const path of ['/ui/config/discover', '/ui/config/discover/sweep']) {
            const res = await call(path, form({ csrf: 'x', range: '192.168.1.0/24' }));
            expect(res.status).toBe(302);
            expect(res.headers.get('location')).toBe('/ui/login');
        }
        expect(quick).not.toHaveBeenCalled();
        expect(startSweep).not.toHaveBeenCalled();
    });

    it('refuses a post without a valid CSRF token', async () => {
        await signIn();
        const a = await call('/ui/config/discover', form({ csrf: 'wrong' }));
        const b = await call('/ui/config/discover/sweep', form({ csrf: 'wrong', range: '192.168.1.0/24' }));
        expect(a.status).toBe(403);
        expect(b.status).toBe(403);
        expect(quick).not.toHaveBeenCalled();
        expect(startSweep).not.toHaveBeenCalled();
    });

    it('runs the quick scan with the Host header and redirects to the services tab', async () => {
        await signIn();
        const post = form({ csrf: await csrfFrom() });
        const res = await call('/ui/config/discover', {
            ...post,
            headers: { ...(post.headers as Record<string, string>), host: 'localhost:6060' }
        });
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/ui/config?tab=services');
        expect(quick).toHaveBeenCalledTimes(1);
        expect(quick.mock.calls[0]?.[0]).toBe('localhost:6060');
    });

    it('offers Find services on the services tab only', async () => {
        await signIn();
        expect(await servicesPage()).toContain('action="/ui/config/discover"');
        state = baseRun({ rows: [row({})] });
        const other = await (await call('/ui/config?tab=settings')).text();
        expect(other).not.toContain('Find services');
        expect(other).not.toContain('192.168.1.10:7878');
    });

    it('lists each row by status', async () => {
        await signIn();
        state = baseRun({
            rows: [
                row({}),
                row({ type: 'sonarr', url: 'http://192.168.1.10:8989', version: '4.0.1', status: 'added' }),
                row({
                    type: 'jellyfin',
                    url: 'http://192.168.1.10:8096',
                    version: '10.9.0',
                    status: 'configured',
                    existingUrl: 'http://jelly:8096'
                }),
                row({
                    type: 'lidarr',
                    url: 'http://192.168.1.10:8686',
                    version: '2.0.0',
                    status: 'maybe-second',
                    existingUrl: 'http://lidarr:8686'
                }),
                row({ type: 'prowlarr', url: 'http://192.168.1.10:9696', alsoAt: 'http://prowlarr:9696' })
            ]
        });
        const page = await servicesPage();

        expect(page).toContain('5.3.6');
        expect(page).toContain('href="/ui/config?tab=services&amp;add_type=radarr&amp;add_url=http%3A%2F%2F192.168.1.10%3A7878"');
        expect(page).toContain('already added');
        expect(page).not.toContain('add_type=sonarr');
        expect(page).toContain('already configured at');
        expect(page).toContain('http://jelly:8096');
        expect(page).not.toContain('add_type=jellyfin');
        expect(page).toContain('If this is a different one, add it as a second instance');
        expect(page).toContain('add_type=lidarr');
        expect(page).toContain('also reachable at');
        expect(page).toContain('http://prowlarr:9696');
    });

    it('lists what was skipped, with the reason', async () => {
        await signIn();
        state = baseRun({ skipped: [{ what: 'example.com', reason: 'not a private address' }] });
        const page = await servicesPage();
        expect(page).toContain('example.com');
        expect(page).toContain('not a private address');
    });

    it('says so when nothing was found', async () => {
        await signIn();
        state = baseRun();
        expect(await servicesPage()).toContain('Nothing found');
    });

    it('offers the sweep with the suggested range and says it is a port scan', async () => {
        await signIn();
        state = baseRun();
        const page = await servicesPage();
        expect(page).toContain('action="/ui/config/discover/sweep"');
        expect(page).toMatch(/name="range"[^>]*value="192\.168\.1\.0\/24"/);
        expect(page).toContain('port scan');
    });

    it('starts a sweep and redirects', async () => {
        await signIn();
        const res = await call('/ui/config/discover/sweep', form({ csrf: await csrfFrom(), range: '192.168.1.0/24' }));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/ui/config?tab=services');
        expect(startSweep).toHaveBeenCalledWith('192.168.1.0/24', expect.anything());
    });

    it('shows a refused range as an error on the page', async () => {
        await signIn();
        const res = await call('/ui/config/discover/sweep', form({ csrf: await csrfFrom(), range: 'nonsense' }));
        expect(res.status).toBe(400);
        const page = await res.text();
        expect(page).toContain('class="msg err"');
        expect(page).toContain('That is not a range arr-mcp can scan.');
    });

    it('reloads itself with progress while a run is going, and stops when it is done', async () => {
        await signIn();
        state = baseRun({ phase: 'sweep', running: true, range: '192.168.1.0/24', tried: 142, total: 256, rows: [row({})] });
        const running = await servicesPage();
        expect(running).toContain('<noscript><meta http-equiv="refresh" content="2"></noscript>');
        expect(running).toContain('data-reload="2"');
        expect(running).toContain('142 of 256 addresses tried');
        expect(running).toContain('5.3.6');

        state = { ...state, running: false, tried: 256 };
        const done = await servicesPage();
        expect(done).not.toContain('<meta http-equiv="refresh"');
        expect(done).not.toContain('data-reload=');
    });

    it('does not reload a page whose add dialog is open, but still shows progress and a link', async () => {
        await signIn();
        state = baseRun({ phase: 'sweep', running: true, range: '192.168.1.0/24', tried: 142, total: 256, rows: [row({})] });
        const page = await servicesPage('&add_type=radarr&add_url=http%3A%2F%2F192.168.1.10%3A7878');
        expect(page).not.toContain('<meta http-equiv="refresh"');
        expect(page).toContain('<dialog id="add-service" open');
        expect(page).not.toContain('data-reload=');
        expect(page).toContain('142 of 256 addresses tried');
        expect(page).toContain('<a href="/ui/config?tab=services">Reload</a>');
        expect(page).not.toContain('while a form is open');

        expect(await servicesPage()).toContain('<meta http-equiv="refresh"');
    });

    it('does not reload an error render during a running sweep', async () => {
        await signIn();
        state = baseRun({ phase: 'sweep', running: true, range: '192.168.1.0/24', tried: 142, total: 256 });
        const refused = await call('/ui/config/discover/sweep', form({ csrf: await csrfFrom(), range: 'nonsense' }));
        expect(refused.status).toBe(400);
        const page = await refused.text();
        expect(page).toContain('142 of 256 addresses tried');
        expect(page).not.toContain('<meta http-equiv="refresh"');

        const stale = await call('/ui/config/discover', form({ csrf: 'wrong' }));
        expect(stale.status).toBe(403);
        expect(await stale.text()).not.toContain('<meta http-equiv="refresh"');
    });

    it('opens the add dialog with the type and address filled in and no credential', async () => {
        await signIn();
        state = baseRun({ rows: [row({})] });
        const page = await servicesPage('&add_type=radarr&add_url=http%3A%2F%2F192.168.1.10%3A7878');
        expect(page).toContain('<dialog id="add-service" open');
        expect(page).toMatch(/<option value="radarr" selected>/);
        expect(page).toMatch(/id="add\.url"[^>]*value="http:\/\/192\.168\.1\.10:7878"/);
        expect(page).toMatch(/id="add\.api_key"[^>]*value=""/);
    });

    it('ignores an unknown type or a non-http address', async () => {
        await signIn();
        state = baseRun({ rows: [row({})] });
        for (const q of [
            '&add_type=evil&add_url=http%3A%2F%2F192.168.1.10%3A7878',
            '&add_type=radarr&add_url=javascript%3Aalert(1)',
            '&add_type=radarr&add_url=ftp%3A%2F%2Fhost',
            '&add_type=radarr&add_url=not%20a%20url'
        ]) {
            const page = await servicesPage(q);
            expect(page).not.toContain('<dialog id="add-service" open');
            expect(page).not.toContain('javascript:alert');
        }
    });

    it('escapes what a service reports', async () => {
        await signIn();
        state = baseRun({ rows: [row({ version: '<script>alert(1)</script>' })] });
        const page = await servicesPage();
        expect(page).toContain('&lt;script&gt;');
        expect(page).not.toContain('<script>alert(1)');
    });

    it('names what a quick search tried instead of counting addresses', async () => {
        await signIn();
        state = baseRun({ hostTried: '192.168.1.10', hostAddress: '192.168.1.10', containersResolved: 2, tried: 1, total: 1 });
        const page = await servicesPage();
        expect(page).not.toContain('addresses tried');
        expect(page).toContain('this host (192.168.1.10)');
        expect(page).toContain('container names: 2 resolved');

        state = baseRun({ containersResolved: 0, tried: 0, total: 0, skipped: [{ what: 'localhost', reason: 'not a private address' }] });
        const skipped = await servicesPage();
        expect(skipped).not.toContain('this host (');
        expect(skipped).toContain('container names: 0 resolved');
        expect(skipped).not.toContain('0 of 0');
    });

    it('says a quick search failed rather than that it found nothing', async () => {
        await signIn();
        state = baseRun({ failed: true, containersResolved: 0 });
        const page = await servicesPage();
        expect(page).toContain('The search failed; the logs page has the error.');
        expect(page).not.toContain('Nothing found');
    });

    it('ignores a prefill of a type the add dialog does not offer', async () => {
        await seed('  whisparr:\n    url: http://192.0.2.10:6969\n    api_key: k\n');
        app = buildApp({ runtime, audit, logs, discovery: stub() });
        await signIn();
        state = baseRun({ rows: [row({ type: 'whisparr', url: 'http://192.168.1.10:6969', status: 'configured' })] });
        const page = await servicesPage('&add_type=whisparr&add_url=http%3A%2F%2F192.168.1.10%3A6969');
        expect(page).not.toContain('<dialog id="add-service" open');
        expect(page).not.toMatch(/id="add\.url"[^>]*value="http:\/\/192\.168\.1\.10:6969"/);
    });

    it('ignores a prefill whose host is not a private address', async () => {
        await signIn();
        state = baseRun({ rows: [row({})] });
        for (const q of ['&add_type=radarr&add_url=http%3A%2F%2F8.8.8.8%3A7878', '&add_type=radarr&add_url=http%3A%2F%2Fevil.example%3A7878']) {
            const page = await servicesPage(q);
            expect(page).not.toContain('<dialog id="add-service" open');
            expect(page).not.toContain('8.8.8.8');
            expect(page).not.toContain('evil.example');
        }
    });

    it('honours a prefill that matches a found row, by its address or its also-reachable address', async () => {
        await signIn();
        state = baseRun({ rows: [row({ alsoAt: 'http://radarr:7878' })] });
        for (const url of ['http%3A%2F%2F192.168.1.10%3A7878', 'http%3A%2F%2Fradarr%3A7878']) {
            const page = await servicesPage(`&add_type=radarr&add_url=${url}`);
            expect(page).toContain('<dialog id="add-service" open');
            expect(page).toMatch(/<option value="radarr" selected>/);
        }
    });

    it('ignores a prefill that is not a row of the current run, even on a private address', async () => {
        await signIn();
        state = baseRun({ rows: [row({})] });
        for (const q of ['&add_type=radarr&add_url=http%3A%2F%2F192.168.1.99%3A7878', '&add_type=sonarr&add_url=http%3A%2F%2F192.168.1.10%3A7878']) {
            const page = await servicesPage(q);
            expect(page).not.toContain('<dialog id="add-service" open');
        }
    });

    it('ignores a prefill when there is no run', async () => {
        await signIn();
        state = undefined;
        const page = await servicesPage('&add_type=radarr&add_url=http%3A%2F%2F192.168.1.10%3A7878');
        expect(page).not.toContain('<dialog id="add-service" open');
    });

    it('marks a found service as already added once it is added, with no Add link', async () => {
        const { Discovery } = await import('../src/discovery/run.ts');
        const discovery = new Discovery({
            catalog: [{ type: 'radarr', port: 7878, containerNames: [], path: '/', identify: () => ({ version: '5.3.6' }) }],
            lookup: async () => {
                throw new Error('ENOTFOUND');
            },
            probe: async (host, entries, source) => entries.map(e => ({ type: e.type, url: `http://${host}:${e.port}`, version: '5.3.6', source }))
        });
        app = buildApp({ runtime, audit, logs, discovery });
        await signIn();
        const post = form({ csrf: await csrfFrom() });
        await call('/ui/config/discover', { ...post, headers: { ...(post.headers as Record<string, string>), host: '192.168.1.10:6060' } });
        expect(await servicesPage()).toContain('add_type=radarr');

        const added = await call(
            '/ui/config/add',
            form({ csrf: await csrfFrom(), type: 'radarr', url: 'http://192.168.1.10:7878', api_key: 'k' })
        );
        expect(added.status).toBe(200);

        const page = await servicesPage();
        expect(page).toContain('already added');
        expect(page).not.toContain('add_type=radarr');
    });

    it('asks a user-aware service for its users once while a sweep reloads the page and the list is fetched', async () => {
        let asked = 0;
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).includes('/Users')) {
                asked += 1;
                return new Response(JSON.stringify([{ Id: 'id-0', Name: 'bartus' }]), { headers: { 'content-type': 'application/json' } });
            }
            return new Response('{}', { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        try {
            await seed('  jellyfin:\n    url: http://192.0.2.10:8096\n    api_key: k\n');
            app = buildApp({ runtime, audit, logs, discovery: stub() });
            await signIn();
            state = baseRun({ phase: 'sweep', running: true, range: '192.168.1.0/24', tried: 10, total: 256 });
            await servicesPage();
            await servicesPage();
            expect(asked).toBe(0);
            const first = await (await call('/ui/config/users.json')).text();
            await call('/ui/config/users.json');
            await call('/ui/config/users.json');
            expect(asked).toBe(1);
            expect(first).toContain('bartus');
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('logs who started a scan', async () => {
        await signIn();
        const info = vi.spyOn(logger, 'info');
        await call('/ui/config/discover/sweep', form({ csrf: await csrfFrom(), range: '192.168.1.0/24' }));
        const lines = info.mock.calls.map(c => JSON.stringify(c));
        info.mockRestore();
        expect(lines.some(l => l.includes('192.168.1.0/24') && l.includes('ip'))).toBe(true);
    });
});
