import Database from 'better-sqlite3';
import type { Database as Db, Statement } from 'better-sqlite3';
import { join } from 'node:path';
import { unfence } from './fence.ts';
import type { ExternalIds, IndexInput } from './resolver.ts';
import type { PlaybackEntry, ServiceUser } from '../services/types.ts';

/**
 * Every play a media server has reported, kept after the server forgets it.
 *
 * Jellyfin's activity log keeps 30 days by default and its played list is read
 * 500 at a time; Plex's history is read a bounded number of pages per call. A
 * title watched and then deleted drops out of all of them, and "have I seen
 * this?" can no longer be answered. This store is what still can. The first
 * sync for a server and user reads the whole history once (`backfills`), so
 * plays older than those bounds are in it too.
 *
 * One row per item per user, not per play: the question is whether something
 * was watched and when last, so the file grows with what a household has
 * watched, not with how often. Nothing is pruned for that reason. A file of
 * its own beside `events.db`, like the other stores.
 */
const PLAYS_FILENAME = 'plays.db';

/**
 * A play as stored. `entry` is the row exactly as `get_playback` history
 * returns it. `year` and `ids` are what a title can still be matched on once
 * the server has no item left to ask about; on an episode they are the
 * series', since the series is what gets matched. `unknown` is a play first
 * seen after its item was deleted, when nothing says which it was. `track` is
 * a song, only from a webhook a user opted into, with its artist as
 * `seriesTitle`; it is never matched against a film or an episode.
 */
export type PlayRecord = {
    entry: PlaybackEntry;
    kind: 'movie' | 'episode' | 'track' | 'unknown';
    year?: number;
    ids?: Pick<ExternalIds, 'tmdb' | 'tvdb' | 'imdb'>;
};

/** The ids that are there, as a record keeps them, or `undefined` for none. */
export function recordIds({ tmdb, tvdb, imdb }: { tmdb?: number | undefined; tvdb?: number | undefined; imdb?: string | undefined }): PlayRecord['ids'] {
    const ids = {
        ...(tmdb === undefined ? {} : { tmdb }),
        ...(tvdb === undefined ? {} : { tvdb }),
        ...(imdb === undefined ? {} : { imdb })
    };
    return Object.keys(ids).length === 0 ? undefined : ids;
}

/** A play a webhook reported, with the id of the user it is kept under. */
export type WebhookPlay = { userId: string; record: PlayRecord };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plays (
    server       TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    item_key     TEXT NOT NULL,
    user_name    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    series_title TEXT,
    year         INTEGER,
    tmdb         INTEGER,
    tvdb         INTEGER,
    imdb         TEXT,
    last_played  TEXT,
    record       TEXT NOT NULL,
    PRIMARY KEY (server, user_id, item_key)
);
CREATE INDEX IF NOT EXISTS plays_title ON plays (server, user_id, title);
CREATE TABLE IF NOT EXISTS syncs (
    server TEXT PRIMARY KEY,
    at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backfills (
    server  TEXT NOT NULL,
    user_id TEXT NOT NULL,
    at      TEXT NOT NULL,
    PRIMARY KEY (server, user_id)
);
`;

/** What the config UI's Plays tab shows: counts, never the whole list. */
export type PlaySummary = {
    server: string;
    user: string;
    plays: number;
    lastPlayed?: string;
};

/**
 * A row with no item id is a Plex history row for a deleted item, which keeps
 * only its titles. Keyed on those, so two of them do not overwrite each other.
 */
export const playKey = (e: PlaybackEntry): string =>
    e.itemId !== '' ? e.itemId : `title:${e.seriesTitle ?? ''}|${e.title}|${e.season ?? ''}|${e.episode ?? ''}`;

/**
 * The same play under the other kind of key: stored by item id while the item
 * existed, seen by title once it was deleted, or the other way round. A film
 * matches on title and a year either side, so a remake with the same title
 * stays apart; with no year it does not match at all. An episode matches on
 * series title, title, season and episode.
 */
const TWIN_SQL = `
SELECT item_key, record FROM plays
WHERE server = @server AND user_id = @user AND item_key <> @key
  AND CASE WHEN @wantTitleKey = 1
        -- A row folded from a deletion keeps its old item id as key, but its
        -- entry has none: a film added back under a new id is still that play.
        THEN item_key LIKE 'title:%' OR json_extract(record, '$.entry.itemId') = ''
        ELSE item_key NOT LIKE 'title:%'
      END
  AND title = @title
  AND (
        (@kind = 'movie' AND kind = 'movie' AND series_title IS NULL AND ABS(year - @year) <= 1)
     OR (@kind = 'episode' AND kind = 'episode' AND series_title = @seriesTitle
         AND json_extract(record, '$.entry.season') IS @season
         AND json_extract(record, '$.entry.episode') IS @episode)
  )
ORDER BY last_played IS NULL, last_played DESC
LIMIT 1`;

/** ISO-8601 UTC strings compare lexically. */
const newest = (a: string | undefined, b: string | undefined): string | undefined =>
    a === undefined ? b : b === undefined ? a : a > b ? a : b;

/**
 * What a second sighting of the same item does to the stored one.
 *
 * A removed log row carries a sentence for a title and nothing else, so it
 * marks the stored row removed and leaves the title, numbering, year and ids
 * from when the item still existed. Any other sighting is the server's current
 * word on the item, except that year and ids a sighting lacks are kept.
 */
function merge(stored: PlayRecord, seen: PlayRecord): PlayRecord {
    const lastPlayed = newest(stored.entry.lastPlayed, seen.entry.lastPlayed);
    const dated = <T extends PlaybackEntry>(e: T): T => (lastPlayed === undefined ? e : { ...e, lastPlayed });

    if (seen.entry.removedFromLibrary === true) {
        return { ...stored, entry: dated({ ...stored.entry, removedFromLibrary: true }) };
    }
    const { removedFromLibrary: _gone, ...entry } = seen.entry;
    return {
        entry: dated(entry),
        kind: seen.kind,
        ...((seen.year ?? stored.year) === undefined ? {} : { year: seen.year ?? stored.year }),
        ...((seen.ids ?? stored.ids) === undefined ? {} : { ids: seen.ids ?? stored.ids })
    };
}

export class PlayHistory {
    readonly #db: Db;
    readonly #select: Statement;
    readonly #upsert: Statement;
    readonly #read: Statement;
    readonly #twin: Statement;
    readonly #delete: Statement;

    private constructor(db: Db) {
        this.#db = db;
        this.#select = db.prepare('SELECT item_key, record FROM plays WHERE server = ? AND user_id = ? AND item_key = ?');
        this.#upsert = db.prepare(
            `INSERT OR REPLACE INTO plays
                (server, user_id, item_key, user_name, kind, title, series_title, year, tmdb, tvdb, imdb, last_played, record)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        // Undated rows last: `NULLS LAST` reads the same in every SQLite this ships with.
        this.#read = db.prepare(
            'SELECT record FROM plays WHERE server = ? AND user_id = ? ORDER BY last_played IS NULL, last_played DESC'
        );
        this.#twin = db.prepare(TWIN_SQL);
        this.#delete = db.prepare('DELETE FROM plays WHERE server = ? AND user_id = ? AND item_key = ?');
    }

    static open(configDir: string): PlayHistory {
        const db = new Database(join(configDir, PLAYS_FILENAME));
        db.pragma('journal_mode = WAL');
        db.exec(SCHEMA);
        return new PlayHistory(db);
    }

    /** In memory, for tests and for an app built without a store. */
    static ephemeral(): PlayHistory {
        const db = new Database(':memory:');
        db.exec(SCHEMA);
        return new PlayHistory(db);
    }

    /**
     * One transaction per batch: a sync of a few thousand rows is one write,
     * not thousands. `replace` drops what the store holds for this server and
     * user first, in the same transaction, for a full history read that
     * stands in for everything stored.
     */
    record(server: string, user: Pick<ServiceUser, 'id'>, plays: readonly PlayRecord[], opts: { replace?: boolean } = {}): void {
        this.#db.transaction(() => {
            if (opts.replace === true) this.#db.prepare('DELETE FROM plays WHERE server = ? AND user_id = ?').run(server, user.id);
            for (const seen of plays) {
                let key = playKey(seen.entry);
                let row = this.#select.get(server, user.id, key) as { item_key: string; record: string } | undefined;
                if (row === undefined) {
                    const twin = this.#findTwin(server, user.id, key, seen);
                    if (twin !== undefined) {
                        // The item id is the better key while it lasts: keep
                        // the row under it, or move a title row onto it.
                        if (seen.entry.itemId === '') key = twin.item_key;
                        else this.#delete.run(server, user.id, twin.item_key);
                        row = twin;
                    }
                }
                const next = row === undefined ? seen : merge(JSON.parse(row.record) as PlayRecord, seen);
                this.#upsert.run(
                    server,
                    user.id,
                    key,
                    next.entry.user,
                    next.kind,
                    next.entry.title,
                    next.entry.seriesTitle ?? null,
                    next.year ?? null,
                    next.ids?.tmdb ?? null,
                    next.ids?.tvdb ?? null,
                    next.ids?.imdb ?? null,
                    next.entry.lastPlayed ?? null,
                    JSON.stringify(next)
                );
            }
        })();
    }

    #findTwin(server: string, userId: string, key: string, seen: PlayRecord): { item_key: string; record: string } | undefined {
        if (seen.kind === 'unknown' || seen.kind === 'track') return undefined;
        if (seen.kind === 'movie' && seen.year === undefined) return undefined;
        return this.#twin.get({
            server,
            user: userId,
            key,
            wantTitleKey: seen.entry.itemId === '' ? 0 : 1,
            title: seen.entry.title,
            kind: seen.kind,
            year: seen.year ?? null,
            seriesTitle: seen.entry.seriesTitle ?? null,
            season: seen.entry.season ?? null,
            episode: seen.entry.episode ?? null
        }) as { item_key: string; record: string } | undefined;
    }

    /** Whether this server and user still need their one full history read. */
    needsBackfill(server: string, userId: string): boolean {
        return this.#db.prepare('SELECT 1 FROM backfills WHERE server = ? AND user_id = ?').get(server, userId) === undefined;
    }

    markBackfilled(server: string, userId: string, at: string): void {
        this.#db.prepare('INSERT OR REPLACE INTO backfills (server, user_id, at) VALUES (?, ?, ?)').run(server, userId, at);
    }

    /** Newest first, undated last. */
    read(server: string, userId: string): PlayRecord[] {
        return (this.#read.all(server, userId) as { record: string }[]).map(row => JSON.parse(row.record) as PlayRecord);
    }

    /** When the hourly sync last finished for a server, so the UI can say it runs. */
    markSynced(server: string, at: string): void {
        this.#db.prepare('INSERT OR REPLACE INTO syncs (server, at) VALUES (?, ?)').run(server, at);
    }

    syncs(): Record<string, string> {
        const rows = this.#db.prepare('SELECT server, at FROM syncs ORDER BY server').all() as { server: string; at: string }[];
        return Object.fromEntries(rows.map(r => [r.server, r.at]));
    }

    /** One row per server and user. The user is the name last seen, since the id means nothing to a reader. */
    summary(): PlaySummary[] {
        const rows = this.#db
            .prepare(
                `SELECT server, MAX(user_name) AS user, COUNT(*) AS plays, MAX(last_played) AS lastPlayed
                 FROM plays GROUP BY server, user_id ORDER BY server, user`
            )
            .all() as { server: string; user: string; plays: number; lastPlayed: string | null }[];
        return rows.map(r => ({
            server: r.server,
            user: r.user,
            plays: r.plays,
            ...(r.lastPlayed === null ? {} : { lastPlayed: r.lastPlayed })
        }));
    }

    /** The newest plays across every server and user. */
    recent(limit: number): PlayRecord[] {
        return (
            this.#db
                .prepare('SELECT record FROM plays ORDER BY last_played IS NULL, last_played DESC LIMIT ?')
                .all(Math.max(0, Math.floor(limit))) as { record: string }[]
        ).map(row => JSON.parse(row.record) as PlayRecord);
    }

    /** Everything, sync and catch-up times included. The next sync fills it again, reading the history in full. */
    clear(): void {
        this.#db.transaction(() => {
            this.#db.exec('DELETE FROM plays; DELETE FROM syncs; DELETE FROM backfills;');
        })();
    }

    close(): void {
        this.#db.close();
    }
}

/**
 * A history read and a library read, as records.
 *
 * The library is where ids and year come from: a history row has neither, and
 * once the item is deleted nothing will have them. A film joins on its item
 * id, an episode on its series title. Films the library marks watched that the
 * history did not return (Jellyfin's played list is read 500 at a time) are
 * added from the library row itself.
 */
export function playsFrom(
    server: string,
    user: ServiceUser,
    history: readonly PlaybackEntry[],
    library: readonly IndexInput[]
): PlayRecord[] {
    // Unfenced first: both sides are fenced, but under different field names
    // (Jellyfin's `SeriesName` on an episode, `Name` on the series row).
    const titleKey = (title: string): string => unfence(title).toLowerCase();
    const films = new Map<string, IndexInput>();
    const series = new Map<string, IndexInput>();
    for (const row of library) {
        if (row.kind === 'movie' && row.playback?.itemId !== undefined) films.set(row.playback.itemId, row);
        if (row.kind === 'series') series.set(titleKey(row.title), row);
    }

    const matchOf = (row: IndexInput | undefined): Pick<PlayRecord, 'year' | 'ids'> => {
        if (row === undefined) return {};
        const ids = recordIds(row.ids);
        return {
            ...(row.year === undefined ? {} : { year: row.year }),
            ...(ids === undefined ? {} : { ids })
        };
    };

    const fromHistory = history.map(({ releaseYear, ...entry }): PlayRecord => {
        // Removed before it was ever stored: the log's sentence is all there
        // is, and it does not say film or episode.
        if (entry.removedFromLibrary === true) return { entry, kind: 'unknown' };
        if (entry.seriesTitle !== undefined) return { entry, kind: 'episode', ...matchOf(series.get(titleKey(entry.seriesTitle))) };
        // A deleted film has no library row; the history row's own release
        // year is then all it can be matched on. A deleted row with neither a
        // series nor a release year does not say it was a film: Plex sets the
        // year on films only, so this is likely an episode that lost its series.
        const match = matchOf(films.get(entry.itemId));
        const year = match.year ?? releaseYear;
        if (entry.itemId === '' && year === undefined) return { entry, kind: 'unknown' };
        return { entry, kind: 'movie', ...match, ...(year === undefined ? {} : { year }) };
    });

    const seen = new Set(history.map(e => e.itemId));
    const fromLibrary = [...films.values()].flatMap((row): PlayRecord[] => {
        const playback = row.playback;
        if (playback?.watched !== true || playback.itemId === undefined || seen.has(playback.itemId)) return [];
        return [
            {
                entry: {
                    service: server,
                    kind: 'watched',
                    source: 'marked_played',
                    itemId: playback.itemId,
                    title: row.title,
                    user: user.name,
                    ...(playback.lastPlayed === undefined ? {} : { lastPlayed: playback.lastPlayed })
                },
                kind: 'movie',
                ...matchOf(row)
            }
        ];
    });

    return [...fromHistory, ...fromLibrary];
}
