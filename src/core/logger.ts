import pino from 'pino';

/**
 * Process-wide logger. Writes to stdout; the SQLite ring-buffer sink arrives
 * in Phase 5 alongside the config UI's three log streams.
 */
export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'arr-mcp' }
});
