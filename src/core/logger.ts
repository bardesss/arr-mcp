import pino from 'pino';

/**
 * Process-wide logger. Writes to stdout; the SQLite ring-buffer sink arrives
 * in Phase 5 alongside the config UI's three log streams.
 */
export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    // `app`, not `service`: `service` belongs to the media service a log line
    // is about (radarr, sonarr, …), which is what the config UI's per-service
    // log stream filters on in Phase 5. Binding both to `service` emits a
    // duplicate JSON key and silently loses one of them.
    base: { app: 'arr-mcp' }
});
