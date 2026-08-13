import type { Context, Hono } from 'hono';
import { saveConfig } from '../config/save.ts';
import { ServiceIdSchema, ThemeSchema, type Config, type Theme } from '../config/schema.ts';
import type { WriteAudit } from '../core/audit.ts';
import { logger } from '../core/logger.ts';
import type { LogStore } from '../core/logs.ts';
import type { Runtime } from '../core/runtime.ts';
import {
    clearedSessionCookie,
    generateBearerToken,
    hashPassword,
    readCookie,
    sessionCookie,
    SESSION_COOKIE,
    SESSION_TTL_MS,
    verifyPassword
} from '../core/session.ts';
import { instanceId } from '../config/instances.ts';
import { buildAdapters } from '../services/registry.ts';
import { hasUserDirectory } from '../services/types.ts';
import { buildStackHealth } from '../tools/stackHealth.ts';
import { CSS, JS } from './assets.ts';
import { addInstance, removeInstance, updateInstance, type InstanceFields } from '../config/mutate.ts';
import { configPage } from './configPage.ts';
import { mcpEndpoint } from './origin.ts';
import {
    auditPage,
    dashboardPage,
    loginPage,
    logsPage,
    setupPage,
    LOG_STREAMS,
    type AuditRow,
    type LogStreamKey
} from './pages.ts';

/** Length only, no character-class rules: the classes push people towards
 *  `Password1!` and buy nothing a longer passphrase does not. */
const MIN_PASSWORD = 12;

export type WebDeps = { runtime: Runtime; audit: WriteAudit; logs: LogStore; version: string };

/**
 * The config UI: a dashboard, connection tests that diagnose
 * rather than pass/fail, log streams, the write audit, and configuration
 * editing that applies without a restart.
 *
 * Server rendered, no build step. The only client JavaScript polls the log
 * stream and copies the bearer token.
 */
export function registerWebRoutes(app: Hono, deps: WebDeps): void {
    const { runtime, audit, logs, version } = deps;

    // --- assets ---------------------------------------------------------
    //
    // Unauthenticated on purpose: they are constants compiled into the binary
    // and reveal nothing. Requiring a session for the stylesheet would make
    // the login page render unstyled, which looks broken.
    app.get('/ui/app.css', c => c.body(CSS, 200, { 'content-type': 'text/css; charset=utf-8', ...CACHE }));
    app.get('/ui/app.js', c => c.body(JS, 200, { 'content-type': 'text/javascript; charset=utf-8', ...CACHE }));

    // --- setup ----------------------------------------------------------
    //
    // An instance with no `password_hash` is *unclaimed*: nothing has been set
    // up yet, so there is no password any sign-in could satisfy. Every UI route
    // funnels here until someone claims it.

    const unclaimed = (): boolean => runtime.config.auth.password_hash === undefined;
    const entry = (): string => (unclaimed() ? '/ui/setup' : '/ui/login');

    // Read per render rather than captured: `runtime.config` is replaced on
    // reload, and saving the theme is itself a reload — so a captured value
    // would leave the page that just saved showing the previous theme.
    const theme = (): Theme => runtime.config.ui?.theme ?? 'system';

    app.get('/ui/setup', c => {
        if (!unclaimed()) return c.redirect('/ui/login', 302);
        return c.html(setupPage({ version, theme: theme() }));
    });

    /**
     * No CSRF token on this form, deliberately.
     *
     * There is no session to bind one to, and forging a claim against an
     * unclaimed instance gets an attacker precisely what loading the page
     * directly would have got them. Every other form in this file keeps its
     * token, because every other form acts on an instance someone owns.
     */
    app.post('/ui/setup', async c => {
        if (!unclaimed()) return c.redirect('/ui/login', 302);

        const body = await c.req.parseBody();
        const username = str(body.username).trim();
        const password = str(body.password);

        const reject = (text: string) => c.html(setupPage({ version, error: text, theme: theme() }), 400);
        if (username === '') return reject('Choose a username.');
        if (password.length < MIN_PASSWORD) return reject(`Use a password of at least ${MIN_PASSWORD} characters.`);
        if (password !== str(body.confirm)) return reject('Those two passwords do not match.');

        // Single-threaded through the await below, so no second request can
        // interleave between the `unclaimed()` check above and the write.
        await saveConfig(runtime.configDir, {
            ...runtime.config,
            auth: { ...runtime.config.auth, username, password_hash: hashPassword(password) }
        });
        await runtime.reload();

        const token = runtime.sessions.issue();
        c.header('set-cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
        logger.info({ ip: ipOf(c), username }, 'config UI claimed');
        return c.redirect('/ui', 302);
    });

    // --- login ----------------------------------------------------------

    app.get('/ui/login', c => {
        if (unclaimed()) return c.redirect('/ui/setup', 302);
        if (sessionOf(c, runtime) !== undefined) return c.redirect('/ui', 302);
        return c.html(loginPage({ version, theme: theme() }));
    });

    app.post('/ui/login', async c => {
        if (unclaimed()) return c.redirect('/ui/setup', 302);

        const form = await c.req.parseBody();
        const username = str(form.username);
        const password = str(form.password);
        const auth = runtime.config.auth;

        // One message for both wrong username and wrong password, and the hash
        // check runs either way — a form that answers faster for an unknown
        // user tells an attacker which names exist. A missing hash must never
        // read as a valid login.
        const nameOk = username === auth.username;
        const passOk = auth.password_hash !== undefined && verifyPassword(password, auth.password_hash);

        if (!nameOk || !passOk) {
            logger.warn({ ip: ipOf(c), username }, 'rejected config UI sign-in');
            return c.html(loginPage({ version, error: 'Wrong username or password.', theme: theme() }), 401);
        }

        const token = runtime.sessions.issue();
        c.header('set-cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
        logger.info({ ip: ipOf(c), username }, 'config UI sign-in');
        return c.redirect('/ui', 302);
    });

    app.post('/ui/logout', c => {
        c.header('set-cookie', clearedSessionCookie());
        return c.redirect('/ui/login', 302);
    });

    // --- everything below requires a session ----------------------------

    // Unclaimed counts as "no session" regardless of what cookie was presented:
    // a session predating a credential reset must not outlive it.
    const guard = (c: Context): string | undefined => (unclaimed() ? undefined : sessionOf(c, runtime));

    app.get('/', c => c.redirect(guard(c) === undefined ? entry() : '/ui', 302));

    app.get('/ui', async c => {
        if (guard(c) === undefined) return c.redirect(entry(), 302);

        const snapshot = runtime.current;

        // Through `buildStackHealth`, the same function `stack_health` answers
        // from. Two implementations of "is the stack healthy" is how the page
        // and the tool come to disagree.
        // It is live, not cached: a dashboard showing cached status is one
        // that tells you a dead service is fine, and it degrades rather than
        // failing when a service is unreachable.
        const health = await buildStackHealth(snapshot.adapters, { detail: 'full', limit: 50 });
        const rows = audit.recent(500) as { outcome: string }[];

        return c.html(
            dashboardPage({
                theme: theme(),
                version,
                diagnoses: health.services,
                configured: snapshot.adapters.map(a => a.id),
                bearerToken: snapshot.config.auth.bearer_token,
                mcpUrl: mcpEndpoint(c.req.url, c.req.header('x-forwarded-proto')),
                ...(runtime.dataset === undefined ? {} : { imdb: runtime.dataset.status() }),
                disks: health.disks.items,
                failures: health.failures.items,
                scans: health.scans,
                writeCounts: {
                    applied: rows.filter(r => r.outcome === 'applied').length,
                    denied: rows.filter(r => r.outcome === 'denied').length,
                    total: rows.length
                }
            })
        );
    });

    // --- logs -----------------------------------------------------------

    app.get('/ui/logs', c => {
        if (guard(c) === undefined) return c.redirect(entry(), 302);

        const { stream, minLevel, service } = logQuery(c, logs);
        const url = `/ui/logs.json?stream=${stream}&service=${encodeURIComponent(service ?? '')}`;

        return c.html(
            logsPage({
                theme: theme(),
                version,
                services: logs.services(),
                selectedService: service ?? '',
                stream,
                streamUrl: url,
                rows: logs.recent({ minLevel, service, limit: 300 })
            })
        );
    });

    /** JSON, not HTML — the client builds rows with textContent, because log
     *  lines carry release names from public indexers. See web/assets.ts. */
    app.get('/ui/logs.json', c => {
        if (guard(c) === undefined) return c.json({ error: 'unauthorized' }, 401);

        const { minLevel, service } = logQuery(c, logs);
        return c.json({ rows: logs.recent({ minLevel, service, limit: 300 }) }, 200, NO_STORE);
    });

    // --- write audit ----------------------------------------------------

    app.get('/ui/audit', c => {
        if (guard(c) === undefined) return c.redirect(entry(), 302);
        return c.html(auditPage({ version, rows: audit.recent(300) as AuditRow[], theme: theme() }));
    });

    // --- configuration --------------------------------------------------

    /**
     * Who each user-aware service says its users are, to suggest in the
     * default-user field.
     *
     * Capped well below the services' own timeouts: this is the page you open
     * *because* something is unreachable, so a dead Jellyfin must cost a
     * moment, not ten seconds. A service that misses the cap is absent from the
     * result and the card says so — never an empty dropdown, which reads as
     * "this service has no users".
     */
    const USER_LOOKUP_MS = 2500;

    const usersByInstance = async (): Promise<Record<string, readonly string[]>> => {
        const found: Record<string, readonly string[]> = {};

        await Promise.all(
            runtime.current.adapters.filter(hasUserDirectory).map(async adapter => {
                try {
                    const users = await Promise.race([
                        adapter.listUsers(),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('timed out')), USER_LOOKUP_MS).unref()
                        )
                    ]);
                    found[adapter.id] = users.map(u => u.name);
                } catch (err) {
                    logger.warn({ service: adapter.id, err }, 'could not list users for the configuration page');
                }
            })
        );

        return found;
    };

    app.get('/ui/config', async c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);
        return c.html(
            configPage({
                version,
                config: runtime.config,
                csrf: runtime.sessions.csrfFor(session),
                users: await usersByInstance()
            })
        );
    });

    /**
     * The four config mutations share everything except the one line that
     * decides what the next config is, so they share a handler.
     *
     * `render` carries the `confirmingRemoval` id through, which is what makes
     * the two-step remove work without JavaScript: the first post returns the
     * page with that card asking, and the second carries `confirm`.
     */
    const configMutation =
        (
            what: string,
            next: (form: Record<string, unknown>) => Config | { ask: string },
            /** The add form is a dialog, so a refusal has to bring it back — a
             *  message about a form nobody can see explains nothing. */
            reopensAdd = false
        ): ((c: Context) => Promise<Response>) =>
        async (c: Context) => {
            const session = guard(c);
            if (session === undefined) return c.redirect(entry(), 302);

            // Re-asks who the users are, as a plain page load does: a save that
            // dropped the suggestions would have the card claim the service went
            // quiet, and a save that changed a Jellyfin key is exactly when the
            // list is worth refreshing.
            const render = async (
                message: { kind: 'ok' | 'err'; text: string } | undefined,
                status: 200 | 400 | 403,
                confirming?: string
            ) =>
                c.html(
                    configPage({
                        version,
                        config: runtime.config,
                        csrf: runtime.sessions.csrfFor(session),
                        users: await usersByInstance(),
                        ...(confirming === undefined ? {} : { confirmingRemoval: confirming }),
                        ...(reopensAdd && status !== 200 ? { openAdd: true } : {}),
                        ...(message === undefined ? {} : { message })
                    }),
                    status
                );

            const form = await c.req.parseBody();
            if (!runtime.sessions.csrfValid(session, str(form.csrf))) {
                logger.warn({ ip: ipOf(c) }, 'rejected config save with a bad CSRF token');
                return render({ kind: 'err', text: 'That form was stale. Reload the page and try again.' }, 403);
            }

            let updated: Config;
            try {
                const result = next(form);
                // Not an error: the removal is waiting for a second click.
                if ('ask' in result) return render(undefined, 200, result.ask);
                updated = result;
            } catch (err) {
                return render({ kind: 'err', text: (err as Error).message }, 400);
            }

            try {
                // `expected` is the snapshot this page's form was built from,
                // so a service hand-added to config.yaml since then is a
                // refusal rather than a silent deletion under a "Saved" banner.
                await saveConfig(runtime.configDir, updated, { expected: runtime.config });
                await runtime.reload();
            } catch (err) {
                // The file is written atomically and validated first, so
                // reaching here means the config on disk is still the working
                // one.
                logger.error({ err }, 'config save failed');
                return render({ kind: 'err', text: (err as Error).message }, 400);
            }

            logger.info({ ip: ipOf(c), what }, 'configuration saved from the config UI');
            return render({ kind: 'ok', text: `${what} Applied immediately; no restart needed.` }, 200);
        };

    app.post(
        '/ui/config/add',
        configMutation('Added.', form => addCandidateFrom(runtime.config, form).candidate, true)
    );

    app.post(
        '/ui/config/save',
        configMutation('Saved.', form =>
            updateInstance(runtime.config, str(form.instance), instanceFieldsFrom(form))
        )
    );

    app.post(
        '/ui/config/remove',
        configMutation('Removed.', form => {
            const instance = str(form.instance);
            // Server-side rather than a `confirm()` call: with scripting
            // unavailable a JS confirmation would delete silently on the first
            // click, which is the failure a confirmation exists to prevent.
            if (str(form.confirm) !== 'yes') return { ask: instance };
            return removeInstance(runtime.config, instance);
        })
    );

    // One route per card, matching one form per card. A single `/access` route
    // taking all three was what let the page grow a button that looked global.
    app.post(
        '/ui/config/account',
        configMutation('Config UI sign-in saved.', form => buildAccountConfig(runtime.config, form))
    );

    app.post(
        '/ui/config/appearance',
        configMutation('Appearance saved.', form => buildAppearanceConfig(runtime.config, form))
    );

    app.post(
        '/ui/config/imdb',
        configMutation('IMDb dataset settings saved.', form => buildImdbConfig(runtime.config, form))
    );

    app.post(
        '/ui/config/mcp',
        configMutation('MCP endpoint settings saved.', form => buildMcpConfig(runtime.config, form))
    );

    /**
     * Test one instance against the fields as they stand, not as they are
     * saved — replacing "save it and see if the dashboard goes green", which
     * writes a URL you already suspect is wrong and answers on another page.
     * The candidate is built exactly as a save would build it and thrown away.
     *
     * The add dialog posts here too, with no `instance`. That candidate comes
     * from `addInstance`, the same call Add makes, so a passing test is one Add
     * will accept — and it inherits Add's validation, so an unnamed second
     * radarr answers "name it" rather than a latency.
     *
     * Not a `configMutation`, despite the shape: that helper ends in
     * `saveConfig`.
     */
    app.post('/ui/config/test', async c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);

        const form = await c.req.parseBody();
        const id = str(form.instance);
        const isAdd = id === '';

        // The dialog's Test is fetched, not posted, so the result lands in a
        // dialog that still holds what you typed. A re-render could not:
        // `addDialog` renders its fields blank, and refilling them would mean
        // writing the API key into the HTML — the one thing `configPage` never
        // does. Unscripted falls through to the ordinary render.
        const wantsJson = c.req.header('accept')?.includes('application/json') === true;

        const render = async (status: 200 | 400 | 403, extra: Partial<Parameters<typeof configPage>[0]>) =>
            c.html(
                configPage({
                    version,
                    config: runtime.config,
                    csrf: runtime.sessions.csrfFor(session),
                    users: await usersByInstance(),
                    ...(isAdd ? { openAdd: true } : {}),
                    ...extra
                }),
                status
            );

        const fail = async (status: 400 | 403, text: string) =>
            wantsJson ? c.json({ ok: false, detail: text }, status) : render(status, { message: { kind: 'err', text } });

        if (!runtime.sessions.csrfValid(session, str(form.csrf))) {
            logger.warn({ ip: ipOf(c) }, 'rejected a connection test with a bad CSRF token');
            return fail(403, 'That form was stale. Reload the page and try again.');
        }

        try {
            const { candidate, target } = isAdd
                ? addCandidateFrom(runtime.config, form)
                : { candidate: updateInstance(runtime.config, id, instanceFieldsFrom(form)), target: id };

            const adapter = buildAdapters(candidate).find(a => a.id === target);
            if (adapter === undefined) throw new Error(`${target} is not configured.`);

            const diagnosis = await adapter.testConnection();
            logger.info({ ip: ipOf(c), service: target, ok: diagnosis.ok }, 'connection tested from the config UI');

            if (wantsJson) return c.json(diagnosis, 200);
            return render(200, isAdd ? { testedAdd: diagnosis } : { tested: { instance: target, diagnosis } });
        } catch (err) {
            // A config that will not even build — a URL that is not a URL, a
            // timeout that is not a number. testConnection never gets to run,
            // so the message is the validation one, which names the field.
            return fail(400, (err as Error).message);
        }
    });
}

const CACHE = { 'cache-control': 'public, max-age=3600' };
const NO_STORE = { 'cache-control': 'no-store' };

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const on = (value: unknown): boolean => value === 'on' || value === 'true';
const ipOf = (c: Context): string => c.req.header('x-forwarded-for') ?? 'unknown';

function sessionOf(c: Context, runtime: Runtime): string | undefined {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    return runtime.sessions.verify(token).valid ? token : undefined;
}

/**
 * Which of the three streams was asked for, as a query.
 *
 * The service filter goes through `ServiceIdSchema`, so an unknown value
 * becomes "no filter" rather than reaching the store. "By service" with none
 * chosen defaults to the first that has actually logged, so the tab is never a
 * blank page with a dropdown.
 */
function logQuery(
    c: Context,
    logs: LogStore
): { stream: LogStreamKey; minLevel: number; service: string | undefined } {
    const requested = c.req.query('stream') ?? 'all';
    const stream = LOG_STREAMS.find(s => s.key === requested) ?? LOG_STREAMS[0];

    // Validated against what has actually been logged, not against the
    // eight-name service enum. The column holds instance ids (`radarr/4k`) and
    // source ids (`jellyfin:episodes`), and `services()` builds the dropdown
    // from those same values — so parsing the choice as a bare ServiceId threw
    // away every selection the dropdown offered on a multi-instance install,
    // returned every line from every service, and looked like "nothing logged".
    const known = logs.services();
    const requestedService = c.req.query('service');
    let service = requestedService !== undefined && known.includes(requestedService) ? requestedService : undefined;

    if (stream.key === 'service' && service === undefined) service = known[0];
    // Only the by-service stream filters by service; picking one and then
    // switching to Problems must not silently keep filtering.
    if (stream.key !== 'service') service = undefined;

    return { stream: stream.key, minLevel: stream.minLevel, service };
}

/**
 * The instance fields a card's form carries, under bare names — each card is
 * its own form, and an id containing a `/` has no sensible prefix anyway.
 *
 * A blank credential means "unchanged", never "clear". The page never renders a
 * secret back, so blank is what an untouched field always looks like; clearing
 * is expressed by removing the instance, which is confirmed.
 */
export function instanceFieldsFrom(form: Record<string, unknown>): InstanceFields {
    const timeout = Number(str(form.timeout_ms));

    return {
        url: str(form.url).trim(),
        api_key: str(form.api_key).trim(),
        username: str(form.username).trim(),
        password: str(form.password),
        default_user: str(form.default_user).trim(),
        allow_other_users: on(form.allow_other_users),
        ...(Number.isFinite(timeout) && timeout > 0 ? { timeout_ms: Math.trunc(timeout) } : {}),
        safe_write: on(form.safe_write),
        destructive: on(form.destructive)
    };
}

/**
 * What the add dialog describes: the config it would produce, and the id the
 * new instance would take.
 *
 * Shared by `/ui/config/add` and the dialog's Test so the two cannot drift.
 * A Test that builds its candidate any other way is a Test that can pass
 * against something Add would then refuse.
 */
export function addCandidateFrom(
    config: Config,
    form: Record<string, unknown>
): { candidate: Config; target: string } {
    const type = ServiceIdSchema.parse(str(form.type));
    const name = str(form.name).trim();
    const renameExistingTo = str(form.rename_existing_to).trim();

    return {
        candidate: addInstance(config, {
            type,
            ...(name === '' ? {} : { name }),
            ...(renameExistingTo === '' ? {} : { renameExistingTo }),
            fields: instanceFieldsFrom(form)
        }),
        target: instanceId(type, name === '' ? undefined : name)
    };
}

/**
 * The three cards below the services, one builder each.
 *
 * They were a single `buildAuthConfig` behind a single button, which is what
 * made the page have two save models at once — every service card saved
 * itself, and then one button at the bottom of the page saved three unrelated
 * things together while looking, by position, like it saved everything.
 *
 * Splitting them makes the rule uniform: **the card you edited is the card you
 * save.** It also creates the one hazard worth naming, which is why each of
 * these carries forward every field it does not own rather than rebuilding the
 * config from its own form. A form that never contained `auth.allowed_hosts`
 * submits nothing for it, and "nothing" is indistinguishable from "the user
 * cleared the box" unless the builder knows which fields are its business.
 * `test/configUi.test.ts` holds one test per way of getting that wrong.
 */

/** The Config UI's own credentials. Owns `username` and `password_hash`. */
export function buildAccountConfig(current: Config, form: Record<string, unknown>): Config {
    const username = str(form['auth.username']).trim();
    const password = str(form['auth.password']);

    // Refused rather than carried forward as `undefined`. Since `password_hash`
    // became optional this assignment type-checks either way, so nothing but
    // this guard stops a blank password field on a config save from writing a
    // config with no hash — silently un-claiming a live instance and handing it
    // to whoever loads /ui/setup next.
    const carriedHash = password === '' ? current.auth.password_hash : hashPassword(password);
    if (carriedHash === undefined) {
        throw new Error('This instance has no password set yet. Reload the page and set one up.');
    }

    return {
        ...current,
        auth: {
            ...current.auth,
            username: username === '' ? current.auth.username : username,
            password_hash: carriedHash
        }
    };
}

/**
 * The IMDb dataset. Owns `metadata` and nothing else.
 *
 * Its checkbox is authoritative because an unchecked box submits nothing, and
 * this is the only form that carries it — so absent genuinely means off here,
 * where on any other card it would mean "not mine to touch". Off is expressed
 * by dropping the block entirely rather than by `enabled: false`, so a config
 * nobody touched stays exactly as clean as it started.
 */
export function buildImdbConfig(current: Config, form: Record<string, unknown>): Config {
    const { metadata: _dropped, ...rest } = current;
    return {
        ...rest,
        ...(on(form['metadata.imdb']) ? { metadata: { imdb: { enabled: true } } } : {})
    };
}

/**
 * The theme. Owns `ui` and nothing else.
 *
 * `system` drops the block rather than writing `theme: system`, so choosing the
 * default leaves the file as clean as it was — the same rule the IMDb card
 * follows. An unparseable value falls back to `system` instead of being written
 * through: this comes from a form, and the schema would refuse the file on the
 * next load, which turns a bad select into a server that will not start.
 */
export function buildAppearanceConfig(current: Config, form: Record<string, unknown>): Config {
    const { ui: _dropped, ...rest } = current;
    const parsed = ThemeSchema.safeParse(str(form['ui.theme']));
    const theme = parsed.success ? parsed.data : 'system';

    return { ...rest, ...(theme === 'system' ? {} : { ui: { theme } }) };
}

/** The MCP endpoint. Owns `bearer_token` and `allowed_hosts`. */
export function buildMcpConfig(current: Config, form: Record<string, unknown>): Config {
    const hosts = str(form['auth.allowed_hosts'])
        .split(',')
        .map(h => h.trim())
        .filter(h => h !== '');

    return {
        ...current,
        auth: {
            ...current.auth,
            bearer_token: on(form['auth.rotate_token'])
                ? generateBearerToken()
                : current.auth.bearer_token,
            allowed_hosts: hosts
        }
    };
}
