import type { Context, Hono } from 'hono';
import { saveConfig } from '../config/save.ts';
import { ServiceIdSchema, type Config, type ServiceId } from '../config/schema.ts';
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
import { buildStackHealth } from '../tools/stackHealth.ts';
import { CSS, JS } from './assets.ts';
import { configPage, SERVICE_IDS } from './configPage.ts';
import {
    auditPage,
    dashboardPage,
    loginPage,
    logsPage,
    LOG_STREAMS,
    type AuditRow,
    type LogStreamKey
} from './pages.ts';

export type WebDeps = { runtime: Runtime; audit: WriteAudit; logs: LogStore; name: string; version: string };

/**
 * The config UI (design spec §6): a dashboard, connection tests that diagnose
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

    // --- login ----------------------------------------------------------

    app.get('/ui/login', c => {
        if (sessionOf(c, runtime) !== undefined) return c.redirect('/ui', 302);
        return c.html(loginPage({ version }));
    });

    app.post('/ui/login', async c => {
        const form = await c.req.parseBody();
        const username = str(form.username);
        const password = str(form.password);
        const auth = runtime.config.auth;

        // One message for both wrong-username and wrong-password, and the
        // password check runs either way: a login form that answers faster for
        // an unknown user tells an attacker which names exist.
        const nameOk = username === auth.username;
        const passOk = verifyPassword(password, auth.password_hash);

        if (!nameOk || !passOk) {
            logger.warn({ ip: ipOf(c), username }, 'rejected config UI sign-in');
            return c.html(loginPage({ version, error: 'Wrong username or password.' }), 401);
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

    const guard = (c: Context): string | undefined => sessionOf(c, runtime);

    app.get('/', c => c.redirect(guard(c) === undefined ? '/ui/login' : '/ui', 302));

    app.get('/ui', async c => {
        if (guard(c) === undefined) return c.redirect('/ui/login', 302);

        const snapshot = runtime.current;

        // Gathered through `buildStackHealth`, the same function `stack_health`
        // answers from, rather than by calling the adapters again here. Two
        // implementations of "is the stack healthy" is how the page and the
        // tool come to disagree — the same reason §8 keeps one library join.
        // It is live, not cached: a dashboard showing cached status is one
        // that tells you a dead service is fine, and it degrades rather than
        // failing when a service is unreachable.
        const health = await buildStackHealth(snapshot.adapters, { detail: 'full', limit: 50 });
        const rows = audit.recent(500) as { outcome: string }[];

        return c.html(
            dashboardPage({
                version,
                diagnoses: health.services,
                configured: snapshot.adapters.map(a => a.id),
                bearerToken: snapshot.config.auth.bearer_token,
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
        if (guard(c) === undefined) return c.redirect('/ui/login', 302);

        const { stream, minLevel, service } = logQuery(c, logs);
        const url = `/ui/logs.json?stream=${stream}&service=${encodeURIComponent(service ?? '')}`;

        return c.html(
            logsPage({
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
        if (guard(c) === undefined) return c.redirect('/ui/login', 302);
        return c.html(auditPage({ version, rows: audit.recent(300) as AuditRow[] }));
    });

    // --- configuration --------------------------------------------------

    app.get('/ui/config', c => {
        const session = guard(c);
        if (session === undefined) return c.redirect('/ui/login', 302);
        return c.html(configPage({ version, config: runtime.config, csrf: runtime.sessions.csrfFor(session) }));
    });

    app.post('/ui/config', async c => {
        const session = guard(c);
        if (session === undefined) return c.redirect('/ui/login', 302);

        const form = await c.req.parseBody();
        if (!runtime.sessions.csrfValid(session, str(form.csrf))) {
            logger.warn({ ip: ipOf(c) }, 'rejected config save with a bad CSRF token');
            return c.html(
                configPage({
                    version,
                    config: runtime.config,
                    csrf: runtime.sessions.csrfFor(session),
                    message: { kind: 'err', text: 'That form was stale. Reload the page and try again.' }
                }),
                403
            );
        }

        let next: Config;
        try {
            next = buildConfig(runtime.config, form);
        } catch (err) {
            return c.html(
                configPage({
                    version,
                    config: runtime.config,
                    csrf: runtime.sessions.csrfFor(session),
                    message: { kind: 'err', text: (err as Error).message }
                }),
                400
            );
        }

        try {
            await saveConfig(runtime.configDir, next);
            await runtime.reload();
        } catch (err) {
            // The file is written atomically and validated first, so reaching
            // here means the config on disk is still the working one.
            logger.error({ err }, 'config save failed');
            return c.html(
                configPage({
                    version,
                    config: runtime.config,
                    csrf: runtime.sessions.csrfFor(session),
                    message: { kind: 'err', text: (err as Error).message }
                }),
                400
            );
        }

        logger.info({ ip: ipOf(c) }, 'configuration saved from the config UI');
        return c.html(
            configPage({
                version,
                config: runtime.config,
                csrf: runtime.sessions.csrfFor(session),
                message: { kind: 'ok', text: 'Saved and applied. No restart needed.' }
            })
        );
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
 * Resolves which of the three streams was asked for, and what that means as a
 * query.
 *
 * The service filter is parsed through `ServiceIdSchema`, so an unknown value
 * becomes "no filter" rather than reaching the store — the ids are a closed
 * set, and validating against it costs nothing.
 *
 * The "by service" stream with no service chosen defaults to the first that
 * has actually logged, so the tab is never a blank page with a dropdown.
 */
function logQuery(
    c: Context,
    logs: LogStore
): { stream: LogStreamKey; minLevel: number; service: ServiceId | undefined } {
    const requested = c.req.query('stream') ?? 'all';
    const stream = LOG_STREAMS.find(s => s.key === requested) ?? LOG_STREAMS[0];

    const parsed = ServiceIdSchema.safeParse(c.req.query('service') ?? '');
    let service = parsed.success ? parsed.data : undefined;

    if (stream.key === 'service' && service === undefined) {
        const first = ServiceIdSchema.safeParse(logs.services()[0] ?? '');
        service = first.success ? first.data : undefined;
    }
    // Only the by-service stream filters by service; picking one and then
    // switching to Problems must not silently keep filtering.
    if (stream.key !== 'service') service = undefined;

    return { stream: stream.key, minLevel: stream.minLevel, service };
}

/**
 * Form fields into a `Config`, carrying forward every secret the form did not
 * set.
 *
 * A blank secret means "unchanged", never "clear" — the page never renders a
 * secret back, so blank is what an untouched field always looks like. Clearing
 * is expressed by switching the service off, which is unambiguous.
 */
export function buildConfig(current: Config, form: Record<string, unknown>): Config {
    const services: Record<string, unknown> = {};

    for (const id of SERVICE_IDS) {
        if (!on(form[`svc.${id}.enabled`])) continue;

        const existing = (current.services as Record<string, Record<string, unknown> | undefined>)[id];
        const url = str(form[`svc.${id}.url`]).trim();
        if (url === '') throw new Error(`${id} is switched on but has no URL.`);

        const timeout = Number(str(form[`svc.${id}.timeout_ms`]));
        const service: Record<string, unknown> = {
            url,
            timeout_ms: Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : 10_000,
            permissions: {
                safe_write: on(form[`svc.${id}.safe_write`]),
                destructive: on(form[`svc.${id}.destructive`])
            }
        };

        if (id === 'transmission') {
            const username = str(form[`svc.${id}.username`]).trim();
            if (username !== '') service.username = username;
            const password = str(form[`svc.${id}.password`]);
            const carried = password === '' ? existing?.password : password;
            if (typeof carried === 'string' && carried !== '') service.password = carried;
        } else {
            const key = str(form[`svc.${id}.api_key`]).trim();
            const carried = key === '' ? existing?.api_key : key;
            if (typeof carried !== 'string' || carried === '') {
                throw new Error(`${id} is switched on but has no API key.`);
            }
            service.api_key = carried;
        }

        if (id === 'jellyfin' || id === 'seerr') {
            const user = str(form[`svc.${id}.default_user`]).trim();
            if (user !== '') service.default_user = user;
            service.allow_other_users = on(form[`svc.${id}.allow_other_users`]);
        }

        services[id] = service;
    }

    const username = str(form['auth.username']).trim();
    const password = str(form['auth.password']);
    const hosts = str(form['auth.allowed_hosts'])
        .split(',')
        .map(h => h.trim())
        .filter(h => h !== '');

    return {
        auth: {
            bearer_token: on(form['auth.rotate_token'])
                ? generateBearerToken()
                : current.auth.bearer_token,
            username: username === '' ? current.auth.username : username,
            password_hash: password === '' ? current.auth.password_hash : hashPassword(password),
            allowed_hosts: hosts
        },
        services: services as Config['services']
    };
}
