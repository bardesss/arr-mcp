import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { buildApp } from './app.ts';
import { WriteAudit } from './core/audit.ts';
import { attachLogStore } from './core/logger.ts';
import { logger } from './core/logger.ts';
import { LogStore } from './core/logs.ts';
import { Runtime } from './core/runtime.ts';
import { Sessions } from './core/session.ts';
import { ConfigInvalidError } from './config/load.ts';
import { startRefresh } from './metadata/refresh.ts';
import { buildRepairApp, type PromoteResult } from './repair.ts';

const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? '/config';
const PORT = Number(process.env.ARR_MCP_PORT ?? 6060);
const VERSION = process.env.ARR_MCP_VERSION ?? '0.0.0-dev';

// Attached before anything else runs, so startup lines — including the
// generated credentials and any config error — are in the ring buffer the
// config UI reads, not only on stdout.
const logs = LogStore.open(CONFIG_DIR);
attachLogStore(logs);

// Opened at startup, not lazily on the first write: a config volume that
// cannot hold the audit trail should be a loud failure now, while someone is
// watching `docker logs`, rather than the first time they ask for a deletion.
const audit = WriteAudit.open(CONFIG_DIR);

// One instance, shared by both apps: a cookie issued by the repair page has to
// still be valid after a successful save swaps the app underneath it.
const sessions = new Sessions();

let app: Hono;

const startNormally = async (): Promise<Hono> => {
    const { runtime } = await Runtime.start(CONFIG_DIR, audit, {
        refresh: dataset => startRefresh(dataset),
        sessions
    });

    if (runtime.config.auth.password_hash === undefined) {
        logger.warn(
            { port: PORT },
            `arr-mcp is not set up yet — open http://<host>:${PORT} to choose a username and password`
        );
    } else if (runtime.current.adapters.length === 0) {
        logger.warn(
            { config: `${CONFIG_DIR}/config.yaml` },
            'no services configured — add them in the config UI, or edit config.yaml'
        );
    }

    if (runtime.dataset !== undefined) {
        logger.info('IMDb dataset enabled — refreshing in the background; ratings appear once the first ingest finishes');
    }

    return buildApp({ runtime, audit, logs });
};

const promote = async (): Promise<PromoteResult> => {
    try {
        app = await startNormally();
        return { ok: true };
    } catch (err) {
        if (err instanceof ConfigInvalidError) return { ok: false, detail: err.detail };
        throw err;
    }
};

try {
    app = await startNormally();
} catch (err) {
    // Only a config we could read and not understand. A volume that will not
    // write stays fatal: a repair page whose Save can never succeed is worse
    // than exiting.
    if (!(err instanceof ConfigInvalidError)) throw err;
    logger.error(
        { config: `${CONFIG_DIR}/config.yaml` },
        `config.yaml is invalid — serving the repair page only:\n${err.detail}`
    );
    app = buildRepairApp({
        configDir: CONFIG_DIR,
        sessions,
        version: VERSION,
        failure: err,
        onPromote: promote
    });
}

serve({ fetch: (req: Request) => app.fetch(req), port: PORT, hostname: '0.0.0.0' }, info => {
    logger.info({ port: info.port }, `arr-mcp listening — open the config UI at http://<host>:${info.port}`);
});
