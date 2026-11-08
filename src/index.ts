import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap.ts';
import { ConfigInvalidError } from './config/load.ts';
import { WriteAudit } from './core/audit.ts';
import { attachLogStore } from './core/logger.ts';
import { logger } from './core/logger.ts';
import { LogStore } from './core/logs.ts';
import { Sessions } from './core/session.ts';
import { WebhookEvents } from './core/webhookEvents.ts';
import { serveOverStdio } from './stdio.ts';

const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? '/config';
const PORT = Number(process.env.ARR_MCP_PORT ?? 6060);
const VERSION = process.env.ARR_MCP_VERSION ?? '0.0.0-dev';
// Also read by core/logger.ts, which sends log lines to stderr when it is set.
const STDIO = process.argv.includes('--stdio');

// Attached before anything else runs, so startup lines — including the
// token-hashing warnings and any config error — are in the ring buffer the
// config UI reads, not only on stdout.
const logs = LogStore.open(CONFIG_DIR);
attachLogStore(logs);

// Opened at startup, not lazily on the first write: a config volume that
// cannot hold the audit trail should be a loud failure now, while someone is
// watching `docker logs`, rather than the first time they ask for a deletion.
const audit = WriteAudit.open(CONFIG_DIR);

// One instance, shared by both apps: a cookie issued by the repair page has to
// still be valid after a successful save swaps the app underneath it.
const sessions = Sessions.open(CONFIG_DIR);

const events = WebhookEvents.open(CONFIG_DIR);

if (STDIO) {
    // No repair page to fall back on: there is no UI to serve it from, so a
    // config that will not parse is fatal here, with the reason on stderr.
    try {
        await serveOverStdio({ configDir: CONFIG_DIR, audit, events, sessions });
    } catch (err) {
        if (err instanceof ConfigInvalidError) logger.fatal({ detail: err.detail }, 'config.yaml is invalid — fix it, then start again');
        else logger.fatal({ err }, 'could not start over stdio');
        process.exit(1);
    }
    // The client closing stdin ends the session. The IMDb refresh timer and
    // the open databases would otherwise keep the process alive.
    process.stdin.once('end', () => process.exit(0));
} else {
    const app = await bootstrap({ configDir: CONFIG_DIR, audit, logs, events, sessions, version: VERSION, port: PORT });

    serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, info => {
        logger.info({ port: info.port }, `arr-mcp listening — open the config UI at http://<host>:${info.port}`);
    });
}
