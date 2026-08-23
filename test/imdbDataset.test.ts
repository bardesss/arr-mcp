import { afterEach, describe, expect, it } from 'vitest';
import { ImdbDataset } from '../src/metadata/imdbDataset.ts';

/**
 * The dataset store, driven against a real SQLite database in memory.
 *
 * No fixture server and no network anywhere in this file, which is the point
 * of keeping downloading in `refresh.ts` and parsing in `ingest.ts`: the thing
 * most worth testing here is the SQL, and the SQL does not care where the rows
 * came from.
 */

let db: ImdbDataset;
afterEach(() => db?.close());

const seed = (): ImdbDataset => {
    db = ImdbDataset.ephemeral();
    db.replaceAll({
        titles: [
            { tconst: 'tt0903747', kind: 'tvSeries', title: 'Breaking Bad', year: 2008, genres: 'Crime,Drama,Thriller' },
            { tconst: 'tt0068646', kind: 'movie', title: 'The Godfather', year: 1972, runtime: 175, genres: 'Crime,Drama' },
            { tconst: 'tt0111161', kind: 'movie', title: 'The Shawshank Redemption', year: 1994, genres: 'Drama' }
        ],
        ratings: [
            { tconst: 'tt0903747', average: 9.5, votes: 2_200_000 },
            { tconst: 'tt0068646', average: 9.2, votes: 2_000_000 }
        ]
    });
    return db;
};

describe('reading ratings', () => {
    it('returns a rating per tconst asked for', () => {
        expect(seed().ratingsFor(['tt0903747', 'tt0068646'])).toEqual(
            new Map([
                ['tt0903747', 9.5],
                ['tt0068646', 9.2]
            ])
        );
    });

    /**
     * The join's hole, made explicit. A title the dataset holds but has no
     * rating for, and a tconst IMDb has never heard of, are both simply absent
     * from the map — never a zero, which would rank an unknown title below one
     * genuinely rated 1.0.
     */
    it('omits a tconst it has no rating for rather than returning zero', () => {
        expect(seed().ratingsFor(['tt0111161', 'tt9999999']).size).toBe(0);
    });

    it('handles an empty request', () => {
        expect(seed().ratingsFor([])).toEqual(new Map());
    });

    /** A 900-item library exceeds SQLite's variable limit in one IN clause —
     *  and a large library is exactly where this feature earns its keep. */
    it('answers for more tconsts than SQLite allows variables in one statement', () => {
        const store = seed();
        const many = Array.from({ length: 5000 }, (_, i) => `tt${String(i).padStart(7, '0')}`);
        expect(() => store.ratingsFor(many)).not.toThrow();
        expect(store.ratingsFor([...many, 'tt0903747']).get('tt0903747')).toBe(9.5);
    });
});

describe('discovering from the dataset', () => {
    it('filters by kind, genre and minimum rating', () => {
        const hits = seed().discover({ kind: 'movie', genre: 'Crime', minRating: 9, limit: 10 });
        expect(hits.map(h => h.tconst)).toEqual(['tt0068646']);
        expect(hits[0]?.genres).toEqual(['Crime', 'Drama']);
    });

    it('matches genre case-insensitively, as get_library documents', () => {
        expect(seed().discover({ kind: 'movie', genre: 'crime', limit: 10 })).toHaveLength(1);
    });

    /** The commas on both sides are what stop "Drama" matching "Docudrama". */
    it('does not match a genre that merely contains the one asked for', () => {
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: [{ tconst: 'tt1', kind: 'movie', title: 'A Docudrama', genres: 'Docudrama' }],
            ratings: []
        });
        expect(db.discover({ kind: 'movie', genre: 'Drama', limit: 10 })).toHaveLength(0);
    });

    it('pages with an offset, so page two is not page one again', async () => {
        // The limit is applied in SQL, so a caller slicing the returned rows
        // by offset was slicing inside the first page: `offset: 1, limit: 1`
        // came back empty and discover_media could never leave page one.
        //
        // Both films carry a rating because `replaceAll` deletes every title
        // that has none — an unrated title is not in the dataset at all.
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: [
                { tconst: 'tt1', kind: 'movie', title: 'Higher Rated', year: 2001, genres: 'Drama' },
                { tconst: 'tt2', kind: 'movie', title: 'Lower Rated', year: 2002, genres: 'Drama' }
            ],
            ratings: [
                { tconst: 'tt1', average: 9.2, votes: 100 },
                { tconst: 'tt2', average: 8.1, votes: 100 }
            ]
        });

        expect(db.discover({ kind: 'movie', limit: 1 }).map(h => h.title)).toEqual(['Higher Rated']);
        expect(db.discover({ kind: 'movie', limit: 1, offset: 1 }).map(h => h.title)).toEqual(['Lower Rated']);
    });

    /** `series` is the vocabulary the tools use; `tvSeries` is IMDb's. */
    it('maps the tool vocabulary onto IMDb title types', () => {
        expect(seed().discover({ kind: 'series', limit: 10 }).map(h => h.title)).toEqual(['Breaking Bad']);
    });

    it('excludes unrated titles when a minimum rating is asked for', () => {
        const hits = seed().discover({ kind: 'movie', minRating: 1, limit: 10 });
        expect(hits.map(h => h.tconst)).not.toContain('tt0111161');
    });

    /**
      * An unrated title is one nothing here can do anything with — every rating
      * lookup misses it, and it is the overwhelming majority of IMDb's 12.7M
      * rows. Since 1.0.1 they are dropped at ingest rather than stored and
      * skipped, which is most of the difference between a 1.3 GB database and a
      * small one.
      */
    it('does not store an unrated title at all', () => {
        const hits = seed().discover({ kind: 'movie', limit: 10 });
        expect(hits.map(h => h.tconst)).not.toContain('tt0111161');
    });

    /** Nothing can query a tvEpisode or a video game, so nothing stores one. */
    it('does not store a title of a kind no query can reach', () => {
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: [
                { tconst: 'tt1', kind: 'tvEpisode', title: 'An Episode' },
                { tconst: 'tt2', kind: 'movie', title: 'A Film' }
            ],
            ratings: [
                { tconst: 'tt1', average: 9, votes: 10 },
                { tconst: 'tt2', average: 8, votes: 10 }
            ]
        });

        expect(db.status().titles).toBe(1);
        expect(db.discover({ kind: 'movie', limit: 10 }).map(h => h.tconst)).toEqual(['tt2']);
    });

    it('filters by year', () => {
        expect(seed().discover({ kind: 'movie', year: 1972, limit: 10 }).map(h => h.title)).toEqual(['The Godfather']);
    });

    it('honours the limit', () => {
        expect(seed().discover({ kind: 'movie', limit: 1 })).toHaveLength(1);
    });
});

/**
 * Three changes made to get the file down, and the coverage each one must not
 * cost. `rating` held 1.7M rows against `title`'s 546K, so two thirds of it
 * was rows for titles that were filtered out at ingest.
 */
describe('keeping the file small', () => {
    /**
     * The saving. Ratings for titles nothing stores are the bulk of the table
     * — episodes above all, at roughly ten million rows.
     */
    it('drops a rating for a title it did not store', () => {
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: [
                { tconst: 'tt1', kind: 'tvEpisode', title: 'An Episode' },
                { tconst: 'tt2', kind: 'movie', title: 'A Film' }
            ],
            ratings: [
                { tconst: 'tt1', average: 9, votes: 10 },
                { tconst: 'tt2', average: 8, votes: 10 }
            ]
        });

        expect(db.status().ratings).toBe(1);
        expect(db.ratingsFor(['tt1']).size).toBe(0);
    });

    /**
     * The coverage that pruning would otherwise have cost, and the reason
     * `STORED_KINDS` is no longer just `KIND_TO_IMDB` flattened.
     *
     * `ratingsFor` looks up by tconst without joining `title`, so before the
     * prune these were rated purely because the rating table was unfiltered.
     * Delete the orphans without widening what is stored and a direct-to-video
     * film in Radarr, or a stand-up special in Sonarr, silently loses its
     * rating — which reads as "unrated" and is indistinguishable from a title
     * IMDb has never heard of.
     */
    it.each(['video', 'tvSpecial', 'tvShort'])('still rates a %s, which an *arr can manage', kind => {
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: [{ tconst: 'tt9', kind, title: 'Something An Arr Has' }],
            ratings: [{ tconst: 'tt9', average: 7.7, votes: 900 }]
        });

        expect(db.ratingsFor(['tt9']).get('tt9')).toBe(7.7);
    });

    /**
     * Stored is not the same as discoverable, which is the whole point of
     * splitting the two lists. `discover` still offers exactly the vocabulary
     * `get_library` speaks, so widening storage must not start returning
     * direct-to-video results to someone browsing films.
     */
    it('does not offer the extra stored kinds through discover', () => {
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: [
                { tconst: 'tt9', kind: 'video', title: 'Straight To Video' },
                { tconst: 'tt8', kind: 'movie', title: 'A Real Film' }
            ],
            ratings: [
                { tconst: 'tt9', average: 7.7, votes: 900 },
                { tconst: 'tt8', average: 8.1, votes: 900 }
            ]
        });

        expect(db.discover({ kind: 'movie', limit: 10 }).map(h => h.tconst)).toEqual(['tt8']);
    });

});

describe('status', () => {
    it('reports what it holds, for the dashboard', () => {
        const s = seed().status();
        // Two of the three fixture titles carry a rating; the third is dropped.
        expect(s.titles).toBe(2);
        expect(s.ratings).toBe(2);
        expect(s.ingestedAt).toBeDefined();
    });

    /** Enabled but never ingested is a distinct state from absent, and the
     *  dashboard has to be able to say so. */
    it('reports an empty dataset as empty rather than failing', () => {
        db = ImdbDataset.ephemeral();
        expect(db.status()).toMatchObject({ titles: 0, ratings: 0 });
        expect(db.status().ingestedAt).toBeUndefined();
    });
});

describe('replacing the dataset', () => {
    /** The dumps are full daily snapshots. A merge would accumulate titles
     *  IMDb has since withdrawn. */
    it('replaces rather than merges', () => {
        const store = seed();
        store.replaceAll({
            titles: [{ tconst: 'tt5', kind: 'movie', title: 'Only This' }],
            ratings: [{ tconst: 'tt5', average: 7, votes: 5 }]
        });

        expect(store.status().titles).toBe(1);
        expect(store.ratingsFor(['tt0903747']).size).toBe(0);
    });

    /** The failure this exists to prevent: a truncated download replacing a
     *  good dataset with a partial one, degrading answers silently. */
    it('leaves the previous dataset intact when the rows throw mid-stream', () => {
        const store = seed();

        function* explodes(): Generator<never> {
            yield* [];
            throw new Error('connection reset');
        }

        expect(() => store.replaceAll({ titles: explodes(), ratings: [] })).toThrow('connection reset');
        expect(store.status().titles).toBe(2);
        expect(store.ratingsFor(['tt0903747']).get('tt0903747')).toBe(9.5);
    });
});

/**
 * The genre goes into a LIKE pattern, so an unescaped `%` or `_` made a filter
 * that could not fail to match. Local read-only data, so this is a correctness
 * wrinkle rather than an injection — but a filter that matches everything is
 * worse than one that matches nothing.
 */
describe('discover schema', () => {
    it('buckets discoverable kinds and leaves the rest null', () => {
        const ds = ImdbDataset.ephemeral();
        ds.replaceAll({
            titles: [
                { tconst: 'tt1', kind: 'movie', title: 'A' },
                { tconst: 'tt2', kind: 'tvMovie', title: 'B' },
                { tconst: 'tt3', kind: 'tvSeries', title: 'C' },
                { tconst: 'tt4', kind: 'tvMiniSeries', title: 'D' },
                { tconst: 'tt5', kind: 'short', title: 'E' },
                { tconst: 'tt6', kind: 'video', title: 'F' }
            ],
            ratings: [
                { tconst: 'tt1', average: 8, votes: 10 },
                { tconst: 'tt2', average: 7, votes: 10 },
                { tconst: 'tt3', average: 6, votes: 10 },
                { tconst: 'tt4', average: 5, votes: 10 },
                { tconst: 'tt5', average: 4, votes: 10 },
                { tconst: 'tt6', average: 3, votes: 10 }
            ]
        });

        // Reaching into the database directly: this is the storage invariant
        // the index depends on, and no public method exposes it.
        const rows = ds.debugRows();
        expect(new Map(rows.map(r => [r.tconst, r.bucket]))).toEqual(
            new Map([
                ['tt1', 'movie'],
                ['tt2', 'movie'],
                ['tt3', 'series'],
                ['tt4', 'series'],
                ['tt5', null],
                ['tt6', null]
            ])
        );
        ds.close();
    });

    it('answers a kind-only discover without a temp b-tree', () => {
        const ds = ImdbDataset.ephemeral();
        ds.replaceAll({
            titles: [{ tconst: 'tt1', kind: 'movie', title: 'A', year: 2001 }],
            ratings: [{ tconst: 'tt1', average: 8, votes: 10 }]
        });

        // The one test that guards what this change actually buys. Brittle on
        // purpose: a future CASE or IN in the ORDER BY gives the index back.
        const plan = ds.explainDiscover({ kind: 'movie' });
        expect(plan.join('\n')).not.toContain('TEMP B-TREE');
        expect(plan.join('\n')).toContain('title_bucket_rating');
        ds.close();
    });
});

describe('discover ordering', () => {
    const seeded = () => {
        const ds = ImdbDataset.ephemeral();
        ds.replaceAll({
            titles: [
                { tconst: 'tt1', kind: 'movie', title: 'Best', year: 1999, genres: 'Crime,Drama' },
                { tconst: 'tt2', kind: 'movie', title: 'Mid', year: 2005, genres: 'Drama' },
                { tconst: 'tt3', kind: 'movie', title: 'Tie older', year: 1990, genres: 'Crime' },
                { tconst: 'tt4', kind: 'movie', title: 'Tie newer', year: 2010, genres: 'Crime' },
                { tconst: 'tt5', kind: 'tvSeries', title: 'A series', year: 2000, genres: 'Drama' }
            ],
            ratings: [
                { tconst: 'tt1', average: 9.1, votes: 100 },
                { tconst: 'tt2', average: 6.4, votes: 100 },
                { tconst: 'tt3', average: 7.5, votes: 100 },
                { tconst: 'tt4', average: 7.5, votes: 100 },
                { tconst: 'tt5', average: 8.8, votes: 100 }
            ]
        });
        return ds;
    };

    it('orders by rating, then by year descending', () => {
        const ds = seeded();
        expect(ds.discover({ kind: 'movie', limit: 10 }).map(t => t.tconst)).toEqual([
            'tt1',
            'tt4',
            'tt3',
            'tt2'
        ]);
        ds.close();
    });

    it('keeps series out of a movie browse', () => {
        const ds = seeded();
        expect(ds.discover({ kind: 'movie', limit: 10 }).map(t => t.tconst)).not.toContain('tt5');
        ds.close();
    });

    it('counts what it pages through', () => {
        const ds = seeded();
        expect(ds.countDiscover({ kind: 'movie' })).toBe(4);
        expect(ds.countDiscover({ kind: 'movie', genre: 'Crime' })).toBe(3);
        ds.close();
    });

    it('pages without repeating or skipping', () => {
        const ds = seeded();
        const page1 = ds.discover({ kind: 'movie', limit: 2, offset: 0 }).map(t => t.tconst);
        const page2 = ds.discover({ kind: 'movie', limit: 2, offset: 2 }).map(t => t.tconst);
        expect([...page1, ...page2]).toEqual(['tt1', 'tt4', 'tt3', 'tt2']);
        ds.close();
    });

    it('still applies a rating floor', () => {
        const ds = seeded();
        expect(ds.discover({ kind: 'movie', minRating: 7.5, limit: 10 }).map(t => t.tconst)).toEqual([
            'tt1',
            'tt4',
            'tt3'
        ]);
        ds.close();
    });

    it('carries the rating and votes onto every result', () => {
        const ds = seeded();
        const [top] = ds.discover({ kind: 'movie', limit: 1 });
        expect(top?.rating).toBe(9.1);
        expect(top?.votes).toBe(100);
        ds.close();
    });
});

describe('genre wildcards', () => {
    it('does not let a wildcard genre match everything', () => {
        const db = seed();
        expect(db.discover({ kind: 'movie', limit: 50 }).length).toBeGreaterThan(0); // the premise
        expect(db.discover({ kind: 'movie', genre: '%', limit: 50 })).toHaveLength(0);
    });

    it('does not let a single-character wildcard match a real genre', () => {
        expect(seed().discover({ kind: 'movie', genre: 'dram_', limit: 50 })).toHaveLength(0);
    });

    it('still matches a real genre exactly', () => {
        expect(seed().discover({ kind: 'movie', genre: 'Drama', limit: 50 }).length).toBeGreaterThan(0);
    });
});
