import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { join } from 'node:path';
import type { HistoryEntry, HistoryQuery, Window } from '../services/types.ts';

/**
 * What the *arrs reported, kept where deleting a title cannot reach it.
 *
 * `delete_media` removes a title's history from the *arr along with the title, so
 * this is the only record that survives. A file of its own beside `audit.db` and
 * `logs.db`, for the same reasons as those. This one is a convenience rather than
 * a trail, so it does not pay for `synchronous = FULL`, and it prunes itself.
 */
export const EVENTS_FILENAME = 'events.db';

/** A backstop under the retention: a noisy instance must not grow the file for ever. */
export const MAX_EVENT_ROWS = 50_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The row's own id is what a stored event gets for `id`. */
export type WebhookEntry = Omit<HistoryEntry, 'id'>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       TEXT NOT NULL,
    service  TEXT NOT NULL,
    event    TEXT NOT NULL,
    media_id TEXT,
    entry    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_events_at ON webhook_events (at DESC, id DESC);
`;

export class WebhookEvents {
    readonly #db: Db;
    readonly #now: () => number;
    readonly #maxRows: number;

    private constructor(db: Db, now: () => number, maxRows: number) {
        this.#db = db;
        this.#now = now;
        this.#maxRows = maxRows;
    }

    static open(configDir: string): WebhookEvents {
        const db = new Database(join(configDir, EVENTS_FILENAME));
        db.pragma('journal_mode = WAL');
        db.exec(SCHEMA);
        return new WebhookEvents(db, Date.now, MAX_EVENT_ROWS);
    }

    /** In memory, for tests and for an app built without a store. */
    static ephemeral(now: () => number = Date.now, maxRows: number = MAX_EVENT_ROWS): WebhookEvents {
        const db = new Database(':memory:');
        db.exec(SCHEMA);
        return new WebhookEvents(db, now, maxRows);
    }

    /** Pruned here, so nothing has to run on a timer for an event log that may sit idle. */
    record(entry: WebhookEntry, retentionDays: number): void {
        this.#db
            .prepare('INSERT INTO webhook_events (at, service, event, media_id, entry) VALUES (?, ?, ?, ?, ?)')
            .run(entry.at, entry.service, entry.event, entry.mediaId ?? null, JSON.stringify(entry));

        const cutoff = new Date(this.#now() - retentionDays * DAY_MS).toISOString();
        this.#db.prepare('DELETE FROM webhook_events WHERE at < ?').run(cutoff);
        this.#db
            .prepare('DELETE FROM webhook_events WHERE id IN (SELECT id FROM webhook_events ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)')
            .run(this.#maxRows);
    }

    /** Newest first, in the shape `HistoryCapable` reads: `total` counts every match. */
    read(query: HistoryQuery & { service?: string }): Window<HistoryEntry> {
        const where: string[] = [];
        const args: string[] = [];
        const filter = (clause: string, value: string | undefined) => {
            if (value === undefined) return;
            where.push(clause);
            args.push(value);
        };
        filter('service = ?', query.service);
        filter('media_id = ?', query.id);
        filter('event = ?', query.eventType);
        filter('at >= ?', normalisedSince(query.since));

        const condition = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
        const { total } = this.#db.prepare(`SELECT COUNT(*) AS total FROM webhook_events ${condition}`).get(...args) as { total: number };
        const limit = query.want === undefined ? '' : `LIMIT ${Math.max(0, Math.floor(query.want))}`;
        const rows = this.#db
            .prepare(`SELECT id, entry FROM webhook_events ${condition} ORDER BY at DESC, id DESC ${limit}`)
            .all(...args) as { id: number; entry: string }[];

        return { total, items: rows.map(row => ({ ...(JSON.parse(row.entry) as WebhookEntry), id: String(row.id) })) };
    }

    close(): void {
        this.#db.close();
    }
}

/** Rows hold `toISOString()` text, so a date compares only in that same form. */
function normalisedSince(since: string | undefined): string | undefined {
    if (since === undefined) return undefined;
    const parsed = Date.parse(since);
    return Number.isNaN(parsed) ? since : new Date(parsed).toISOString();
}
