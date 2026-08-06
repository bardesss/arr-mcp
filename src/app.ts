import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { WriteAudit } from './core/audit.ts';
import { logger } from './core/logger.ts';
import type { LogStore } from './core/logs.ts';
import type { Runtime } from './core/runtime.ts';
import { registerAllTools } from './tools/register.ts';
import { registerWebRoutes } from './web/routes.ts';

const NAME = 'arr-mcp';
const VERSION = process.env.ARR_MCP_VERSION ?? '0.0.0-dev';

/** Constant-time compare that does not reveal the expected length by timing. */
function tokenMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
        // Burn an equivalent comparison so a wrong-length token is not
        // distinguishable from a wrong-bytes one.
        timingSafeEqual(b, b);
        return false;
    }
    return timingSafeEqual(a, b);
}

export function buildApp(opts: { runtime: Runtime; audit: WriteAudit; logs: LogStore }) {
    const { runtime, audit, logs } = opts;

    // The factory runs once per request, so every call gets a fresh McpServer.
    // This is what keeps the transport stateless (design spec §5) — do not
    // hoist the server out of the closure.
    //
    // `runtime.current` is read here, per request, rather than captured when
    // the app is built: that is what lets a config change take effect without
    // a restart. Reading it once into `snapshot` also means a call that starts
    // before a reload finishes against the configuration it began with.
    const handler = createMcpHandler(() => {
        const snapshot = runtime.current;
        const server = new McpServer({ name: NAME, version: VERSION });
        registerAllTools(server, snapshot.tools);
        return server;
    });

    // We bind 0.0.0.0 because the container must be reachable across the LAN,
    // which drops the SDK's default localhost Host/Origin validation.
    //
    // `allowedHosts` must be OMITTED, not empty, when the user has pinned no
    // hostnames: the adapter gates the middleware on `if (allowedHosts)`, and
    // `[]` is truthy — so passing an empty array installs validation with an
    // empty allow-list and rejects *every* request with 403. Authentication is
    // what protects us here; Host pinning is an extra a reverse-proxy user can
    // opt into.
    //
    // Read once, at build time, unlike everything else: the Hono adapter
    // installs this middleware when the app is constructed, so a reload cannot
    // change it. Pinning hostnames therefore still needs a restart, which is
    // documented — it is a transport concern, not a service one.
    const allowedHosts = runtime.config.auth.allowed_hosts;
    const app = createMcpHonoApp({
        host: '0.0.0.0',
        ...(allowedHosts.length > 0 ? { allowedHosts } : {})
    });

    app.get('/healthz', c => c.json({ status: 'ok', name: NAME, version: VERSION }));

    registerWebRoutes(app, { runtime, audit, logs, name: NAME, version: VERSION });

    app.all('/mcp', async (c: Context) => {
        const header = c.req.header('Authorization') ?? '';
        const [scheme, presented] = header.split(' ');

        // From the runtime, not a captured value, so rotating the token in the
        // config UI takes effect on the very next request.
        if (scheme !== 'Bearer' || !presented || !tokenMatches(presented, runtime.config.auth.bearer_token)) {
            logger.warn(
                { path: '/mcp', ip: c.req.header('x-forwarded-for') ?? 'unknown' },
                'rejected unauthenticated MCP request'
            );
            return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="arr-mcp"' });
        }

        return handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') });
    });

    return app;
}
