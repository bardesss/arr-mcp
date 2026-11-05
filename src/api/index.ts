import type { Context, Hono } from 'hono';
import type { LogStore } from '../core/logs.ts';
import { logger } from '../core/logger.ts';
import { managementKeyField, matchManagementKey, rememberManagementKey } from '../core/managementKey.ts';
import type { Runtime } from '../core/runtime.ts';
import { originOf } from '../web/routes.ts';
import { API_BASE, apiError, NO_STORE } from './http.ts';
import { registerReads } from './reads.ts';
import { registerWrites } from './writes.ts';

export type ApiDeps = { runtime: Runtime; logs: LogStore; version: string };

const OFF = 'The management API is off. Create a key on the config page to turn it on.';
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The management API: *arr-shaped JSON for companion apps. See docs/api.md. */
export function registerApiRoutes(app: Hono, deps: ApiDeps): void {
    app.use(`${API_BASE}/*`, async (c: Context, next) => {
        const stored = deps.runtime.config.auth.management_keys;
        if (stored === undefined) return apiError(c, 404, OFF);
        const key = matchManagementKey(c.req.header('x-api-key'), stored);
        if (key === undefined) {
            logger.warn({ ...originOf(c), path: c.req.path }, 'rejected a management API request with a missing or wrong key');
            return apiError(c, 401, 'Missing or wrong X-Api-Key.');
        }
        rememberManagementKey(c, key);
        // Here rather than on each write route, so a route added later is refused until a key may use it.
        if (key.tier === 'read' && !READ_METHODS.has(c.req.method)) {
            logger.warn({ ...originOf(c), ...managementKeyField(c), method: c.req.method, path: c.req.path }, 'refused a management API request above the key\'s tier');
            return apiError(c, 403, `Key '${key.name}' is read-only. Create a key with the admin tier on the config page to make changes.`);
        }
        await next();
        for (const [name, value] of Object.entries(NO_STORE)) c.res.headers.set(name, value);
    });

    registerReads(app, deps);
    registerWrites(app, deps);

    app.all(`${API_BASE}/*`, (c: Context) => apiError(c, 404, 'No such endpoint.'));
}
