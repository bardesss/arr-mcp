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

/**
 * The same fixture as `seed`, minus `password_hash` — an *unclaimed* instance,
 * which is what a fresh install looks like before anyone visits it.
 *
 * The two `close()` calls come first because `beforeEach` has already opened a
 * claimed fixture by the time this runs, and `afterEach` only closes the latest
 * pair; without them every unclaimed test leaks a log and an audit handle.
 */
const seedUnclaimed = async () => {
    logs.close();
    audit.close();

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
};

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

    /**
     * The regression guard for the whole design. The client config is assembled
     * in the browser precisely so the token is in the HTML exactly once, inside
     * the masked field — a future change that server-renders the JSON would put
     * a live credential into readable text and into any screenshot of the page,
     * and this is what would catch it.
     */
    it('ships the config textarea empty, leaving the token in the masked field alone', async () => {
        await signIn();
        const page = await (await call('/ui')).text();

        expect(page).toContain('data-copy-config="mcp-config"');
        expect(page).toContain('<textarea id="mcp-config"');
        expect(page).toContain('></textarea>');
        expect(page.split(BEARER).length - 1).toBe(1);
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
        await seed('  prowlarr:\n    url: http://192.0.2.10:9696\n    api_key: k\n');
        await signIn();

        const res = await call(
            '/ui/config/add',
            form({ csrf: await csrfFrom(), ...addForm({ type: 'prowlarr', name: 'second' }) })
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

        // Transmission is the one service with no API key, and the only one
        // with a username and password.
        const apiKey = /data-only="([^"]*)"[^>]*>\s*<label for="add\.api_key"/.exec(page)?.[1] ?? '';
        expect(apiKey.split(' ')).not.toContain('transmission');
        expect(apiKey.split(' ')).toContain('radarr');

        for (const field of ['username', 'password']) {
            const only = new RegExp(`data-only="([^"]*)"[^>]*>\\s*<label for="add\\.${field}"`).exec(page)?.[1];
            expect(only).toBe('transmission');
        }
    });

    /** Offering a service that can only have one instance, when it already has
     *  one, is a click whose only outcome is "already configured". */
    it('drops a configured single-instance service from the picker', async () => {
        await seed(
            '  prowlarr:\n    url: http://192.0.2.10:9696\n    api_key: k\n' +
                '  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n'
        );
        await signIn();
        const page = await (await call('/ui/config')).text();

        const offered = [...page.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
        expect(offered).not.toContain('prowlarr');
        // Radarr takes more than one, so it stays.
        expect(offered).toContain('radarr');
        expect(page).toContain('Already configured, and limited to one instance');
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
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${hashPassword(PASSWORD)}\n  allowed_hosts: [${PINNED}]\nservices: {}\nmetadata:\n  imdb:\n    enabled: true\n`,
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

        await post('/ui/config/imdb', { 'metadata.imdb': 'on' });

        expect(runtime.config.auth.allowed_hosts).toEqual([PINNED]);
        expect(runtime.config.auth.bearer_token).toBe(BEARER);
        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
    });

    it('saving the MCP card does not switch the dataset off', async () => {
        await ready();

        await post('/ui/config/mcp', { 'auth.allowed_hosts': PINNED });

        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
    });

    it('saving the account card touches neither the dataset, the hosts nor the token', async () => {
        await ready();

        await post('/ui/config/account', { 'auth.username': 'someone-else' });

        expect(runtime.config.auth.username).toBe('someone-else');
        expect(runtime.config.metadata?.imdb?.enabled).toBe(true);
        expect(runtime.config.auth.allowed_hosts).toEqual([PINNED]);
        expect(runtime.config.auth.bearer_token).toBe(BEARER);
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
    it('rotates the bearer token only when asked', async () => {
        await signIn();
        await call('/ui/config/mcp', form({ csrf: await csrfFrom() }));
        expect(runtime.config.auth.bearer_token).toBe(BEARER);

        await call('/ui/config/mcp', form({ csrf: await csrfFrom(), 'auth.rotate_token': 'on' }));
        expect(runtime.config.auth.bearer_token).not.toBe(BEARER);
        expect(runtime.config.auth.bearer_token).toMatch(/^[0-9a-f]{64}$/);
    });

    // Rotating from the UI has to take effect on the very next MCP request,
    // or the old token keeps working until a restart.
    it('makes a rotated token effective immediately on /mcp', async () => {
        await signIn();
        await call('/ui/config/mcp', form({ csrf: await csrfFrom(), 'auth.rotate_token': 'on' }));

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
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  password_hash: ${hashPassword(PASSWORD)}\n  allowed_hosts: []\nservices: {}\nmetadata:\n  imdb:\n    enabled: true\n`,
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
