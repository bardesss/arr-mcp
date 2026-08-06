import pino from 'pino';
import type { LogStore } from './logs.ts';

/**
 * The ring-buffer sink, attached late.
 *
 * `logger` is imported at module load by nearly every file, but the store
 * needs the config directory, which only `index.ts` knows. So the destination
 * is a stable object that forwards to a store once one exists and drops
 * otherwise — rather than a second logger built later, which would silently
 * lose every line emitted during startup.
 */
let sink: LogStore | undefined;

export function attachLogStore(store: LogStore): void {
    sink = store;
}

/** Tests attach an ephemeral store; this puts it back. */
export function detachLogStore(): void {
    sink = undefined;
}

/**
 * Writes to stdout **and** the ring buffer.
 *
 * stdout first and unconditionally: `docker logs` is the only way in before
 * anyone has reached the UI, and a failing store must not cost a line there.
 * `LogStore.write` swallows its own errors for the same reason.
 */
const destination = {
    write(line: string): void {
        process.stdout.write(line);
        sink?.write(line);
    }
};

/**
 * Process-wide logger. Writes to stdout, and to the SQLite ring buffer behind
 * the config UI's log streams once `attachLogStore` has been called.
 */
export const logger = pino(
    {
        level: process.env.LOG_LEVEL ?? 'info',
        // `app`, not `service`: `service` belongs to the media service a log
        // line is about (radarr, sonarr, …), which is what the config UI's
        // per-service log stream filters on. Binding both to `service` emits a
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
    },
    destination
);
