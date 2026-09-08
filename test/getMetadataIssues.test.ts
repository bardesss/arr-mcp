import { describe, expect, it } from 'vitest';
import type { EpisodeRecord, MovieRecord } from '../src/core/episodeMismatch.ts';
import type { IdentityResolver } from '../src/core/identity.ts';
import { buildGetMetadataIssues } from '../src/tools/getMetadataIssues.ts';
import type { ServiceAdapter } from '../src/services/types.ts';

/**
 * The discovery half is only worth having if a sweep of a library that is
 * mostly fine stays quiet, so most of what is asserted here is silence.
 */

const identity = { resolve: async () => ({ id: 'u1', name: 'Sam' }) } as unknown as IdentityResolver;

const healthy = (n: number): EpisodeRecord => ({
    id: `h${n}`,
    name: `Real Episode Title ${n}`,
    season: 1,
    episode: n,
    path: `/tv/Some Show/Season 01/Some Show - S01E0${n} - Real Episode Title ${n}.mkv`
});

/** Server never matched it: no ids, and the title is the series name. */
const unmatched = (n: number): EpisodeRecord => ({
    id: `u${n}`,
    name: 'Some Show',
    season: 1,
    episode: n,
    path: `/tv/Some Show/Season 01/Some Show - S01E0${n} - Missouri Mutual Life.mkv`
});

/** Server matched it and is right; the filename is the outlier. */
const misnamed = (n: number): EpisodeRecord => ({
    id: `p${n}`,
    name: 'My Life Had Stood a Loaded Gun',
    season: 1,
    episode: n,
    path: `/tv/Some Show/Season 01/Some Show - S01E0${n} - Flash Flood.mkv`,
    providerIds: { Tvdb: '11732470' }
});

const wrongNumbers = (n: number): EpisodeRecord => ({
    id: `n${n}`,
    name: 'Prologue to Battle! The Return of Goku!',
    season: 1,
    episode: 1,
    path: `/tv/Kai/Specials/Episode 10${n} Videls Crisis Gohans Urgent Callout.mkv`,
    providerIds: { Tvdb: '507731' }
});

function adapterWith(
    series: Record<string, EpisodeRecord[]>,
    failing: string[] = [],
    movies: MovieRecord[] = []
): ServiceAdapter {
    return {
        id: 'jellyfin',
        type: 'jellyfin',
        listUsers: async () => [{ id: 'u1', name: 'Sam' }],
        listUserLibrary: async () =>
            Object.keys(series).map(title => ({
                kind: 'series' as const,
                title,
                ids: {},
                playback: { user: 'Sam', itemId: `item-${title}` }
            })),
        readMovieMetadata: async () => movies,
        readEpisodeMetadata: async (_u: unknown, itemId: string) => {
            const title = itemId.replace(/^item-/, '');
            if (failing.includes(title)) throw new Error('boom');
            return series[title] ?? [];
        },
        getPlayback: async () => [],
        getNextUp: async () => [],
        getWatchHistory: async () => []
    } as unknown as ServiceAdapter;
}

const sweep = (adapter: ServiceAdapter) =>
    buildGetMetadataIssues([adapter], identity, { detail: 'full', limit: 50, offset: 0 });

describe('get_metadata_issues', () => {
    it('says nothing about a library whose files all agree', async () => {
        const result = await sweep(adapterWith({ Fine: [healthy(1), healthy(2)] }));

        expect(result.items).toEqual([]);
        expect(result.total).toBe(0);
        // The denominator matters: "0 problems" and "0 series looked at" read
        // identically without it.
        expect(result.itemsScanned).toBe(1);
    });

    it('sends an unmatched title mismatch to a metadata refresh', async () => {
        const result = await sweep(adapterWith({ DTF: [healthy(1), unmatched(4)] }));

        expect(result.items[0]).toMatchObject({ remedy: 'refresh_metadata', mismatches: 1, pinned: 0 });
        expect(result.items[0]?.fix).toContain('fix_metadata');
    });

    it('sends a matched title mismatch to a rename instead', async () => {
        const result = await sweep(adapterWith({ Furious: [healthy(1), misnamed(2)] }));

        expect(result.items[0]).toMatchObject({ remedy: 'rename_files', titleOnly: 1, pinned: 1 });
        expect(result.items[0]?.fix).toContain('rename');
    });

    it('ranks numbering findings above title ones', async () => {
        const result = await sweep(
            adapterWith({
                Titles: [misnamed(2), misnamed(3)],
                Numbers: [wrongNumbers(1)]
            })
        );

        expect(result.items.map(i => i.title)).toEqual(['Numbers', 'Titles']);
    });

    it('carries the item id fix_metadata acts on', async () => {
        const result = await sweep(adapterWith({ DTF: [unmatched(4)] }));
        expect(result.items[0]?.itemId).toBe('item-DTF');
    });

    /** One unreadable series must not turn a useful sweep into an error. */
    it('keeps going past a series it cannot read, and names the service', async () => {
        const result = await sweep(adapterWith({ Fine: [healthy(1)], Broken: [healthy(1)], DTF: [unmatched(4)] }, ['Broken']));

        expect(result.total).toBe(1);
        expect(result.itemsScanned).toBe(2);
        expect(result.degraded).toEqual(['jellyfin']);
    });

    it('drops the detail but never the answer at minimal', async () => {
        const result = await buildGetMetadataIssues([adapterWith({ DTF: [unmatched(4)] })], identity, {
            detail: 'minimal',
            limit: 50,
            offset: 0
        });

        const [row] = result.items;
        expect(row?.remedy).toBe('refresh_metadata');
        expect(row?.mismatches).toBe(1);
        expect(row?.examples).toBeUndefined();
        expect(row?.pinned).toBeUndefined();
    });

    it('fences the examples, which are server-supplied paths and titles', async () => {
        const result = await sweep(adapterWith({ DTF: [unmatched(4)] }));
        expect(result.items[0]?.examples?.[0]).toContain('<<untrusted:');
    });

    /** No media server is a configuration, not a failure — `degraded` is for
     *  things that were asked and did not answer. */
    it('answers empty rather than degraded when nothing can be swept', async () => {
        const result = await buildGetMetadataIssues([], undefined, { detail: 'full', limit: 50, offset: 0 });

        expect(result.items).toEqual([]);
        expect(result.degraded).toEqual([]);
        expect(result.itemsScanned).toBe(0);
    });
});

/**
 * Films have no episode numbering, so the year does that job. It is the more
 * reliable half of a film filename by some distance: a film names its year
 * almost universally and its release tags inconsistently.
 */
describe('films', () => {
    const film = (over: Partial<MovieRecord> & Pick<MovieRecord, 'id'>): MovieRecord => ({ name: '', ...over });

    const rightFilm = film({
        id: 'ok',
        name: 'Blade Runner 2049',
        year: 2017,
        path: '/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) [Bluray-2160p].mkv'
    });

    it('says nothing about a film whose file agrees with it', async () => {
        const result = await sweep(adapterWith({}, [], [rightFilm]));
        expect(result.items).toEqual([]);
        expect(result.itemsScanned).toBe(1);
    });

    it('flags a film whose file names a different year', async () => {
        const wrong = film({
            id: 'y',
            name: 'The Thing',
            year: 2011,
            path: '/movies/The Thing (1982)/The Thing (1982) [Bluray-1080p].mkv'
        });
        const [row] = (await sweep(adapterWith({}, [], [wrong]))).items;

        expect(row).toMatchObject({ kind: 'movie', numbering: 1, remedy: 'rename_files' });
        expect(row?.examples?.[0]).toContain('2011');
    });

    /** A year that disagrees means the server matched a different film, so it
     *  outranks any number of title-only findings. */
    it('ranks a film year finding above title findings', async () => {
        const wrongYear = film({ id: 'y', name: 'The Thing', year: 2011, path: '/movies/The Thing (1982)/The Thing (1982).mkv' });
        const result = await sweep(
            adapterWith({ Titles: [misnamed(2), misnamed(3)] }, [], [wrongYear])
        );

        expect(result.items[0]?.title).toBe('The Thing');
    });

    it('sends an unmatched film to a metadata refresh', async () => {
        const unmatchedFilm = film({
            id: 'u',
            name: 'Some Folder Name',
            year: 1999,
            path: '/movies/The Matrix Reloaded (1999)/The Matrix Reloaded (1999) [Bluray-1080p].mkv'
        });
        const [row] = (await sweep(adapterWith({}, [], [unmatchedFilm]))).items;

        expect(row).toMatchObject({ kind: 'movie', remedy: 'refresh_metadata', pinned: 0 });
    });

    /** Precision guard: no year in the filename means no reliable boundary
     *  between the title and the release tags, so no claim at all. */
    it('says nothing about a film whose filename carries no year', async () => {
        const noYear = film({ id: 'n', name: 'Completely Different Words', path: '/movies/Some Movie [Bluray-1080p].mkv' });
        expect((await sweep(adapterWith({}, [], [noYear]))).items).toEqual([]);
    });

    it('keeps sweeping series when the film read fails', async () => {
        const adapter = adapterWith({ DTF: [unmatched(4)] });
        (adapter as unknown as { readMovieMetadata: () => Promise<never> }).readMovieMetadata = async () => {
            throw new Error('films unavailable');
        };
        const result = await sweep(adapter);

        expect(result.total).toBe(1);
        expect(result.degraded).toEqual(['jellyfin']);
    });
});
