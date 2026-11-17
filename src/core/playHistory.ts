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
 * this?" can no longer be answered. This store is what still can.
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
 * seen after its item was deleted, when nothing says which it was.
 */
export type PlayRecord = {
    entry: PlaybackEntry;
    kind: 'movie' | 'episode' | 'unknown';
    year?: number;
    ids?: Pick<ExternalIds, 'tmdb' | 'tvdb' | 'imdb'>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plays (
    server       TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    item_key     TEXT NOT NULL,
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
`;

/**
 * A row with no item id is a Plex history row for a deleted item, which keeps
 * only its titles. Keyed on those, so two of them do not overwrite each other.
 */
export const playKey = (e: PlaybackEntry): string =>
    e.itemId !== '' ? e.itemId : `title:${e.seriesTitle ?? ''}|${e.title}|${e.season ?? ''}|${e.episode ?? ''}`;

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

    private constructor(db: Db) {
        this.#db = db;
        this.#select = db.prepare('SELECT record FROM plays WHERE server = ? AND user_id = ? AND item_key = ?');
        this.#upsert = db.prepare(
            `INSERT OR REPLACE INTO plays
                (server, user_id, item_key, kind, title, series_title, year, tmdb, tvdb, imdb, last_played, record)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        // Undated rows last: `NULLS LAST` reads the same in every SQLite this ships with.
        this.#read = db.prepare(
            'SELECT record FROM plays WHERE server = ? AND user_id = ? ORDER BY last_played IS NULL, last_played DESC'
        );
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

    /** One transaction per batch: a sync of a few thousand rows is one write, not thousands. */
    record(server: string, user: Pick<ServiceUser, 'id'>, plays: readonly PlayRecord[]): void {
        this.#db.transaction(() => {
            for (const seen of plays) {
                const key = playKey(seen.entry);
                const row = this.#select.get(server, user.id, key) as { record: string } | undefined;
                const next = row === undefined ? seen : merge(JSON.parse(row.record) as PlayRecord, seen);
                this.#upsert.run(
                    server,
                    user.id,
                    key,
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

    /** Newest first, undated last. */
    read(server: string, userId: string): PlayRecord[] {
        return (this.#read.all(server, userId) as { record: string }[]).map(row => JSON.parse(row.record) as PlayRecord);
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
        const { tmdb, tvdb, imdb } = row.ids;
        const ids = {
            ...(tmdb === undefined ? {} : { tmdb }),
            ...(tvdb === undefined ? {} : { tvdb }),
            ...(imdb === undefined ? {} : { imdb })
        };
        return {
            ...(row.year === undefined ? {} : { year: row.year }),
            ...(Object.keys(ids).length === 0 ? {} : { ids })
        };
    };

    const fromHistory = history.map((entry): PlayRecord =>
        // Removed before it was ever stored: the log's sentence is all there
        // is, and it does not say film or episode.
        entry.removedFromLibrary === true
            ? { entry, kind: 'unknown' }
            : entry.seriesTitle === undefined
              ? { entry, kind: 'movie', ...matchOf(films.get(entry.itemId)) }
              : { entry, kind: 'episode', ...matchOf(series.get(titleKey(entry.seriesTitle))) }
    );

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
