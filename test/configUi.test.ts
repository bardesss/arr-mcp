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
import { hashToken } from '../src/core/mcpTokens.ts';
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

        const page = await (await call('/ui/config')).text();
        expect(page).toContain('192.0.2.10:7878');
        expect(page).not.toContain('super-secret-key');
    });

    it('never renders the password hash', async () => {
        await signIn();
        expect(await (await call('/ui/config')).text()).not.toContain('scrypt$');
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

        expect(await (await call('/ui/config')).text()).not.toContain('type="password"');
    });

    it('masks the secret fields all the same', async () => {
        await seed(BOTH_KINDS);
        await signIn();
        const page = await (await call('/ui/config')).text();

        for (const name of ['api_key', 'password', 'auth.password']) {
            expect(page).toMatch(new RegExp(`class="secret"[^>]*name="${name.replace('.', '\\.')}"`));
        }
    });

    it('opts every field out for the managers that honour an attribute', async () => {
        await seed(BOTH_KINDS);
        await signIn();
        const page = await (await call('/ui/config')).text();

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

describe('the configuration page', () => {
    it('shows an empty state rather than eight blank fieldsets', async () => {
        await signIn();
        const page = await (await call('/ui/config')).text();

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
        const page = await (await call('/ui/config')).text();

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
        const page = await (await call('/ui/config')).text();

        expect(page).toContain('data-open="add-service"');
        expect(page).toContain('<dialog id="add-service"');
        expect(page).toContain('action="/ui/config/add"');
    });

    it('falls back to an inline form when scripting is off', async () => {
        await signIn();
        const page = await (await call('/ui/config')).text();

        expect(page).toContain('<noscript>');
        expect(page).toMatch(/<noscript><style>[^<]*dialog\b/);
    });

    it('says which service each field belongs to, so the picker can hide the rest', async () => {
        await signIn();
        const page = await (await call('/ui/config')).text();

        // The two torrent clients are the services with no API key, and the
        // only ones with a username and password.
        const apiKey = /data-only="([^"]*)"[^>]*>\s*<label for="add\.api_key"/.exec(page)?.[1] ?? '';
        expect(apiKey.split(' ')).not.toContain('transmission');
        expect(apiKey.split(' ')).not.toContain('qbittorrent');
        expect(apiKey.split(' ')).toContain('radarr');

        for (const field of ['username', 'password']) {
            const only = new RegExp(`data-only="([^"]*)"[^>]*>\\s*<label for="add\\.${field}"`).exec(page)?.[1];
            expect(only?.split(' ').sort()).toEqual(['qbittorrent', 'transmission']);
        }
    });

    /** Offering a service that can only have one instance, when it already has
     *  one, is a click whose only outcome is "already configured". */
    it('drops a configured single-instance service from the picker', async () => {
        await seed(
            '  seerr:\n    url: http://192.0.2.10:5055\n    api_key: k\n' +
                '  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n'
        );
        await signIn();
        const page = await (await call('/ui/config')).text();

        const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
        expect(offered).not.toContain('seerr');
        // Radarr takes more than one, so it stays.
        expect(offered).toContain('radarr');
        expect(page).toContain('Already configured, and limited to one instance');
    });

    /** arr-mcp joins against exactly one media server, so the schema already
     *  refuses jellyfin and plex together — the picker should not offer a
     *  choice that would only fail on save. */
    describe('the media server rivalry', () => {
        it('offers plex when no media server is configured', async () => {
            await signIn();
            const page = await (await call('/ui/config')).text();

            const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
            expect(offered).toContain('plex');
            expect(offered).toContain('jellyfin');
        });

        it('does not offer plex once jellyfin is configured, and says why', async () => {
            await seed('  jellyfin:\n    url: http://192.0.2.10:8096\n    api_key: k\n');
            await signIn();
            const page = await (await call('/ui/config')).text();

            const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
            expect(offered).not.toContain('plex');
            // Distinct from the "already configured, limited to one instance"
            // sentence — plex itself is not configured, jellyfin is.
            expect(page).toMatch(/media server/i);
        });

        it('does not offer jellyfin once plex is configured', async () => {
            await seed('  plex:\n    url: http://192.0.2.10:32400\n    api_key: k\n');
            await signIn();
            const page = await (await call('/ui/config')).text();

            // jellyfin is hidden as the rival; plex itself is also gone, but
            // for the pre-existing "already configured" reason.
            const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
            expect(offered).not.toContain('jellyfin');
            expect(offered).not.toContain('plex');
        });
    });

    it('offers a name only for the services that already have an instance', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n');
        await signIn();
        const page = await (await call('/ui/config')).text();

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

    // The mock goes in before `seed`, because that is when the adapters are
    // built and each one captures the `fetch` it will use.
    it('suggests the users the service reported', async () => {
        withUsers(['bartus', 'guest']);
        await seed(JELLYFIN);
        await signIn();

        const page = await (await call('/ui/config')).text();

        expect(page).toContain('<datalist id="svc.jellyfin.default_user.options">');
        expect(page).toContain('<option value="bartus">');
        expect(page).toContain('<option value="guest">');
        expect(page).toContain('Pick one of the 2 users jellyfin reported');
    });

    /** The field has to stay usable when the service is down — that is most of
     *  why anyone opens this page. */
    it('falls back to a typeable field when the service does not answer', async () => {
        globalThis.fetch = (async () => {
            throw new Error('connection refused');
        }) as typeof fetch;
        await seed(JELLYFIN);
        await signIn();

        const page = await (await call('/ui/config')).text();

        expect(page).not.toContain('<datalist');
        expect(page).toContain('did not answer when asked who its users are');
        // Still an editable field holding what is configured.
        expect(page).toContain('name="default_user"');
        expect(page).toContain('value="me"');
    });

    it('says so when the service reports no users at all', async () => {
        withUsers([]);
        await seed(JELLYFIN);
        await signIn();

        expect(await (await call('/ui/config')).text()).toContain('jellyfin reports no users yet');
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
            const page = await (await call('/ui/config')).text();

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
        const page = await (await call('/ui/config')).text();
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
        const page = await (await call('/ui/config')).text();

        expect(page.match(/name="allow_metadata_repair"/g)).toHaveLength(1);
        expect(page).toContain('experimental');
        expect(page).toContain('issues/312');
    });

    it('turns the repair on and off from the card', async () => {
        await seed(PLEX);
        await signIn();

        await savePlex({ allow_metadata_repair: 'on' });
        expect(runtime.config.services.plex?.allow_metadata_repair).toBe(true);
        expect(await (await call('/ui/config')).text()).toMatch(/name="allow_metadata_repair"[^>]*checked/);

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

describe('saving an instance', () => {
    it('keeps an existing key when the field is left blank', async () => {
        await seed('  radarr:\n    url: http://192.0.2.10:7878\n    api_key: keep-me\n');
        await signIn();

        await call(
            '/ui/config/save',
            form({ csrf: await csrfFrom(), instance: 'radarr', url: 'http://192.0.2.10:9999', api_key: '' })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('keep-me');
        expect(onDisk).toContain('192.0.2.10:9999');
    });

    it('leaves every other instance untouched', async () => {
        await seed(
            '  radarr:\n  - name: hd\n    url: http://192.0.2.10:7878\n    api_key: hd-key\n' +
                '  - name: 4k\n    url: http://192.0.2.11:7878\n    api_key: fourk-key\n'
        );
        await signIn();

        await call(
            '/ui/config/save',
            form({ csrf: await csrfFrom(), instance: 'radarr/4k', url: 'http://192.0.2.99:7878' })
        );

        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain('hd-key');
        expect(onDisk).toContain('fourk-key');
        expect(onDisk).toContain('192.0.2.10:7878');
        expect(onDisk).toContain('192.0.2.99:7878');
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
        const keys = keysFrom(await (await call('/ui/config')).text());
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
        const keys = keysFrom(await (await call('/ui/config')).text());

        const res = await saveCard(keys);

        expect(res.status).toBe(200);
        expect(runtime.config.services.radarr).toMatchObject({ timeout_ms: 20000 });
    });

    it('carries the etag through a two-step revoke', async () => {
        await seedKeyed();
        await signIn();
        await call('/ui/config/tokens/add', form({ ...keysFrom(await (await call('/ui/config')).text()), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' }));

        const asked = await call('/ui/config/tokens/revoke', form({ ...keysFrom(await (await call('/ui/config')).text()), token: 'phone' }));
        const confirm = keysFrom(await asked.text());
        expect(confirm.etag).not.toBe('');
        const res = await call('/ui/config/tokens/revoke', form({ ...confirm, token: 'phone', confirm: 'yes' }));

        expect(res.status).toBe(200);
        expect(runtime.config.auth.tokens.some(t => t.name === 'phone')).toBe(false);
    });

    it('refuses a stale confirm the same way', async () => {
        await seedKeyed();
        await signIn();
        await call('/ui/config/tokens/add', form({ ...keysFrom(await (await call('/ui/config')).text()), 'token.name': 'phone', 'token.tier': 'read', 'token.expiry': '90' }));
        const asked = keysFrom(await (await call('/ui/config/tokens/revoke', form({ ...keysFrom(await (await call('/ui/config')).text()), token: 'phone' }))).text());

        await putSafeWrite();
        const res = await call('/ui/config/tokens/revoke', form({ ...asked, token: 'phone', confirm: 'yes' }));

        expect(res.status).toBe(409);
        expect(await res.text()).toContain(STALE);
        expect(runtime.config.auth.tokens.some(t => t.name === 'phone')).toBe(true);
    });

    // Ask, then confirm from the asking page, as a browser would.
    const confirmFlow = async (path: string, fields: Record<string, string> = {}) => {
        const asked = await call(path, form({ ...keysFrom(await (await call('/ui/config')).text()), ...fields }));
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

    it('carries the etag through turning the management API off', async () => {
        await seedKeyed();
        await signIn();
        expect((await confirmFlow('/ui/config/api-key/remove')).status).toBe(200);
        expect(runtime.config.auth.management_key).toBeUndefined();
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
        const keys = keysFrom(await (await call('/ui/config')).text());
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
        await call('/ui/config/oauth', form({ ...keysFrom(await (await call('/ui/config')).text()), 'auth.oauth.issuer': 'https://auth.example.com/', 'auth.oauth.audience': 'arr-mcp', 'auth.oauth.jwks_uri': 'https://auth.example.com/jwks/' }));
        const page = await (await call('/ui/config')).text();

        const forms = [...page.matchAll(/<form method="post"[^>]*action="([^"#]+)[^>]*>([\s\S]*?)<\/form>/g)]
            .map(m => ({ action: m[1] as string, body: m[2] as string }))
            .filter(f => f.action.startsWith('/ui/config'));
        expect(forms.map(f => f.action).sort()).toEqual([
            '/ui/config/account',
            '/ui/config/add',
            '/ui/config/api-key',
            '/ui/config/api-key/remove',
            '/ui/config/appearance',
            '/ui/config/imdb',
            '/ui/config/mcp',
            '/ui/config/save',
            '/ui/config/tokens/add',
            '/ui/config/tokens/revoke'
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
        const page = await (await call('/ui/config')).text();

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

        const later = await (await call('/ui/config')).text();
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

        const page = await (await call('/ui/config')).text();
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
        expect(await (await call('/ui/config')).text()).toContain('name="metadata.imdb"');
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
        expect(page).toMatch(/1 token · <a href="\/ui\/config#tokens">Manage<\/a>/);
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
    const jwks = createServer((_req, res) => {
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
        const page = await (await call('/ui/config')).text();

        expect(page).toContain('id="oauth"');
        expect(page.indexOf('id="oauth"')).toBeGreaterThan(page.indexOf('/ui/config/mcp'));
        expect(page).toContain('/ui/config/oauth');
        // Nothing to remove yet.
        expect(page).not.toContain('/ui/config/oauth/remove');
    });

    it('pre-fills the scope fields with the defaults when OAuth is absent', async () => {
        await signIn();
        const page = await (await call('/ui/config')).text();

        expect(valueOf(page, 'auth.oauth.scopes.read')).toBe('arr-mcp:read');
        expect(valueOf(page, 'auth.oauth.scopes.write')).toBe('arr-mcp:write');
        expect(valueOf(page, 'auth.oauth.scopes.destructive')).toBe('arr-mcp:destructive');
        expect(valueOf(page, 'auth.oauth.issuer')).toBe('');
    });

    it('saves OAuth, trimmed, with the pre-filled scopes, and touches nothing else', async () => {
        await signIn();
        const before = runtime.config;
        const page = await (await call('/ui/config')).text();

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

    it('pre-fills every field with the current values once configured', async () => {
        await signIn();
        await post('/ui/config/oauth', fields({ 'auth.oauth.scopes.read': 'mcp.read' }));
        const page = await (await call('/ui/config')).text();

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
        const stale = keysFrom(await (await call('/ui/config')).text());
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

        const page = await (await call('/ui/config')).text();
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
        const test = async (over: Record<string, string> = {}) => {
            const before = runtime.config;
            const res = await post('/ui/config/oauth/test', fields(over));
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
        it('reports a redirect without following it, naming the target escaped, and never logs it', async () => {
            await signIn();
            mode = 'redirect';
            attachLogStore(logs);
            let raw: string;
            try {
                const res = await post('/ui/config/oauth/test', fields());
                raw = await res.text();
            } finally {
                detachLogStore();
            }

            expect(raw).toContain('HTTP 301');
            expect(raw).toContain('redirects are not followed');
            // Resolved against jwks_uri, so it can be pasted straight back in.
            expect(raw).toContain(`${JWKS_URI}/&#39;x&#39;?a=1&amp;b=2`);
            expect(raw).not.toContain("'x'?a=1&b");
            expect(raw).not.toContain('test-key');
            expect(JSON.stringify(logs.recent({ limit: 50 }))).not.toContain('/jwks/');
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
            expect((await test({ 'auth.oauth.jwks_uri': CLOSED_URI })).page).toContain('unreachable');
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

describe('management API key', () => {
    const shownKey = (page: string) => /value="(amk_[0-9a-f]{64})"/.exec(page)?.[1];

    it('is off until generated, then shows the key once', async () => {
        await signIn();
        expect(await (await call('/ui/config')).text()).toContain('Generate key');

        const res = await call('/ui/config/api-key', form({ csrf: await csrfFrom() }));
        expect(res.headers.get('cache-control')).toBe('no-store');
        const page = await res.text();
        const key = shownKey(page);
        expect(key).toBeDefined();
        expect(page).toContain('http://localhost:6060/api/v1');
        expect(runtime.config.auth.management_key?.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        const later = await (await call('/ui/config')).text();
        expect(later).not.toContain(key as string);
        expect(later).toContain('Regenerate key');
    });

    it('regenerating replaces the stored hash', async () => {
        await signIn();
        await call('/ui/config/api-key', form({ csrf: await csrfFrom() }));
        const first = runtime.config.auth.management_key?.hash;
        await call('/ui/config/api-key', form({ csrf: await csrfFrom() }));
        expect(runtime.config.auth.management_key?.hash).not.toBe(first);
    });

    it('regenerating stops the old key on /api/v1 at once', async () => {
        const status = async (key: string) =>
            (await app.request('http://localhost:6060/api/v1/system/status', { headers: { 'x-api-key': key } })).status;
        await signIn();
        const old = shownKey(await (await call('/ui/config/api-key', form({ csrf: await csrfFrom() }))).text()) as string;
        expect(await status(old)).toBe(200);

        const next = shownKey(await (await call('/ui/config/api-key', form({ csrf: await csrfFrom() }))).text()) as string;
        expect(next).not.toBe(old);
        expect(await status(old)).toBe(401);
        expect(await status(next)).toBe(200);
    });

    it('asks before turning the API off, then removes the key', async () => {
        await signIn();
        await call('/ui/config/api-key', form({ csrf: await csrfFrom() }));

        const asked = await (await call('/ui/config/api-key/remove', form({ csrf: await csrfFrom() }))).text();
        expect(asked).toContain('Yes, turn the API off');
        expect(runtime.config.auth.management_key).toBeDefined();

        await call('/ui/config/api-key/remove', form({ csrf: await csrfFrom(), confirm: 'yes' }));
        expect(runtime.config.auth.management_key).toBeUndefined();
    });

    it('refuses a post without a valid CSRF token', async () => {
        await signIn();
        const res = await call('/ui/config/api-key', form({ csrf: 'nope' }));
        expect(res.status).toBe(403);
        expect(runtime.config.auth.management_key).toBeUndefined();
    });
});
