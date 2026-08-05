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
    base: { app: 'arr-mcp' },
    serializers: {
        // pino's default `err` serializer spreads every own enumerable
        // property, and `ServiceError.message` embeds `.remedy` (see
        // core/errors.ts) — without this, `remedy` would appear twice in
        // every logged error: once inline in `message`, once as its own
        // field. `kind`/`service`/`detail` stay, since those are structured
        // fields the config UI's log streams can filter on and are not
        // themselves duplicated prose.
        err: err => {
            const { remedy: _remedy, ...rest } = pino.stdSerializers.err(err);
            return rest;
        }
    }
});
