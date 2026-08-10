import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { WriteAudit } from './core/audit.ts';
import { attachLogStore } from './core/logger.ts';
import { logger } from './core/logger.ts';
import { LogStore } from './core/logs.ts';
import { Runtime } from './core/runtime.ts';
import { startRefresh } from './metadata/refresh.ts';

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

// The refresher, not the timing: `Runtime` owns *when* to start and stop one,
// because only it knows when the dataset was opened or closed. Passing it here
// is also the only thing that lets this process reach the network for a
// dataset — a test that constructs a Runtime without it never downloads.
const { runtime } = await Runtime.start(CONFIG_DIR, audit, { refresh: dataset => startRefresh(dataset) });

if (runtime.config.auth.password_hash === undefined) {
    // Deliberately the loudest line at startup: until someone claims it, this
    // instance belongs to whoever loads the page first. No credential is
    // printed here or anywhere else — the password is chosen in the browser.
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

// The refresh itself is already running if the dataset is on — `Runtime`
// started it as it opened the database, and will start one just the same when
// somebody switches the dataset on from the config UI, which is the case this
// line used to be the only cover for and could not reach.
//
// Nothing is awaited: the first ingest downloads and parses on the order of
// 10^7 rows, which on a NAS is minutes — and every tool answers exactly as it
// did before until it lands, so blocking here would turn a slow cache warm into
// a container that looks broken.
if (runtime.dataset !== undefined) {
    logger.info('IMDb dataset enabled — refreshing in the background; ratings appear once the first ingest finishes');
}

serve({ fetch: buildApp({ runtime, audit, logs }).fetch, port: PORT, hostname: '0.0.0.0' }, info => {
    logger.info(
        { port: info.port, adapters: runtime.current.adapters.map(a => a.id) },
        `arr-mcp listening — open the config UI at http://<host>:${info.port}`
    );
});
