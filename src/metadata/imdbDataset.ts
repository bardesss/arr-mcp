import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { join } from 'node:path';

/**
 * The IMDb dataset (0.8 spec ), as a third SQLite database beside
 * `audit.db` and `logs.db`.
 *
 * Its own file, and its own module, for the reason those two are separate
 * from each other: three different retention stories. Write records survive
 * forever, log lines are a ring buffer, and this is a cache that is wholly
 * replaced every week and can be deleted at any moment without losing anything
 * a user typed. Losing it costs a download, not data.
 *
 * **Nothing here touches the network.** Downloading lives in `refresh.ts` and
 * parsing in `ingest.ts`, which is what lets every test of this file run
 * against a real database in memory with no fixture server — the thing worth
 * testing here is the SQL, and the SQL does not care where rows came from.
 */

export const IMDB_FILENAME = 'imdb.db';

/**
 * IMDb's title types, mapped onto the vocabulary the tools already speak.
 *
 * `tvMovie` counts as a film and `tvMiniSeries` as a series because that is
 * how the *arrs treat them — a mini-series lives in Sonarr. Everything else
 * IMDb publishes (shorts, video games, episodes as standalone rows) is
 * deliberately unreachable: none of it is anything this stack manages, and
 * offering it in discovery would return results nothing could then act on.
 */
const KIND_TO_IMDB: Record<'movie' | 'series', readonly string[]> = {
    movie: ['movie', 'tvMovie'],
    series: ['tvSeries', 'tvMiniSeries']
};

/**
 * Types an *arr can plausibly be managing that `discover` deliberately does
 * not offer.
 *
 * A direct-to-video film is `video`, a stand-up or holiday special is
 * `tvSpecial`, and a short film Radarr has is `tvShort` or `short`. Nobody
 * browsing "films from 1994" wants these mixed in, so they stay out of
 * `KIND_TO_IMDB` — but somebody who *owns* one still deserves its rating, and
 * `ratingsFor` reaches titles by id without going through `discover`'s
 * vocabulary at all.
 */
const ALSO_STORED = ['video', 'tvSpecial', 'tvShort', 'short'] as const;

/**
 * Every title type worth *storing*, which is deliberately more than every type
 * `discover` can *return*.
 *
 * IMDb's 12.7M rows are mostly `tvEpisode`, plus video games and adult titles
 * — none of which anything here can reach. Filtering at ingest rather than at
 * query time is the difference between a 1.3 GB database and a small one.
 *
 * This was `KIND_TO_IMDB` flattened, on the reasoning that two lists would
 * drift. They are two questions, though, and conflating them only looked free
 * while the `rating` table was unfiltered: ratings for unstored titles were
 * what kept a direct-to-video film rated. Pruning those orphans — two thirds
 * of the table — takes that prop away, so what a lookup may hit has to be
 * stated separately from what a browse may return. The pair is covered by
 * tests that a stored-but-not-discoverable kind stays out of `discover`.
 */
const STORED_KINDS: ReadonlySet<string> = new Set([...Object.values(KIND_TO_IMDB).flat(), ...ALSO_STORED]);

/**
 * SQLite's compiled-in default variable limit, minus room to spare.
 *
 * A library larger than this cannot go into one `IN (...)`, and a 900-film
 * library is ordinary — so the naive version fails on exactly the libraries
 * this feature is most useful for.
 */
const VARIABLE_LIMIT = 900;

export type RawTitle = {
    tconst: string;
    kind: string;
    title: string;
    year?: number | undefined;
    runtime?: number | undefined;
    genres?: string | undefined;
};

export type RawRating = { tconst: string; average: number; votes: number };

export type DatasetTitle = {
    tconst: string;
    title: string;
    year?: number;
    runtime?: number;
    genres: string[];
    rating?: number;
    votes?: number;
};

export type DatasetStatus = { ingestedAt?: string; titles: number; ratings: number };

/**
 * `WITHOUT ROWID` on both big tables.
 *
 * Each keys on `tconst` and nothing else, so the default layout stored every
 * id twice — once in the rowid btree holding the row, and again in the
 * implicit unique index enforcing the primary key. `WITHOUT ROWID` puts the
 * row in the key's own btree and drops the second copy. The rows here are
 * small and the key is most of them, which is exactly the shape it is for.
 *
 * `meta` holds two rows and is left alone; the pragma would be noise.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS title (
    tconst  TEXT PRIMARY KEY,
    kind    TEXT    NOT NULL,
    title   TEXT    NOT NULL,
    year    INTEGER,
    runtime INTEGER,
    genres  TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rating (
    tconst  TEXT PRIMARY KEY,
    average REAL    NOT NULL,
    votes   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS title_kind ON title(kind);
`;

/** The filters `discover` and `countDiscover` both answer to. */
export type DiscoverQuery = {
    kind: 'movie' | 'series';
    genre?: string | undefined;
    year?: number | undefined;
    minRating?: number | undefined;
};

export class ImdbDataset {
    readonly #db: Db;

    private constructor(db: Db) {
        this.#db = db;
        // WAL for the reason audit.ts uses it: the weekly ingest writes while
        // tool calls read, and a reader must never block on a twenty-minute
        // rebuild.
        this.#db.pragma('journal_mode = WAL');
        this.#dropSuperseded();
        this.#db.exec(SCHEMA);
    }

    /**
     * Throw away what an older version left that this one cannot use.
     *
     * Both cases are **drops, not migrations**, and the module header is the
     * licence for that: this is a cache that is wholly replaced every week and
     * can be deleted at any moment without losing anything a user typed.
     * Losing it costs a download. Writing migration code for it would be
     * carrying a liability to avoid a cost nobody pays — and `Runtime` starts
     * a refresh the moment it opens the database, so the refill is immediate.
     *
     * - `episode` was written through 1.0 and never read by a single query —
     *   52 MB a day and millions of rows for a table nothing consulted.
     * - `title` and `rating` predating `WITHOUT ROWID` cannot be changed in
     *   place: `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
     *   already exists, so without this an existing `imdb.db` would keep the
     *   old layout for ever and quietly never get the saving.
     */
    #dropSuperseded(): void {
        this.#db.exec('DROP INDEX IF EXISTS episode_parent; DROP TABLE IF EXISTS episode;');

        const legacy = this.#db
            .prepare(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name IN ('title', 'rating')
                    AND sql NOT LIKE '%WITHOUT ROWID%'`
            )
            .all() as { name: string }[];

        if (legacy.length === 0) return;

        // `meta` goes too, and it matters: it holds `ingested_at`, and leaving
        // it would have `status()` report a date for rows that no longer
        // exist — the dashboard claiming a fresh dataset over an empty one.
        this.#db.exec('DROP TABLE IF EXISTS title; DROP TABLE IF EXISTS rating; DROP TABLE IF EXISTS meta;');
    }

    static open(dir: string): ImdbDataset {
        return new ImdbDataset(new Database(join(dir, IMDB_FILENAME)));
    }

    /** For tests: a real database, no file. */
    static ephemeral(): ImdbDataset {
        return new ImdbDataset(new Database(':memory:'));
    }

    close(): void {
        this.#db.close();
    }

    /**
     * Ratings for the tconsts asked for, and **only** those it holds one for.
     *
     * A miss is an absent key, never a zero. The caller counts misses as
     * unrated, and a zero would rank a title IMDb has never heard of below one
     * genuinely rated 1.0 — which is the difference between "we could not look
     * this up" and "this is terrible".
     */
    ratingsFor(tconsts: readonly string[]): Map<string, number> {
        const found = new Map<string, number>();
        if (tconsts.length === 0) return found;

        for (let i = 0; i < tconsts.length; i += VARIABLE_LIMIT) {
            const chunk = tconsts.slice(i, i + VARIABLE_LIMIT);
            const rows = this.#db
                .prepare(`SELECT tconst, average FROM rating WHERE tconst IN (${chunk.map(() => '?').join(',')})`)
                .all(...chunk) as { tconst: string; average: number }[];

            for (const row of rows) found.set(row.tconst, row.average);
        }

        return found;
    }

    /**
     * The WHERE clause `discover` and `countDiscover` share.
     *
     * Split out so the count cannot drift from the page it counts — two
     * hand-maintained copies of these four filters is how "3 of 40" ends up
     * printed above a list of nine.
     */
    #discoverFilter(q: DiscoverQuery): { where: string[]; args: (string | number)[]; joinType: string } {
        const kinds = KIND_TO_IMDB[q.kind];
        const where: string[] = [`t.kind IN (${kinds.map(() => '?').join(',')})`];
        const args: (string | number)[] = [...kinds];

        if (q.genre !== undefined) {
            // Genres ship as one comma-separated string. The commas on both
            // sides of the pattern are what stop "Drama" matching "Docudrama".
            where.push(`(',' || LOWER(t.genres) || ',') LIKE ?`);
            args.push(`%,${q.genre.toLowerCase()},%`);
        }
        if (q.year !== undefined) {
            where.push('t.year = ?');
            args.push(q.year);
        }
        if (q.minRating !== undefined) {
            where.push('r.average >= ?');
            args.push(q.minRating);
        }

        // INNER JOIN only when a rating is required: an unrated title cannot
        // satisfy a minimum, but is a perfectly good answer without one.
        return { where, args, joinType: q.minRating === undefined ? 'LEFT JOIN' : 'JOIN' };
    }

    /**
     * How many titles match, so a paged caller learns what it is paging
     * through. Worth the second query now that `offset` reaches SQL: the old
     * `total` was "what came back", which reads as "that is all there is" the
     * moment a caller asks for page two.
     */
    countDiscover(q: DiscoverQuery): number {
        const { where, args, joinType } = this.#discoverFilter(q);
        const row = this.#db
            .prepare(
                `SELECT COUNT(*) AS n
                   FROM title t ${joinType} rating r ON r.tconst = t.tconst
                  WHERE ${where.join(' AND ')}`
            )
            .get(...args) as { n: number };
        return row.n;
    }

    discover(q: DiscoverQuery & { limit: number; offset?: number | undefined }): DatasetTitle[] {
        const { where, args, joinType } = this.#discoverFilter(q);
        // OFFSET in SQL, not a slice of the rows this returns: the limit is
        // applied here, so slicing afterwards only ever cut into page one and
        // every page after the first came back empty.
        args.push(q.limit, q.offset ?? 0);

        const rows = this.#db
            .prepare(
                `SELECT t.tconst, t.title, t.year, t.runtime, t.genres, r.average, r.votes
                   FROM title t ${joinType} rating r ON r.tconst = t.tconst
                  WHERE ${where.join(' AND ')}
               ORDER BY CASE WHEN r.average IS NULL THEN 1 ELSE 0 END, r.average DESC, t.year DESC
                  LIMIT ? OFFSET ?`
            )
            .all(...args) as {
            tconst: string;
            title: string;
            year: number | null;
            runtime: number | null;
            genres: string | null;
            average: number | null;
            votes: number | null;
        }[];

        return rows.map(row => ({
            tconst: row.tconst,
            title: row.title,
            ...(row.year === null ? {} : { year: row.year }),
            ...(row.runtime === null ? {} : { runtime: row.runtime }),
            genres: row.genres === null || row.genres === '' ? [] : row.genres.split(','),
            ...(row.average === null ? {} : { rating: row.average }),
            ...(row.votes === null ? {} : { votes: row.votes })
        }));
    }

    /** What the dashboard needs to say whether this is working. */
    status(): DatasetStatus {
        const count = (table: string): number =>
            (this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

        const at = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get('ingested_at') as
            | { value: string }
            | undefined;

        return {
            ...(at === undefined ? {} : { ingestedAt: at.value }),
            titles: count('title'),
            ratings: count('rating')
        };
    }

    /**
     * Replace the whole dataset in one transaction.
     *
     * A replace rather than a merge because the dumps are full daily
     * snapshots — merging would accumulate titles IMDb has since withdrawn.
     * One transaction because a half-applied replace is a dataset that answers
     * confidently from a mixture of two days, and because it is what makes a
     * download dying halfway leave yesterday's good data in place rather than
     * a partial one nobody can tell is partial.
     *
     * The rows arrive as iterables and are consumed lazily inside the
     * transaction: `title.basics` is on the order of 10⁷ rows, and this runs
     * on a NAS.
     */
    replaceAll(rows: { titles: Iterable<RawTitle>; ratings: Iterable<RawRating> }): void {
        const insertTitle = this.#db.prepare(
            'INSERT OR REPLACE INTO title (tconst, kind, title, year, runtime, genres) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertRating = this.#db.prepare(
            'INSERT OR REPLACE INTO rating (tconst, average, votes) VALUES (?, ?, ?)'
        );
        const setMeta = this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

        this.#db.transaction(() => {
            this.#db.exec('DELETE FROM title; DELETE FROM rating;');

            for (const r of rows.ratings) insertRating.run(r.tconst, r.average, r.votes);

            for (const t of rows.titles) {
                if (!STORED_KINDS.has(t.kind)) continue;
                insertTitle.run(t.tconst, t.kind, t.title, t.year ?? null, t.runtime ?? null, t.genres ?? null);
            }

            // An unrated title is one nothing here can do anything with: every
            // rating lookup misses it, and `discover` only surfaces it when no
            // minimum was asked for. Deleted in SQL against the index rather
            // than checked per row, which would mean holding 1.7M ids in heap —
            // the mistake that crashed the first real ingest.
            this.#db.exec('DELETE FROM title WHERE tconst NOT IN (SELECT tconst FROM rating)');

            // And the mirror image, which is the larger half: `rating` arrives
            // unfiltered, so it carried a row for every episode, video game and
            // short IMDb has ever rated — 1.7M rows against 546K titles. After
            // this the two tables hold the same set of ids.
            //
            // Safe only because `ALSO_STORED` widened what a title *is*: these
            // orphans were what kept a direct-to-video film rated back when
            // `ratingsFor` could reach a rating whose title was never stored.
            this.#db.exec('DELETE FROM rating WHERE tconst NOT IN (SELECT tconst FROM title)');

            setMeta.run('ingested_at', new Date().toISOString());
        })();

        // Outside the transaction, because VACUUM cannot run inside one.
        //
        // SQLite does not hand freed pages back to the OS by itself, so a
        // replace left the file at its high-water mark for ever — and every
        // replace frees the entire previous dataset. The ~125 MB the README
        // quoted was a number only `measure-imdb.ts` ever saw, because it
        // vacuumed afterwards and the running server never did. Costs a full
        // rewrite once a week, on a file that has just been rewritten anyway.
        this.#db.exec('VACUUM');
    }
}
