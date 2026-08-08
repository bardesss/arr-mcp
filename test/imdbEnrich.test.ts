import { afterEach, describe, expect, it } from 'vitest';
import type { IndexInput, MergedItem } from '../src/core/resolver.ts';
import { enrichWithImdb } from '../src/metadata/enrich.ts';
import { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import type { ServiceAdapter, SearchHit } from '../src/services/types.ts';
import { LibraryLoader } from '../src/tools/library.ts';

let db: ImdbDataset;
afterEach(() => db?.close());

const dataset = (): ImdbDataset => {
    db = ImdbDataset.ephemeral();
    db.replaceAll({
        titles: [{ tconst: 'tt0903747', kind: 'tvSeries', title: 'Breaking Bad' }],
        ratings: [{ tconst: 'tt0903747', average: 9.5, votes: 2_200_000 }],
        episodes: []
    });
    return db;
};

const series = (ids: MergedItem['ids'], ratings?: MergedItem['ratings']): MergedItem => ({
    kind: 'series',
    title: 'Breaking Bad',
    ids,
    presence: 'both',
    ...(ratings === undefined ? {} : { ratings })
});

const hit = (ids: SearchHit['ids']): SearchHit => ({
    service: 'sonarr',
    source: 'discover',
    kind: 'series',
    id: '1',
    title: 'Breaking Bad',
    ids
});

describe('enriching merged library items', () => {
    /**
     * The whole point of the phase. Radarr returns a per-source ratings map,
     * but Sonarr returns one flat value that flattenSeriesRating can only
     * honestly record as tvdb — so `MergedRatings.imdb` was unreachable for a
     * series by every path there was.
     */
    it('gives a series an IMDb rating, which no service in the stack can supply', () => {
        const [item] = enrichWithImdb([series({ imdb: 'tt0903747' })], dataset());
        expect(item?.ratings?.imdb).toBe(9.5);
    });

    /** A service is the authority on its own data. */
    it('never overwrites a rating a service already supplied', () => {
        const [item] = enrichWithImdb([series({ imdb: 'tt0903747' }, { imdb: 7.1 })], dataset());
        expect(item?.ratings?.imdb).toBe(7.1);
    });

    it('leaves other sources alone', () => {
        const [item] = enrichWithImdb([series({ imdb: 'tt0903747' }, { tvdb: 8.8 })], dataset());
        expect(item?.ratings).toEqual({ tvdb: 8.8, imdb: 9.5 });
    });

    /** Spec §5's hole: Radarr leads with tmdbId, and the dataset holds no
     *  tmdb→imdb mapping, so some items can never be joined. */
    it('leaves an item with no IMDb id untouched', () => {
        const [item] = enrichWithImdb([series({ tmdb: 1396 })], dataset());
        expect(item?.ratings).toBeUndefined();
    });

    it('leaves an item the dataset has never heard of untouched', () => {
        const [item] = enrichWithImdb([series({ imdb: 'tt9999999' })], dataset());
        expect(item?.ratings).toBeUndefined();
    });

    it('is a no-op when no dataset is configured', () => {
        const input = [series({ imdb: 'tt0903747' })];
        expect(enrichWithImdb(input, undefined)).toBe(input);
    });

    it('does not mutate what it was given', () => {
        const input = series({ imdb: 'tt0903747' });
        enrichWithImdb([input], dataset());
        expect(input.ratings).toBeUndefined();
    });
});

/**
 * The same function, over a different shape. `SearchHit.ratings` is a
 * `Record<string, number>` where `MergedItem.ratings` is `MergedRatings`, and
 * both satisfy the structural constraint without either being widened.
 */
describe('enriching search hits', () => {
    /** The path that matters most: a rating is usually wanted for something
     *  you have not got, which is lookup_media rather than get_library. */
    it('rates a hit for something not in the library at all', () => {
        const [rated] = enrichWithImdb([hit({ imdb: 'tt0903747' })], dataset());
        expect(rated?.ratings?.imdb).toBe(9.5);
    });

    it('leaves a hit with only a tmdb id untouched', () => {
        const [rated] = enrichWithImdb([hit({ tmdb: 1396 })], dataset());
        expect(rated?.ratings).toBeUndefined();
    });

    it('is a no-op when no dataset is configured', () => {
        const input = [hit({ imdb: 'tt0903747' })];
        expect(enrichWithImdb(input, undefined)).toBe(input);
    });
});

/**
 * The wiring, end to end. The unit tests above prove the function; this
 * proves it is actually reached — enrichment lives in `LibraryLoader` so
 * `get_library`, `get_media_details` and `diagnose` cannot disagree about a
 * rating, and that only holds if the loader really applies it.
 */
describe('through the library loader', () => {
    const sonarrStub = (items: IndexInput[]): ServiceAdapter =>
        ({
            id: 'sonarr',
            testConnection: async () => ({ ok: true, service: 'sonarr', latency_ms: 1 }),
            getVersion: async () => '4.0.0',
            listLibrary: async () => items
        }) as unknown as ServiceAdapter;

    const breakingBad: IndexInput = {
        kind: 'series',
        title: 'Breaking Bad',
        ids: { tvdb: 81189, imdb: 'tt0903747' },
        acquisition: { service: 'sonarr', monitored: true, hasFile: true }
    };

    it('rates a series that Sonarr could only ever report a TVDB number for', async () => {
        const loader = new LibraryLoader([sonarrStub([breakingBad])], undefined, undefined, dataset());
        const { index } = await loader.load();

        expect(index.all()[0]?.ratings?.imdb).toBe(9.5);
    });

    it('leaves the library exactly as it was when no dataset is configured', async () => {
        const loader = new LibraryLoader([sonarrStub([breakingBad])], undefined);
        const { index } = await loader.load();

        expect(index.all()[0]?.ratings).toBeUndefined();
    });
});
