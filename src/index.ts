import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { WriteAudit } from './core/audit.ts';
import { attachLogStore } from './core/logger.ts';
import { logger } from './core/logger.ts';
import { LogStore } from './core/logs.ts';
import { Runtime } from './core/runtime.ts';

const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? '/config';
const PORT = Number(process.env.ARR_MCP_PORT ?? 6060);

// Attached before anything else runs, so startup lines — including the
// generated credentials and any config error — are in the ring buffer the
// config UI reads, not only on stdout.
const logs = LogStore.open(CONFIG_DIR);
attachLogStore(logs);

// Opened at startup, not lazily on the first write: a config volume that
// cannot hold the audit trail should be a loud failure now, while someone is
// watching `docker logs`, rather than the first time they ask for a deletion.
const audit = WriteAudit.open(CONFIG_DIR);

const { runtime, created } = await Runtime.start(CONFIG_DIR, audit);

if (created) {
    logger.info({ config: `${CONFIG_DIR}/config.yaml` }, 'first run — sign in to the config UI to add services');
}

if (runtime.current.adapters.length === 0) {
    logger.warn(
        { config: `${CONFIG_DIR}/config.yaml` },
        'no services configured — add them in the config UI, or edit config.yaml'
    );
}

serve({ fetch: buildApp({ runtime, audit, logs }).fetch, port: PORT, hostname: '0.0.0.0' }, info => {
    logger.info(
        { port: info.port, adapters: runtime.current.adapters.map(a => a.id) },
        'arr-mcp listening — config UI at /ui'
    );
});
