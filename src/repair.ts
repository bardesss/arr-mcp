import { Hono } from 'hono';
import type { ConfigInvalidError } from './config/load.ts';
import type { Sessions } from './core/session.ts';
import { CSS, JS } from './web/assets.ts';
import { MARK_SVG } from './web/icons.ts';
import { unreadableAuthPage } from './web/repairPage.ts';

const NAME = 'arr-mcp';

export type PromoteResult = { ok: true } | { ok: false; detail: string };

export type RepairDeps = {
    configDir: string;
    sessions: Sessions;
    version: string;
    failure: ConfigInvalidError;
    onPromote: () => Promise<PromoteResult>;
};

/**
 * The server that runs instead of the real one when config.yaml did not load:
 * the config file in a textarea, and nothing else.
 */
export function buildRepairApp(deps: RepairDeps): Hono {
    const { version } = deps;
    // eslint-disable-next-line prefer-const -- Task 7 reassigns this after a failed save or promotion.
    let detail = deps.failure.detail;
    const authBlock = deps.failure.auth;

    const app = new Hono();

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

    return app;
}
