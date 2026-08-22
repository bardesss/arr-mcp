import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { join } from 'node:path';

/**
 * The SQLite ring buffer `logger.ts` has been pointing at, and
 * the store behind the config UI's log streams.
 *
 * A ring buffer, not an audit trail — the opposite of `audit.ts`, and kept in
 * its own file for exactly that reason. Write records must survive forever;
 * log lines must not, or a chatty service fills a home server's disk. Sharing
 * one database would mean one retention policy for two things that need
 * different ones.
 *
 * stdout stays the primary sink. This is additive: `docker logs` keeps working
 * unchanged, and losing this store loses nothing that was not already printed.
 */

export const LOG_FILENAME = 'logs.db';

/** Roughly a day of a busy stack, and a few MB on disk. */
export const LOG_RING_SIZE = 5000;

/** Counting rows on every insert costs more than the occasional overshoot. */
const PRUNE_EVERY = 100;

/** pino's numeric levels, which are what actually appear in the JSON. */
export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof LEVELS;

const LEVEL_NAME = new Map<number, LevelName>(
    Object.entries(LEVELS).map(([name, value]) => [value, name as LevelName])
);

export type LogRow = {
    id: number;
    at: string;
    level: number;
    levelName: string;
    /**
     * `null`, not `undefined`, when a line names no service: the column is
     * written as SQL NULL and better-sqlite3 hands that back verbatim. Typing
     * it `undefined` made `row.service === undefined` look like the right
     * check and silently never match.
     */
    service: string | null;
    msg: string;
    /** Everything pino emitted that is not already a column, as JSON. */
    fields: string;
};

export type LogQuery = {
    limit?: number;
    /** Inclusive floor, so `warn` returns warnings, errors and fatals. */
    minLevel?: number;
    /**
     * The media service a line is *about* — `service`, never `app` (see
     * logger.ts).
     *
     * A plain string rather than `ServiceId`: what writers actually put in this
     * column is the **instance** id (`radarr/4k`) and, from a fan-out read, the
     * **source** id (`jellyfin:episodes`). Declaring the eight-name enum
     * described something the column never held.
     */
    service?: string | undefined;
    /** For polling: only rows newer than one already seen. */
    afterId?: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT    NOT NULL,
    level   INTEGER NOT NULL,
    service TEXT,
    msg     TEXT    NOT NULL,
    fields  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS log_level ON log (level, id DESC);
CREATE INDEX IF NOT EXISTS log_service ON log (service, id DESC);
`;

/**
 * Not folded into `fields`. `time`, `level`, `msg` and `service` have columns;
 * `app`, `hostname` and `pid` are dropped outright as noise on every line.
 */
const PROMOTED = new Set(['time', 'level', 'msg', 'service', 'app', 'hostname', 'pid']);

export class LogStore {
    readonly #db: Db;
    #sincePrune = 0;

    private constructor(db: Db) {
        this.#db = db;
        db.exec(SCHEMA);
    }

    static open(configDir: string): LogStore {
        const db = new Database(join(configDir, LOG_FILENAME));
        db.pragma('journal_mode = WAL');
        // NORMAL, not FULL: unlike the audit trail, a log line lost to a power
        // cut costs nothing — it was already on stdout — and fsyncing every
        // line would make logging the slowest thing the process does.
        db.pragma('synchronous = NORMAL');
        return new LogStore(db);
    }

    /** In-memory, for tests. */
    static ephemeral(): LogStore {
        return new LogStore(new Database(':memory:'));
    }

    /**
     * Takes one pino JSON line. Never throws: logging must not be able to
     * break the thing it is logging about, and a malformed line is worth
     * dropping rather than crashing a tool call. That also means this cannot
     * report its own failures through `logger` — doing so would recurse.
     */
    write(line: string): void {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const level = typeof parsed.level === 'number' ? parsed.level : LEVELS.info;
            const at = typeof parsed.time === 'number' ? new Date(parsed.time).toISOString() : new Date().toISOString();

            const extra: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (!PROMOTED.has(key)) extra[key] = value;
            }

            this.#db
                .prepare(`INSERT INTO log (at, level, service, msg, fields) VALUES (?, ?, ?, ?, ?)`)
                .run(
                    at,
                    level,
                    typeof parsed.service === 'string' ? parsed.service : null,
                    typeof parsed.msg === 'string' ? parsed.msg : '',
                    JSON.stringify(extra)
                );

            this.#sincePrune += 1;
            if (this.#sincePrune >= PRUNE_EVERY) {
                this.#sincePrune = 0;
                this.#prune();
            }
        } catch {
            // Deliberately silent — see the doc comment.
        }
    }

    recent(query: LogQuery = {}): LogRow[] {
        const where: string[] = [];
        const params: unknown[] = [];

        if (query.minLevel !== undefined) {
            where.push('level >= ?');
            params.push(query.minLevel);
        }
        if (query.service !== undefined) {
            where.push('service = ?');
            params.push(query.service);
        }
        if (query.afterId !== undefined) {
            where.push('id > ?');
            params.push(query.afterId);
        }

        const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? 200), 1), LOG_RING_SIZE);
        params.push(limit);

        const rows = this.#db
            .prepare(`SELECT * FROM log ${clause} ORDER BY id DESC LIMIT ?`)
            .all(...params) as Omit<LogRow, 'levelName'>[];

        return rows.map(r => ({ ...r, levelName: LEVEL_NAME.get(r.level) ?? String(r.level) }));
    }

    /** Which services have actually logged, so the UI's filter offers only
     *  those rather than all eight regardless. */
    services(): string[] {
        return (
            this.#db.prepare(`SELECT DISTINCT service FROM log WHERE service IS NOT NULL ORDER BY service`).all() as {
                service: string;
            }[]
        ).map(r => r.service);
    }

    count(): number {
        return (this.#db.prepare(`SELECT COUNT(*) AS n FROM log`).get() as { n: number }).n;
    }

    /** Keeps the newest LOG_RING_SIZE rows. Exposed for tests; called
     *  automatically every PRUNE_EVERY writes. */
    prune(): void {
        this.#prune();
    }

    close(): void {
        this.#db.close();
    }

    #prune(): void {
        this.#db
            .prepare(
                // `<`, not `<=`: the subquery returns the id of the row that
                // should be the *oldest survivor*, so including it kept
                // LOG_RING_SIZE - 1 rows.
                `DELETE FROM log WHERE id < (
                     SELECT id FROM log ORDER BY id DESC LIMIT 1 OFFSET ?
                 )`
            )
            .run(LOG_RING_SIZE - 1);
    }
}
