import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMDB_FILENAME, ImdbDataset } from '../src/metadata/imdbDataset.ts';

/**
 * The parts of the store that only a real file can show: the physical schema,
 * the rebuild that gets an existing database onto it, and whether the file
 * actually gives space back.
 *
 * Everything else about this class is tested in `imdbDataset.test.ts` against
 * an in-memory database, which is faster and says the same thing about SQL. It
 * cannot say anything about bytes on disk.
 */

let dir: string;
let db: ImdbDataset | undefined;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arr-mcp-dbfile-'));
});

afterEach(() => {
    try {
        db?.close();
    } catch {
        // Already closed by the test.
    }
    db = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const path = (): string => join(dir, IMDB_FILENAME);

/** The `CREATE TABLE` SQLite actually stored, read without the class. */
const schemaOf = (table: string): string => {
    const raw = new Database(path(), { readonly: true });
    try {
        const row = raw.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as
            | { sql: string }
            | undefined;
        return row?.sql ?? '';
    } finally {
        raw.close();
    }
};

const rows = (count: number) => ({
    titles: Array.from({ length: count }, (_, i) => ({
        tconst: `tt${i}`,
        kind: 'movie',
        title: `Film number ${i} with a title long enough to occupy real pages`,
        year: 2000,
        genres: 'Drama,Crime,Thriller'
    })),
    ratings: Array.from({ length: count }, (_, i) => ({ tconst: `tt${i}`, average: 7, votes: 100 }))
});

describe('the physical schema', () => {
    /**
     * `title` keys on `tconst` and nothing else, so the default rowid btree
     * plus the implicit unique index on the key stored every id twice.
     */
    it('stores title without a redundant rowid index', () => {
        db = ImdbDataset.open(dir);
        expect(schemaOf('title')).toContain('WITHOUT ROWID');
    });

    /**
     * `CREATE TABLE IF NOT EXISTS` cannot change a table that already exists,
     * so an `imdb.db` written by an earlier version would keep the old layout
     * forever and quietly never get the saving.
     *
     * Rebuilt rather than migrated, because this is a cache: losing it costs a
     * download, not data — the module has said so since it was written — and
     * the refresh that follows startup refills it immediately.
     */
    it('rebuilds a database still carrying the old rowid schema', () => {
        const legacy = new Database(path());
        legacy.exec(`
            CREATE TABLE title (tconst TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
                                year INTEGER, runtime INTEGER, genres TEXT);
            CREATE TABLE rating (tconst TEXT PRIMARY KEY, average REAL NOT NULL, votes INTEGER NOT NULL);
        `);
        legacy.prepare('INSERT INTO rating VALUES (?, ?, ?)').run('tt0903747', 9.5, 100);
        legacy.close();

        db = ImdbDataset.open(dir);

        expect(schemaOf('title')).toContain('WITHOUT ROWID');
        // The `rating` table is superseded outright and is not recreated.
        expect(schemaOf('rating')).toBe('');
        // The stale row went with the old table. An empty dataset reports
        // itself as empty, and the next ingest refills it.
        expect(db.status().ratings).toBe(0);
        expect(db.status().ingestedAt).toBeUndefined();
    });

    /**
     * The upgrade path every real 1.15.5 install takes, not the pre-`WITHOUT
     * ROWID` one above: `title` was already `WITHOUT ROWID` by then, just
     * without `bucket`. That is the shape `#dropSuperseded`'s
     * `OR sql NOT LIKE '%bucket%'` disjunct exists for — without it, a table
     * that already satisfies `WITHOUT ROWID` is left in place, and the first
     * `discover` against it throws for a missing column.
     */
    it('rebuilds a 1.15.5 database that is WITHOUT ROWID but has no bucket column', () => {
        const legacy = new Database(path());
        legacy.exec(`
            CREATE TABLE title (
                tconst  TEXT PRIMARY KEY,
                kind    TEXT NOT NULL,
                title   TEXT NOT NULL,
                year    INTEGER,
                runtime INTEGER,
                genres  TEXT
            ) WITHOUT ROWID;
            CREATE TABLE rating (tconst TEXT PRIMARY KEY, average REAL NOT NULL, votes INTEGER NOT NULL);
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        legacy.prepare('INSERT INTO title (tconst, kind, title, year) VALUES (?, ?, ?, ?)').run(
            'tt0903747',
            'tvSeries',
            'Breaking Bad',
            2008
        );
        legacy.prepare('INSERT INTO rating VALUES (?, ?, ?)').run('tt0903747', 9.5, 2_200_000);
        legacy.prepare("INSERT INTO meta VALUES ('ingested_at', ?)").run(new Date().toISOString());
        legacy.close();

        db = ImdbDataset.open(dir);

        expect(schemaOf('title')).toContain('bucket');
        expect(schemaOf('rating')).toBe('');
        expect(db.status().ingestedAt).toBeUndefined();
    });

    /** A database already on the new schema keeps its contents. */
    it('leaves an up-to-date database alone', () => {
        db = ImdbDataset.open(dir);
        db.replaceAll(rows(10));
        db.close();

        db = ImdbDataset.open(dir);
        expect(db.status().ratings).toBe(10);
    });
});

describe('giving space back', () => {
    /**
     * SQLite does not return freed pages to the OS on its own, so a replace
     * that shrinks the dataset used to leave the file at its high-water mark
     * for good — and the ~125 MB in the README was a figure only
     * `measure-imdb.ts` ever saw, because it vacuumed and the running server
     * did not.
     */
    it('shrinks the file when a replace holds far less than the last one', () => {
        db = ImdbDataset.open(dir);
        db.replaceAll(rows(20_000));
        db.close();
        const big = statSync(path()).size;

        db = ImdbDataset.open(dir);
        db.replaceAll(rows(10));
        db.close();
        const small = statSync(path()).size;

        expect(small).toBeLessThan(big / 2);
    });
});
