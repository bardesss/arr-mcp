import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parseDocument } from 'yaml';
import { MAX_BODY_BYTES } from './app.ts';
import { CONFIG_FILENAME, validateConfigText } from './config/load.ts';
import type { ConfigInvalidError } from './config/load.ts';
import { writeConfigAtomic } from './config/save.ts';
import type { Config } from './config/schema.ts';
import { logger } from './core/logger.ts';
import { LoginThrottle } from './core/loginThrottle.ts';
import {
    hashPassword,
    readCookie,
    sessionCookie,
    SESSION_COOKIE,
    SESSION_TTL_MS,
    verifyPassword
} from './core/session.ts';
import type { Sessions } from './core/session.ts';
import { sameOrigin } from './web/origin.ts';
import { CSS, JS } from './web/assets.ts';
import { MARK_SVG } from './web/icons.ts';
import { loginPage, setupPage } from './web/pages.ts';
import { repairPage, unreadableAuthPage } from './web/repairPage.ts';

const NAME = 'arr-mcp';

export type PromoteResult = { ok: true } | { ok: false; detail: string };

export type RepairDeps = {
    configDir: string;
    sessions: Sessions;
    version: string;
    failure: ConfigInvalidError;
    onPromote: () => Promise<PromoteResult>;
};

/** Length only, matching the setup form in `routes.ts`. */
const MIN_PASSWORD = 12;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The server that runs instead of the real one when config.yaml did not load:
 * the config file in a textarea, and nothing else.
 */
export function buildRepairApp(deps: RepairDeps): Hono {
    const { version } = deps;
    let detail = deps.failure.detail;
    const authBlock = deps.failure.auth;

    const app = new Hono();

    // First, as in `app.ts`: `parseBody` buffers the whole request, both posts
    // that reach it are unauthenticated, and in this mode the process is the
    // operator's only route back to a working instance.
    app.use(
        '*',
        bodyLimit({
            maxSize: MAX_BODY_BYTES,
            // Plain text, not JSON: everything here is a page except /healthz.
            onError: c => c.text(`Request body exceeds the ${MAX_BODY_BYTES} byte limit.`, 413)
        })
    );

    // Registered before the auth gate below, so they answer in both outcomes.
    // Hono runs matching handlers in registration order, and these return
    // without calling next().
    app.get('/ui/app.css', c => c.body(CSS, 200, { 'content-type': 'text/css; charset=utf-8' }));
    app.get('/ui/app.js', c => c.body(JS, 200, { 'content-type': 'text/javascript; charset=utf-8' }));
    app.get('/ui/icon.svg', c => c.body(MARK_SVG, 200, { 'content-type': 'image/svg+xml; charset=utf-8' }));

    // 200, because the Dockerfile healthcheck is `wget || exit 1` and a
    // non-2xx restart-loops the container — which is what this mode exists to
    // stop. The honesty is in the body.
    app.get('/healthz', c =>
        c.json({ status: 'degraded', name: NAME, version, reason: detail })
    );

    app.all('/mcp', c =>
        c.json({ error: 'unavailable', detail: `arr-mcp is not serving tools: ${detail}` }, 503)
    );

    // No credential can exist, so nothing below runs.
    app.use('*', async (c, next) => {
        if (authBlock !== undefined) return next();
        return c.html(unreadableAuthPage({ version, detail }), 503);
    });

    // Past the gate above there is an auth block, so the rest of the file can
    // treat it as present. Returning here rather than asserting keeps that a
    // fact the compiler checks.
    if (authBlock === undefined) return app;

    const { configDir, sessions } = deps;
    let raw = deps.failure.raw;
    let auth: Config['auth'] = authBlock;
    let claiming = false;
    const throttle = new LoginThrottle();

    // Read from the parsed block rather than captured per request: there is no
    // runtime to reload from, and this value cannot change while the config is
    // invalid. Registered here, after /healthz and the assets, so a pinned host
    // cannot break the container healthcheck.
    app.use('*', async (c, next) => {
        if (auth.allowed_hosts.length === 0) return next();
        const host = (c.req.header('host') ?? '').toLowerCase();
        const bare = host.replace(/:\d{1,5}$/, '');
        if (auth.allowed_hosts.some(a => a.toLowerCase() === host || a.toLowerCase() === bare)) return next();
        return c.text('forbidden: Host not allowed', 403);
    });

    const unclaimed = (): boolean => auth.password_hash === undefined;
    const entry = (): string => (unclaimed() ? '/ui/setup' : '/ui/login');

    const sessionOf = (c: Context): string | undefined => {
        const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
        return sessions.verify(token).valid ? token : undefined;
    };

    const signIn = (c: Context): string => {
        const token = sessions.issue();
        c.header('set-cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
        return token;
    };

    app.get('/ui/setup', c =>
        unclaimed() ? c.html(setupPage({ version })) : c.redirect('/ui/login', 302)
    );

    // No CSRF token: there is no session yet to bind one to, so the request's
    // origin is the binding that does exist.
    app.post('/ui/setup', async c => {
        if (!unclaimed() || claiming) return c.redirect('/ui/login', 302);
        if (!sameOrigin(c)) return c.text('cross-origin setup request refused', 403);

        const body = await c.req.parseBody();
        const username = str(body.username).trim();
        const password = str(body.password);

        const reject = (text: string) => c.html(setupPage({ version, error: text }), 400);
        if (username === '') return reject('Choose a username.');
        if (password.length < MIN_PASSWORD) return reject(`Use a password of at least ${MIN_PASSWORD} characters.`);
        if (password !== str(body.confirm)) return reject('Those two passwords do not match.');

        const password_hash = await hashPassword(password);

        // Re-checked after the awaits and latched synchronously: `parseBody`
        // and `hashPassword` both yield, so two concurrent posts would
        // otherwise both write, and the later would replace the earlier
        // claimant's credential while their cookie stayed valid.
        if (!unclaimed() || claiming) return c.redirect('/ui/login', 302);
        claiming = true;
        try {
            const path = join(configDir, CONFIG_FILENAME);
            let text: string;
            try {
                // Re-read rather than reusing the snapshot this server started
                // with: it stays up indefinitely, and editing config.yaml
                // directly is the obvious answer to being told it is invalid.
                // Writing the snapshot back would silently revert that edit.
                const doc = parseDocument(await readFile(path, 'utf8'));
                doc.setIn(['auth', 'username'], username);
                doc.setIn(['auth', 'password_hash'], password_hash);
                text = doc.toString();
            } catch {
                return reject('config.yaml changed on disk and can no longer be edited here. Fix it directly, then restart.');
            }
            await writeConfigAtomic(path, text);
            raw = text;
            auth = { ...auth, username, password_hash };
        } finally {
            claiming = false;
        }

        signIn(c);
        logger.info({ username }, 'config UI claimed while the configuration is invalid');
        // Claiming fixed the credential, not the config.
        return c.redirect('/ui/repair', 302);
    });

    app.get('/ui/login', c => {
        if (unclaimed()) return c.redirect('/ui/setup', 302);
        if (sessionOf(c) !== undefined) return c.redirect('/ui/repair', 302);
        return c.html(loginPage({ version }));
    });

    app.post('/ui/login', async c => {
        if (unclaimed()) return c.redirect('/ui/setup', 302);

        const waitMs = throttle.blockedFor();
        if (waitMs > 0) {
            const seconds = Math.ceil(waitMs / 1000);
            c.header('retry-after', String(seconds));
            return c.html(
                loginPage({ version, error: `Too many failed attempts. Try again in ${seconds}s.` }),
                429
            );
        }
        throttle.recordFailure();

        const form = await c.req.parseBody();
        const nameOk = str(form.username) === auth.username;
        const passOk =
            auth.password_hash !== undefined && (await verifyPassword(str(form.password), auth.password_hash));

        if (!nameOk || !passOk) {
            logger.warn({}, 'rejected config UI sign-in');
            return c.html(loginPage({ version, error: 'Wrong username or password.' }), 401);
        }

        throttle.recordSuccess();
        signIn(c);
        return c.redirect('/ui/repair', 302);
    });

    app.get('/ui/repair', c => {
        const session = sessionOf(c);
        if (session === undefined) return c.redirect(entry(), 302);
        c.header('cache-control', 'no-store');
        return c.html(repairPage({ version, raw, detail, csrf: sessions.csrfFor(session) }));
    });

    app.post('/ui/repair', async c => {
        const session = sessionOf(c);
        if (session === undefined) return c.redirect(entry(), 302);

        const body = await c.req.parseBody();
        if (!sessions.csrfValid(session, str(body.csrf))) return c.text('stale form — reload and try again', 403);

        const text = str(body.config);
        // The text as typed, not what is on disk: a save that failed must not
        // throw away the edit that failed.
        const rerender = (message: string) =>
            c.html(repairPage({ version, raw: text, detail: message, csrf: sessions.csrfFor(session) }), 400);

        const verdict = validateConfigText(text);
        if (!verdict.ok) return rerender(verdict.detail);

        // No `expected` drift check: the premise of this page is a file on disk
        // that nothing else is running to change.
        await writeConfigAtomic(join(configDir, CONFIG_FILENAME), text);
        raw = text;

        const promoted = await deps.onPromote();
        if (!promoted.ok) {
            // Assigned only here: this write landed, so the reason the instance
            // is degraded really did change. A validator refusal wrote nothing
            // and must not change what /healthz reports.
            detail = promoted.detail;
            return rerender(detail);
        }

        logger.info('configuration repaired — starting normally');
        return c.redirect('/ui', 302);
    });

    app.all('*', c => c.redirect('/ui/repair', 302));

    return app;
}
