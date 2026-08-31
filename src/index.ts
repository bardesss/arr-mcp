import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap.ts';
import { WriteAudit } from './core/audit.ts';
import { attachLogStore } from './core/logger.ts';
import { logger } from './core/logger.ts';
import { LogStore } from './core/logs.ts';
import { Sessions } from './core/session.ts';

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

const app = await bootstrap({ configDir: CONFIG_DIR, audit, logs, sessions, version: VERSION, port: PORT });

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, info => {
    logger.info({ port: info.port }, `arr-mcp listening — open the config UI at http://<host>:${info.port}`);
});
