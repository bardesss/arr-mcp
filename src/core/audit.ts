import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { join } from 'node:path';
import type { WriteTier } from './permissions.ts';
import { logger } from './logger.ts';

/**
 * The write audit: a durable answer to "what did this thing do
 * to my library, and who asked it to".
 *
 * SQLite rather than a JSONL file because 0.6's config page has to *read* this
 * back — filtered by service, by outcome, by date — and re-parsing an
 * append-only text file to render a table is work we would only do once before
 * regretting it. `better-sqlite3` is already a dependency, so this costs no
 * new supply chain. The log ring buffer uses it too, in its own file and for
 * its own reasons — see `logs.ts`.
 *
 * The file is the audit trail, so it lives beside `config.yaml` in the mounted
 * config volume, not in the container's ephemeral filesystem. A trail that
 * vanishes on `docker compose down` is not a trail.
 */

export const AUDIT_FILENAME = 'audit.db';

/**
 * `attempted` is written *before* the service is called; every other outcome
 * replaces it once the call resolves. A row still reading `attempted` therefore
 * means arr-mcp died mid-write — which is precisely the case an audit log
 * exists to make visible, and the one an after-the-fact-only log cannot show.
 */
export type WriteOutcome =
    | 'attempted'
    | 'applied'
    | 'dry_run'
    /** Refused by the permission tier — the service was never called. */
    | 'denied'
    /** Previewed because no valid confirmation token was presented. */
    | 'unconfirmed'
    /** The service was called and said no. */
    | 'failed';

export type AuditRecord = {
    tool: string;
    service: string;
    operation: string;
    tier: WriteTier;
    target: string;
    args: Record<string, unknown>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS write_audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT    NOT NULL,
    tool      TEXT    NOT NULL,
    service   TEXT    NOT NULL,
    operation TEXT    NOT NULL,
    tier      TEXT    NOT NULL,
    target    TEXT    NOT NULL,
    args      TEXT    NOT NULL,
    outcome   TEXT    NOT NULL,
    detail    TEXT,
    settled_at TEXT
);
CREATE INDEX IF NOT EXISTS write_audit_at ON write_audit (at DESC);
CREATE INDEX IF NOT EXISTS write_audit_service ON write_audit (service, at DESC);
`;

/** Keys whose value never belongs in a durable log, however it got there. No
 *  write tool takes one today; this is here so that stays true by construction
 *  rather than by everyone remembering. */
const SECRET_KEY = /(api[_-]?key|token|password|secret|authorization)/i;

/** Recursive: matching key names only at the top level left a secret one
 *  level down to be serialised verbatim. */
const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) ? '__REDACTED__' : scrub(v)])
        );
    }
    return value;
};

function safeArgs(args: Record<string, unknown>): string {
    return JSON.stringify(scrub(args));
}

/**
 * Thrown when the trail cannot be written. Writes are refused rather than
 * proceeding unlogged: an unrecorded deletion is the exact outcome this module
 * exists to prevent, and a read-only or full config volume is a real
 * misconfiguration a user can fix once the error names the path.
 */
export class AuditUnavailableError extends Error {
    constructor(path: string, cause: unknown) {
        super(
            `the write audit log at ${path} could not be opened, so writes are refused — ` +
                `check the config volume is writable and not full. Reads are unaffected. ` +
                `(${(cause as Error)?.message ?? 'unknown error'})`,
            { cause }
        );
        this.name = 'AuditUnavailableError';
    }
}

export class WriteAudit {
    readonly #db: Db;
    readonly #path: string;

    private constructor(db: Db, path: string) {
        this.#db = db;
        this.#path = path;
    }

    /** Opens (creating if absent) the trail in the config directory. */
    static open(configDir: string): WriteAudit {
        const path = join(configDir, AUDIT_FILENAME);
        try {
            const db = new Database(path);
            // WAL so a reader (0.6's config page) cannot block a write, and so
            // an unclean shutdown replays rather than truncates.
            db.pragma('journal_mode = WAL');
            db.pragma('synchronous = FULL');
            db.exec(SCHEMA);
            return new WriteAudit(db, path);
        } catch (err) {
            throw new AuditUnavailableError(path, err);
        }
    }

    /** In-memory trail for tests — same schema, same statements, no file. */
    static ephemeral(): WriteAudit {
        const db = new Database(':memory:');
        db.exec(SCHEMA);
        return new WriteAudit(db, ':memory:');
    }

    /**
     * Records the intent and returns its row id. Called *before* the service
     * is touched, so the trail cannot be missing an operation that happened.
     */
    begin(record: AuditRecord): number {
        try {
            const result = this.#db
                .prepare(
                    `INSERT INTO write_audit (at, tool, service, operation, tier, target, args, outcome)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'attempted')`
                )
                .run(
                    new Date().toISOString(),
                    record.tool,
                    record.service,
                    record.operation,
                    record.tier,
                    record.target,
                    safeArgs(record.args)
                );
            return Number(result.lastInsertRowid);
        } catch (err) {
            throw new AuditUnavailableError(this.#path, err);
        }
    }

    /**
     * The one legal mutation of an audit row: resolving `attempted` into what
     * actually happened. Deliberately not an INSERT of a second row — an
     * operator scanning the trail should see one line per operation, with a
     * lingering `attempted` standing out as the anomaly it is.
     *
     * Failing to settle must not mask the write's own result, so unlike
     * `begin` this logs rather than throws: by the time it runs, the service
     * has already been called and the caller has a real outcome to report.
     */
    settle(id: number, outcome: Exclude<WriteOutcome, 'attempted'>, detail?: string): void {
        try {
            this.#db
                .prepare(`UPDATE write_audit SET outcome = ?, detail = ?, settled_at = ? WHERE id = ?`)
                .run(outcome, detail ?? null, new Date().toISOString(), id);
        } catch (err) {
            logger.error({ err, id, outcome, path: this.#path }, 'could not settle write audit row');
        }
    }

    /** Newest first. The read side 0.6's config page will grow into. */
    recent(limit = 50): unknown[] {
        return this.#db.prepare(`SELECT * FROM write_audit ORDER BY id DESC LIMIT ?`).all(limit);
    }

    close(): void {
        this.#db.close();
    }
}
