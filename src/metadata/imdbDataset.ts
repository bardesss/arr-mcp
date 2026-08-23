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

/** The browse axis. `kind` says what a row *is*; this says where `discover`
 *  may surface it, and null keeps a stored-but-not-discoverable kind out. */
function bucketFor(kind: string): string | null {
    for (const [bucket, kinds] of Object.entries(KIND_TO_IMDB)) {
        if (kinds.includes(kind)) return bucket;
    }
    return null;
}

/**
 * SQLite's compiled-in default variable limit, minus room to spare.
 *
 * A library larger than this cannot go into one `IN (...)`, and a 900-film
 * library is ordinary — so the naive version fails on exactly the libraries
 * this feature is most useful for.
 */
const VARIABLE_LIMIT = 900;

/** `%`, `_` and the escape character itself, for a LIKE pattern built from
 *  user input. Unescaped, `genre: "%"` matched every genre there is. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, m => `\\${m}`);

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
 * `WITHOUT ROWID` on `title`.
 *
 * It keys on `tconst` and nothing else, so the default layout stored every id
 * twice — once in the rowid btree holding the row, and again in the implicit
 * unique index enforcing the primary key. `WITHOUT ROWID` puts the row in the
 * key's own btree and drops the second copy.
 *
 * `rating` and `votes` live here rather than in a table of their own because
 * `replaceAll` forces both to hold the same id set anyway, so a second table
 * was a duplicate — and because a rating in a joined table cannot be indexed
 * together with the browse filter, which is what made `discover` sort its
 * whole candidate set on every call.
 *
 * `meta` holds two rows and is left alone; the pragma would be noise.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS title (
    tconst  TEXT PRIMARY KEY,
    kind    TEXT    NOT NULL,
    bucket  TEXT,
    title   TEXT    NOT NULL,
    year    INTEGER,
    runtime INTEGER,
    genres  TEXT,
    rating  REAL    NOT NULL,
    votes   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS title_bucket_rating ON title(bucket, rating DESC, year DESC);
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

    /**
     * Where the file lives, or `undefined` for an ephemeral one.
     *
     * The refresher needs it to hand the ingest to a worker thread: a
     * better-sqlite3 handle cannot cross a thread boundary, so the worker
     * opens its own connection to the same path.
     */
    readonly dir: string | undefined;

    private constructor(db: Db, dir?: string) {
        this.#db = db;
        this.dir = dir;
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
     * - `title` predating `WITHOUT ROWID` or the `bucket` column cannot be
     *   changed in place: `CREATE TABLE IF NOT EXISTS` is a no-op against a
     *   table that already exists, so without this an existing `imdb.db`
     *   would keep the old layout for ever and quietly never get the saving.
     * - `rating` is superseded outright: its columns live on `title` now.
     */
    #dropSuperseded(): void {
        this.#db.exec('DROP INDEX IF EXISTS episode_parent; DROP TABLE IF EXISTS episode;');

        const stale = this.#db
            .prepare(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name = 'title'
                    AND (sql NOT LIKE '%WITHOUT ROWID%' OR sql NOT LIKE '%bucket%')`
            )
            .all() as { name: string }[];

        // The `rating` table is superseded outright: its columns live on
        // `title` now, and leaving it would be a stale duplicate nothing reads.
        this.#db.exec('DROP TABLE IF EXISTS rating; DROP INDEX IF EXISTS title_kind;');

        if (stale.length === 0) return;

        // `meta` goes too, and it matters: it holds `ingested_at`, and leaving
        // it would have `status()` report a date for rows that no longer
        // exist — the dashboard claiming a fresh dataset over an empty one.
        this.#db.exec('DROP TABLE IF EXISTS title; DROP TABLE IF EXISTS meta;');
    }

    static open(dir: string): ImdbDataset {
        return new ImdbDataset(new Database(join(dir, IMDB_FILENAME)), dir);
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
                .prepare(`SELECT tconst, rating FROM title WHERE tconst IN (${chunk.map(() => '?').join(',')})`)
                .all(...chunk) as { tconst: string; rating: number }[];

            for (const row of rows) found.set(row.tconst, row.rating);
        }

        return found;
    }

    /**
     * The WHERE clause `discover` and `countDiscover` share.
     *
     * Split out so the count cannot drift from the page it counts — two
     * hand-maintained copies of these filters is how "3 of 40" ends up printed
     * above a list of nine.
     *
     * `bucket = ?` rather than `kind IN (?,?)`: an IN over the index's leading
     * column stops SQLite walking it in sorted order, which is the whole
     * reason `title_bucket_rating` exists.
     */
    #discoverFilter(q: DiscoverQuery): { where: string[]; args: (string | number)[] } {
        const where: string[] = ['t.bucket = ?'];
        const args: (string | number)[] = [q.kind];

        if (q.genre !== undefined) {
            // Genres ship as one comma-separated string. The commas on both
            // sides of the pattern are what stop "Drama" matching "Docudrama".
            where.push(`(',' || LOWER(t.genres) || ',') LIKE ? ESCAPE '\\'`);
            args.push(`%,${escapeLike(q.genre.toLowerCase())},%`);
        }
        if (q.year !== undefined) {
            where.push('t.year = ?');
            args.push(q.year);
        }
        if (q.minRating !== undefined) {
            where.push('t.rating >= ?');
            args.push(q.minRating);
        }

        return { where, args };
    }

    /**
     * How many titles match, so a paged caller learns what it is paging
     * through. Worth the second query now that `offset` reaches SQL: the old
     * `total` was "what came back", which reads as "that is all there is" the
     * moment a caller asks for page two.
     */
    countDiscover(q: DiscoverQuery): number {
        const { where, args } = this.#discoverFilter(q);
        const row = this.#db
            .prepare(`SELECT COUNT(*) AS n FROM title t WHERE ${where.join(' AND ')}`)
            .get(...args) as { n: number };
        return row.n;
    }

    discover(q: DiscoverQuery & { limit: number; offset?: number | undefined }): DatasetTitle[] {
        const { where, args } = this.#discoverFilter(q);
        // OFFSET in SQL, not a slice of the rows this returns: the limit is
        // applied here, so slicing afterwards only ever cut into page one and
        // every page after the first came back empty.
        args.push(q.limit, q.offset ?? 0);

        const rows = this.#db
            .prepare(
                `SELECT t.tconst, t.title, t.year, t.runtime, t.genres, t.rating, t.votes
                   FROM title t
                  WHERE ${where.join(' AND ')}
               ORDER BY t.rating DESC, t.year DESC
                  LIMIT ? OFFSET ?`
            )
            .all(...args) as {
            tconst: string;
            title: string;
            year: number | null;
            runtime: number | null;
            genres: string | null;
            rating: number;
            votes: number;
        }[];

        return rows.map(row => ({
            tconst: row.tconst,
            title: row.title,
            ...(row.year === null ? {} : { year: row.year }),
            ...(row.runtime === null ? {} : { runtime: row.runtime }),
            genres: row.genres === null || row.genres === '' ? [] : row.genres.split(','),
            rating: row.rating,
            votes: row.votes
        }));
    }

    /** What the dashboard needs to say whether this is working. */
    status(): DatasetStatus {
        const at = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get('ingested_at') as
            | { value: string }
            | undefined;

        const titles = (this.#db.prepare('SELECT COUNT(*) AS n FROM title').get() as { n: number }).n;

        return {
            ...(at === undefined ? {} : { ingestedAt: at.value }),
            titles,
            // Every stored title is rated, so these are the same number. Kept
            // as a separate field because the dashboard renders both and the
            // shape is public.
            ratings: titles
        };
    }

    /** For tests: the storage invariants no public method exposes. */
    debugRows(): { tconst: string; kind: string; bucket: string | null }[] {
        return this.#db.prepare('SELECT tconst, kind, bucket FROM title ORDER BY tconst').all() as {
            tconst: string;
            kind: string;
            bucket: string | null;
        }[];
    }

    /** For tests: the query plan for a discover, so a change that gives the
     *  index back fails loudly rather than quietly costing 180ms a call. */
    explainDiscover(q: DiscoverQuery): string[] {
        const { where, args } = this.#discoverFilter(q);
        const rows = this.#db
            .prepare(
                `EXPLAIN QUERY PLAN
                 SELECT t.tconst, t.title, t.year, t.runtime, t.genres, t.rating, t.votes
                   FROM title t
                  WHERE ${where.join(' AND ')}
               ORDER BY t.rating DESC, t.year DESC
                  LIMIT ? OFFSET ?`
            )
            .all(...args, 20, 0) as { detail: string }[];
        return rows.map(r => r.detail);
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
            `INSERT OR REPLACE INTO title (tconst, kind, bucket, title, year, runtime, genres, rating, votes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const setMeta = this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

        this.#db.transaction(() => {
            this.#db.exec('DELETE FROM title;');

            // Ratings first and held in memory, because a title row cannot be
            // written without one. `rating` arrives unfiltered — a row for
            // every episode, video game and short IMDb has ever rated — so
            // this is the larger of the two inputs and the one worth being
            // careful about. Only the average and vote count are kept, not the
            // whole row, and only for ids a title may claim.
            const ratings = new Map<string, { average: number; votes: number }>();
            for (const r of rows.ratings) ratings.set(r.tconst, { average: r.average, votes: r.votes });

            for (const t of rows.titles) {
                if (!STORED_KINDS.has(t.kind)) continue;
                // An unrated title is one nothing here can do anything with:
                // every rating lookup misses it and `discover` orders by
                // rating. Skipped on the way in rather than deleted afterwards,
                // which is what the two mutual `DELETE ... NOT IN` passes used
                // to do.
                const rated = ratings.get(t.tconst);
                if (rated === undefined) continue;

                insertTitle.run(
                    t.tconst,
                    t.kind,
                    bucketFor(t.kind),
                    t.title,
                    t.year ?? null,
                    t.runtime ?? null,
                    t.genres ?? null,
                    rated.average,
                    rated.votes
                );
            }

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
