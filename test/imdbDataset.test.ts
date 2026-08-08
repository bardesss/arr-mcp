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
        ],
        episodes: [{ tconst: 'tt2081647', parent: 'tt0903747', season: 1, episode: 1 }]
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
            ratings: [],
            episodes: []
        });
        expect(db.discover({ kind: 'movie', genre: 'Drama', limit: 10 })).toHaveLength(0);
    });

    /** `series` is the vocabulary the tools use; `tvSeries` is IMDb's. */
    it('maps the tool vocabulary onto IMDb title types', () => {
        expect(seed().discover({ kind: 'series', limit: 10 }).map(h => h.title)).toEqual(['Breaking Bad']);
    });

    it('excludes unrated titles when a minimum rating is asked for', () => {
        const hits = seed().discover({ kind: 'movie', minRating: 1, limit: 10 });
        expect(hits.map(h => h.tconst)).not.toContain('tt0111161');
    });

    it('includes unrated titles when no minimum is asked for', () => {
        const hits = seed().discover({ kind: 'movie', limit: 10 });
        expect(hits.map(h => h.tconst)).toContain('tt0111161');
    });

    it('filters by year', () => {
        expect(seed().discover({ kind: 'movie', year: 1972, limit: 10 }).map(h => h.title)).toEqual(['The Godfather']);
    });

    it('honours the limit', () => {
        expect(seed().discover({ kind: 'movie', limit: 1 })).toHaveLength(1);
    });
});

describe('status', () => {
    it('reports what it holds, for the dashboard', () => {
        const s = seed().status();
        expect(s.titles).toBe(3);
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
            ratings: [],
            episodes: []
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

        expect(() => store.replaceAll({ titles: explodes(), ratings: [], episodes: [] })).toThrow('connection reset');
        expect(store.status().titles).toBe(3);
        expect(store.ratingsFor(['tt0903747']).get('tt0903747')).toBe(9.5);
    });
});
