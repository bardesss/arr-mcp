import { afterEach, describe, expect, it } from 'vitest';
import { LibraryIndex, type IndexInput } from '../src/core/resolver.ts';
import type { IdentityResolver } from '../src/core/identity.ts';
import { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import { buildGetLibrary } from '../src/tools/getLibrary.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { repeat } from './helpers/bigFixture.ts';
import { expectWithinBudget } from './helpers/budget.ts';

const stub = (id: 'radarr' | 'sonarr', items: IndexInput[]): ServiceAdapter =>
    ({
        id,
        testConnection: async () => ({ ok: true, service: id, latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        listLibrary: async () => items
    }) as unknown as ServiceAdapter;

/**
 * A healthy, empty Jellyfin contributor — present so these fixtures' *arr
 * items are genuinely `arr_only` (Jellyfin answered and does not have them),
 * not merely `unknown` because Jellyfin was never configured (item 1 of the
 * whole-phase review: `LibraryIndex` must not report `arr_only` across a
 * Jellyfin half it never gathered, and "never configured" is one way that
 * happens). Most filters in this file do not care either way, but the ones
 * that assert `presence` directly would otherwise pass for the wrong reason.
 */
const jellyfinStub = (): ServiceAdapter =>
    ({
        id: 'jellyfin',
        testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 }),
        getVersion: async () => '10.0.0',
        listUserLibrary: async () => []
    }) as unknown as ServiceAdapter;

const healthyJellyfinIdentity = { resolve: async () => ({ id: 'u1', name: 'Someone' }) } as unknown as IdentityResolver;

const loaderOf = (items: IndexInput[], id: 'radarr' | 'sonarr' = 'radarr') =>
    new LibraryLoader([stub(id, items), jellyfinStub()], healthyJellyfinIdentity);

const film = (over: Partial<IndexInput> = {}): IndexInput => ({
    kind: 'movie',
    title: 'Some Film',
    year: 2026,
    genres: ['Drama'],
    ids: { tmdb: 550 },
    acquisition: { service: 'radarr', monitored: true, hasFile: true, quality: 'Bluray-1080p' },
    ...over
});

const base = { detail: 'standard' as const, limit: 50 };

describe('get_library filters', () => {
    it('returns everything when nothing is filtered', async () => {
        const result = await buildGetLibrary(loaderOf([film(), film({ ids: { tmdb: 2 } })]), base);
        expect(result).toMatchObject({ total: 2, returned: 2, truncated: false });
    });

    it('filters by kind', async () => {
        const items = [film(), film({ kind: 'series', ids: { tvdb: 9 } })];
        const result = await buildGetLibrary(loaderOf(items), { ...base, kind: 'series' });
        expect(result.items.map(i => i.kind)).toEqual(['series']);
    });

    it('filters by year', async () => {
        const items = [film(), film({ year: 1999, ids: { tmdb: 2 } })];
        expect((await buildGetLibrary(loaderOf(items), { ...base, year: 1999 })).total).toBe(1);
    });

    it('filters by genre, case-insensitively', async () => {
        const items = [film(), film({ genres: ['Comedy'], ids: { tmdb: 2 } })];
        expect((await buildGetLibrary(loaderOf(items), { ...base, genre: 'comedy' })).total).toBe(1);
    });

    it('filters by monitored', async () => {
        const items = [
            film(),
            film({ ids: { tmdb: 2 }, acquisition: { service: 'radarr', monitored: false, hasFile: true } })
        ];
        expect((await buildGetLibrary(loaderOf(items), { ...base, monitored: false })).total).toBe(1);
    });

    it('filters by presence, the question no single service can answer', async () => {
        const items = [film(), { ...film({ ids: { tmdb: 2 } }), playback: { user: 'Someone', watched: true } }];
        const result = await buildGetLibrary(loaderOf(items), { ...base, presence: 'arr_only' });
        // Not just `.every()`, which an empty result would also satisfy —
        // this pins that the filter actually kept the one arr_only item.
        expect(result.total).toBe(1);
        expect(result.items.every(i => i.presence === 'arr_only')).toBe(true);
    });

    it('filters by watched', async () => {
        const items = [
            { ...film(), playback: { user: 'Someone', watched: true } },
            { ...film({ ids: { tmdb: 2 } }), playback: { user: 'Someone', watched: false } }
        ];
        expect((await buildGetLibrary(loaderOf(items), { ...base, watched: true })).total).toBe(1);
    });

    it('treats an item with no playback half as not watched', async () => {
        // Absent watch state is not evidence of watching, and `watched: false`
        // must not silently exclude everything Jellyfin has never seen.
        expect((await buildGetLibrary(loaderOf([film()]), { ...base, watched: false })).total).toBe(1);
    });

    it('filters films by quality', async () => {
        const items = [
            film(),
            film({ ids: { tmdb: 2 }, acquisition: { service: 'radarr', monitored: true, hasFile: true, quality: 'WEBDL-720p' } })
        ];
        const result = await buildGetLibrary(loaderOf(items), { ...base, quality: 'bluray-1080p' });
        expect(result.total).toBe(1);
    });

    it('excludes series from a quality filter rather than matching none of them', async () => {
        const items = [film(), film({ kind: 'series', ids: { tvdb: 9 } })];
        const result = await buildGetLibrary(loaderOf(items), { ...base, quality: 'bluray-1080p' });
        expect(result.items.every(i => i.kind === 'movie')).toBe(true);
    });

    it('refuses a quality filter explicitly scoped to series', async () => {
        // §5.2: a documented gap beats a filter that quietly matches nothing.
        await expect(
            buildGetLibrary(loaderOf([film()]), { ...base, kind: 'series', quality: 'bluray-1080p' })
        ).rejects.toThrow(/per-episode/);
    });

    it('combines filters', async () => {
        const items = [film(), film({ year: 1999, ids: { tmdb: 2 } })];
        const result = await buildGetLibrary(loaderOf(items), { ...base, kind: 'movie', year: 2026, genre: 'Drama' });
        expect(result.total).toBe(1);
    });
});

describe('get_library rating filtering', () => {
    const rated = [
        film({ ids: { tmdb: 1 }, ratings: { imdb: 9.1 } }),
        film({ ids: { tmdb: 2 }, ratings: { imdb: 6.0 } }),
        film({ ids: { tmdb: 3 } })
    ];
    // The third film has no `ratings` key at all — 26% of a real library.

    it('filters on the named source', async () => {
        const result = await buildGetLibrary(loaderOf(rated), { ...base, min_rating: 8, rating_source: 'imdb' });
        expect(result.total).toBe(1);
    });

    it('reports coverage, so an unrated film is not silently a no', async () => {
        const result = await buildGetLibrary(loaderOf(rated), { ...base, min_rating: 8, rating_source: 'imdb' });
        expect(result.ratingCoverage).toEqual({ source: 'imdb', rated: 2, unrated: 1 });
    });

    it('picks the best-covered source when none is named', async () => {
        const items = [
            film({ ids: { tmdb: 1 }, ratings: { imdb: 9.1, metacritic: 90 } }),
            film({ ids: { tmdb: 2 }, ratings: { imdb: 8.5 } })
        ];
        const result = await buildGetLibrary(loaderOf(items), { ...base, min_rating: 8 });
        expect(result.ratingCoverage).toMatchObject({ source: 'imdb', rated: 2, unrated: 0 });
    });

    it('measures coverage over the filtered set, not the whole library', async () => {
        const items = [...rated, film({ year: 1999, ids: { tmdb: 4 } })];
        const result = await buildGetLibrary(loaderOf(items), {
            ...base,
            year: 2026,
            min_rating: 8,
            rating_source: 'imdb'
        });
        expect(result.ratingCoverage).toEqual({ source: 'imdb', rated: 2, unrated: 1 });
    });

    it('omits coverage when no rating filter was asked for', async () => {
        expect((await buildGetLibrary(loaderOf(rated), base)).ratingCoverage).toBeUndefined();
    });

    /**
     * Was: *any* per-source filter on a series was refused, because §21.2's
     * flat TVDB value was the only rating one could carry. 0.8's IMDb dataset
     * makes `imdb` reachable for a series, so the refusal narrowed to the
     * sources that still have no path to one. The reason it exists is
     * unchanged — an empty list would read as "no such series exist".
     */
    it('refuses a per-source rating filter a series still cannot have', async () => {
        await expect(
            buildGetLibrary(loaderOf([film()]), {
                ...base,
                kind: 'series',
                min_rating: 8,
                rating_source: 'rottenTomatoes'
            })
        ).rejects.toThrow(/applies to films only/);
    });

    it('allows a tvdb-sourced rating filter on series', async () => {
        const items = [
            film({ kind: 'series', ids: { tvdb: 1 }, ratings: { tvdb: 8.3 } }),
            film({ kind: 'series', ids: { tvdb: 2 }, ratings: { tvdb: 6.1 } })
        ];
        const result = await buildGetLibrary(loaderOf(items, 'sonarr'), {
            ...base,
            kind: 'series',
            min_rating: 8,
            rating_source: 'tvdb'
        });
        expect(result.total).toBe(1);
    });
});

describe('get_library rating filtering — cross-source scale', () => {
    // `min_rating` is documented 0-10 for every source, but Radarr/Sonarr pass
    // Rotten Tomatoes and Metacritic through on their site's native 0-100
    // scale — nothing upstream rescales them. A raw comparison against a 0-10
    // threshold makes "rated at all" read as "rated 8+" for those two sources:
    // a real library measured 136 of 136 metacritic-rated films and 121 of 121
    // rottenTomatoes-rated films "passing" an 8+ filter.
    it('fails a metacritic film below min_rating once rescaled off its 0-100 scale (64 -> 6.4)', async () => {
        const items = [film({ ids: { tmdb: 1 }, ratings: { metacritic: 64 } })];
        const result = await buildGetLibrary(loaderOf(items), { ...base, min_rating: 8, rating_source: 'metacritic' });
        expect(result.total).toBe(0);
    });

    it('passes a metacritic film at/above min_rating once rescaled (95 -> 9.5)', async () => {
        const items = [film({ ids: { tmdb: 1 }, ratings: { metacritic: 95 } })];
        const result = await buildGetLibrary(loaderOf(items), { ...base, min_rating: 8, rating_source: 'metacritic' });
        expect(result.total).toBe(1);
    });

    it('rescales rottenTomatoes the same way, and keeps the native-scale value in the response', async () => {
        const items = [
            film({ ids: { tmdb: 1 }, ratings: { rottenTomatoes: 82 } }), // 8.2, passes
            film({ ids: { tmdb: 2 }, ratings: { rottenTomatoes: 64 } }) // 6.4, fails
        ];
        const result = await buildGetLibrary(loaderOf(items), {
            ...base,
            min_rating: 8,
            rating_source: 'rottenTomatoes'
        });
        expect(result.total).toBe(1);
        // The stored/returned value stays on Rotten Tomatoes' own 0-100 scale —
        // rescaling is for the comparison only, not the reported number.
        expect(result.items[0]?.ratings?.rottenTomatoes).toBe(82);
    });

    it('leaves an imdb comparison unchanged — it was already 0-10', async () => {
        const items = [
            film({ ids: { tmdb: 1 }, ratings: { imdb: 8.5 } }),
            film({ ids: { tmdb: 2 }, ratings: { imdb: 7.9 } })
        ];
        const result = await buildGetLibrary(loaderOf(items), { ...base, min_rating: 8, rating_source: 'imdb' });
        expect(result.total).toBe(1);
    });

    it('does not change rated/unrated coverage counts — coverage is presence, not magnitude', async () => {
        const items = [
            film({ ids: { tmdb: 1 }, ratings: { metacritic: 64 } }),
            film({ ids: { tmdb: 2 }, ratings: { metacritic: 95 } }),
            film({ ids: { tmdb: 3 } })
        ];
        const result = await buildGetLibrary(loaderOf(items), { ...base, min_rating: 8, rating_source: 'metacritic' });
        expect(result.ratingCoverage).toEqual({ source: 'metacritic', rated: 2, unrated: 1 });
    });
});

describe('get_library shaping', () => {
    it('truncates honestly', async () => {
        const many = repeat(film(), 120).map((f, i) => ({ ...f, ids: { tmdb: i + 1 } }));
        const result = await buildGetLibrary(loaderOf(many), { ...base, limit: 50 });
        expect(result).toMatchObject({ total: 120, returned: 50, truncated: true });
    });

    it('drops ratings and genres at detail: minimal', async () => {
        const result = await buildGetLibrary(loaderOf([film()]), { ...base, detail: 'minimal' });
        expect(result.items[0]?.ratings).toBeUndefined();
        expect(result.items[0]?.genres).toBeUndefined();
        expect(result.items[0]?.presence).toBe('arr_only');
    });

    it('keeps presence at every detail level, because it is the point of the tool', async () => {
        for (const detail of ['minimal', 'standard', 'full'] as const) {
            const result = await buildGetLibrary(loaderOf([film()]), { ...base, detail });
            expect(result.items[0]?.presence).toBe('arr_only');
        }
    });

    it('asks the loader for the named user, so watched_by reaches the cache key', async () => {
        // §10 wants per-user isolation proved at this level too: the loader
        // keys its cache on the resolved user, and a tool that never passes
        // `watched_by` down would silently answer for the default user.
        const asked: (string | undefined)[] = [];
        const loader = {
            load: async (user?: string) => {
                asked.push(user);
                return { index: LibraryIndex.build([]), degraded: [], counts: {} };
            }
        } as unknown as LibraryLoader;

        await buildGetLibrary(loader, { ...base, watched: true, watched_by: 'Other' });
        expect(asked).toEqual(['Other']);
    });

    it('carries the loader\'s note through to the result, not just the snapshot', async () => {
        // LibrarySnapshot.note is how the jellyfin-with-no-default_user case
        // (LibraryLoader#build) reaches a caller — worth nothing if it dies
        // at the snapshot and never reaches get_library's own result shape.
        const loader = {
            load: async () => ({
                index: LibraryIndex.build([]),
                degraded: ['jellyfin'],
                counts: {},
                note: 'Jellyfin is configured without a default_user, so watch state is not included.'
            })
        } as unknown as LibraryLoader;

        const result = await buildGetLibrary(loader, base);
        expect(result.note).toContain('default_user');
    });

    it('reports degraded services', async () => {
        const broken = {
            id: 'sonarr',
            testConnection: async () => ({ ok: true, service: 'sonarr', latency_ms: 1 }),
            getVersion: async () => '1.0.0',
            listLibrary: async () => {
                throw new Error('down');
            }
        } as unknown as ServiceAdapter;

        const loader = new LibraryLoader([stub('radarr', [film()]), broken], undefined);
        expect((await buildGetLibrary(loader, base)).degraded).toEqual(['sonarr']);
    });

    it('stays within budget at the default detail', async () => {
        const many = repeat(film(), 500).map((f, i) => ({ ...f, ids: { tmdb: i + 1 } }));
        const result = await buildGetLibrary(loaderOf(many), { ...base, limit: 500 });
        expectWithinBudget(result, 60_000);
    });
});

/**
 * A series could not carry an IMDb rating before 0.8, and `get_library` said
 * so in three places at once: the guard refused the filter, the default source
 * was hard-coded to `tvdb`, and the tool description told the model series
 * carry one flat TVDB rating. None of that was wrong — it accurately described
 * a stack where Sonarr was the only possible source. The IMDb dataset is what
 * makes it false.
 */
const series = (over: Partial<IndexInput> = {}): IndexInput =>
    film({
        kind: 'series',
        title: 'Some Series',
        ids: { tvdb: 81189, imdb: 'tt0903747' },
        acquisition: { service: 'sonarr', monitored: true, hasFile: true },
        ...over
    });

describe('series ratings, once the dataset can supply them', () => {
    it('no longer refuses rating_source: imdb for a series', async () => {
        await expect(
            buildGetLibrary(loaderOf([series()], 'sonarr'), { ...base, kind: 'series', rating_source: 'imdb' })
        ).resolves.toBeDefined();
    });

    /** The other documented limit is untouched: a series' quality really is
     *  per-episode, and no dataset changes that. */
    it('still refuses quality for a series', async () => {
        await expect(
            buildGetLibrary(loaderOf([series()], 'sonarr'), { ...base, kind: 'series', quality: 'bluray-1080p' })
        ).rejects.toThrow('quality applies to films only');
    });

    it('still refuses a source a series genuinely cannot have', async () => {
        await expect(
            buildGetLibrary(loaderOf([series()], 'sonarr'), { ...base, kind: 'series', rating_source: 'metacritic' })
        ).rejects.toThrow('applies to films only');
    });

    /** New, and the other half of the relaxed guard: Radarr never reports a
     *  TVDB rating, so asking for one on a film matched nothing silently. */
    it('refuses tvdb for a film', async () => {
        await expect(
            buildGetLibrary(loaderOf([film()]), { ...base, kind: 'movie', rating_source: 'tvdb' })
        ).rejects.toThrow('applies to series only');
    });

    /**
     * `tvdb` stays the default for a series even though `imdb` is now
     * reachable. Changing it would silently re-scale every saved prompt's
     * `min_rating` against a different source — the exact silent break
     * CONTRIBUTING warns about for the tool surface.
     */
    it('still defaults a series query to tvdb', async () => {
        const result = await buildGetLibrary(loaderOf([series({ ratings: { tvdb: 8.8 } })], 'sonarr'), {
            ...base,
            kind: 'series',
            min_rating: 1
        });
        expect(result.ratingCoverage?.source).toBe('tvdb');
    });

    it('reports coverage against imdb when imdb was asked for', async () => {
        const items = [
            series({ ratings: { imdb: 9.5 } }),
            series({ title: 'Unrated', ids: { tvdb: 1, imdb: 'tt0000001' } })
        ];
        const result = await buildGetLibrary(loaderOf(items, 'sonarr'), {
            ...base,
            kind: 'series',
            rating_source: 'imdb',
            min_rating: 1
        });
        expect(result.ratingCoverage).toMatchObject({ source: 'imdb', rated: 1, unrated: 1 });
    });

    it('filters a series by its IMDb rating', async () => {
        const items = [
            series({ title: 'Great', ratings: { imdb: 9.5 } }),
            series({ title: 'Poor', ids: { tvdb: 2, imdb: 'tt0000002' }, ratings: { imdb: 4.0 } })
        ];
        const result = await buildGetLibrary(loaderOf(items, 'sonarr'), {
            ...base,
            kind: 'series',
            rating_source: 'imdb',
            min_rating: 8
        });
        expect(result.items.map(i => i.title)).toEqual(['Great']);
    });
});

/**
 * A superlative cannot be answered by a filter. With more items than `limit`,
 * "the best rated" is answered from an arbitrary window — and the model then
 * reports it confidently, wrong in a way that looks exactly like being right.
 */
const rated = (title: string, imdb: number, over: Partial<IndexInput> = {}): IndexInput =>
    film({ title, ids: { tmdb: title.length * 977 + Math.round(imdb * 10) }, ratings: { imdb }, ...over });

/**
 * The bug a user actually hit: they asked for their series' IMDb scores, every
 * one came back unrated, and nothing anywhere said why.
 *
 * `ratingCoverage` already reported "0 rated, 40 unrated", which is true and
 * useless — it reads as "your library has no good series" rather than "the one
 * thing that could answer this is switched off". A model handed that number
 * reasonably concludes the question cannot be answered, which is what it told
 * them.
 *
 * The distinction worth drawing is three-way, because the remedies differ: not
 * enabled (turn it on), enabled but still ingesting (wait), and genuinely
 * covering nothing (a real answer about a real library).
 */
describe('explaining an imdb rating nothing could supply', () => {
    const loaderWith = (dataset: ImdbDataset | undefined, items: IndexInput[]) =>
        new LibraryLoader([stub('sonarr', items), jellyfinStub()], healthyJellyfinIdentity, undefined, dataset);

    let db: ImdbDataset | undefined;
    afterEach(() => {
        db?.close();
        db = undefined;
    });

    const seriesQuery = { ...base, kind: 'series' as const, rating_source: 'imdb' as const, min_rating: 1 };

    it('names the dataset when it is off and nothing carries an imdb rating', async () => {
        const result = await buildGetLibrary(loaderWith(undefined, [series()]), seriesQuery);

        expect(result.ratingCoverage).toMatchObject({ source: 'imdb', rated: 0, unrated: 1 });
        expect(result.ratingCoverage?.note).toMatch(/not enabled/i);
        // The remedy has to be findable, not merely implied.
        expect(result.ratingCoverage?.note).toContain('metadata.imdb.enabled');
    });

    /** Enabled but empty is a wait, not a config change — and saying "turn it
     *  on" to someone who already did would send them in a circle. */
    it('says to wait when the dataset is on but has not ingested yet', async () => {
        db = ImdbDataset.ephemeral();
        const result = await buildGetLibrary(loaderWith(db, [series()]), seriesQuery);

        expect(result.ratingCoverage?.note).toMatch(/still|not finished|ingest/i);
        expect(result.ratingCoverage?.note).not.toMatch(/not enabled/i);
    });

    /** A real answer about a real library gets no excuse attached to it. */
    it('says nothing when the dataset is ingested and simply does not know these titles', async () => {
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: [{ tconst: 'tt0000009', kind: 'tvSeries', title: 'Something Else' }],
            ratings: [{ tconst: 'tt0000009', average: 7, votes: 10 }]
        });

        const result = await buildGetLibrary(loaderWith(db, [series()]), seriesQuery);

        expect(result.ratingCoverage).toMatchObject({ rated: 0 });
        expect(result.ratingCoverage?.note).toBeUndefined();
    });

    /** Coverage that speaks for itself needs no note, however partial. */
    it('says nothing when at least one item is rated', async () => {
        const items = [series({ ratings: { imdb: 9.5 } }), series({ title: 'Other', ids: { tvdb: 1, imdb: 'tt1' } })];
        const result = await buildGetLibrary(loaderWith(undefined, items), seriesQuery);

        expect(result.ratingCoverage).toMatchObject({ rated: 1, unrated: 1 });
        expect(result.ratingCoverage?.note).toBeUndefined();
    });

    /** Films reach IMDb through Radarr, so an off dataset is not the whole
     *  story — but it is still the only thing that would fill the gap. */
    it('explains a film query that found no imdb ratings too', async () => {
        const result = await buildGetLibrary(
            new LibraryLoader([stub('radarr', [film()]), jellyfinStub()], healthyJellyfinIdentity),
            { ...base, kind: 'movie', rating_source: 'imdb', min_rating: 1 }
        );

        expect(result.ratingCoverage?.note).toMatch(/not enabled/i);
    });
});

describe('ordering', () => {
    it('orders before truncating, so the top result survives the limit', async () => {
        const many = [
            rated('Worst', 1.0),
            ...Array.from({ length: 60 }, (_, i) => film({ title: `Mid ${i}`, ids: { tmdb: 90_000 + i }, ratings: { imdb: 5 } })),
            rated('Best', 9.9)
        ];

        const result = await buildGetLibrary(loaderOf(many), {
            ...base,
            rating_source: 'imdb',
            sort: 'rating',
            limit: 10
        });

        expect(result.items[0]?.title).toBe('Best');
        expect(result.returned).toBe(10);
        expect(result.truncated).toBe(true);
    });

    /**
     * An unrated item sorted to the bottom is indistinguishable from a badly
     * rated one, so a rating sort drops them — and must then say how many, or
     * it is exactly the silent omission `ratingCoverage` exists to prevent.
     * Note there is no `min_rating` here: coverage has to appear for a sort
     * alone.
     */
    it('excludes unrated items from a rating sort and reports how many', async () => {
        const items = [rated('Rated', 8.0), film({ title: 'Unrated', ids: { tmdb: 999 } })];
        const result = await buildGetLibrary(loaderOf(items), { ...base, rating_source: 'imdb', sort: 'rating' });

        expect(result.items.map(i => i.title)).toEqual(['Rated']);
        expect(result.ratingCoverage).toMatchObject({ source: 'imdb', rated: 1, unrated: 1 });
    });

    it('sorts title ascending and year descending', async () => {
        const named = [film({ title: 'Zulu', ids: { tmdb: 1 } }), film({ title: 'Alien', ids: { tmdb: 2 } })];
        expect((await buildGetLibrary(loaderOf(named), { ...base, sort: 'title' })).items.map(i => i.title)).toEqual([
            'Alien',
            'Zulu'
        ]);

        const years = [film({ year: 1979, ids: { tmdb: 3 } }), film({ year: 2015, ids: { tmdb: 4 } })];
        expect((await buildGetLibrary(loaderOf(years), { ...base, sort: 'year' })).items.map(i => i.year)).toEqual([
            2015, 1979
        ]);
    });

    it('leaves order untouched when sort is not asked for', async () => {
        const named = [film({ title: 'Zulu', ids: { tmdb: 1 } }), film({ title: 'Alien', ids: { tmdb: 2 } })];
        const result = await buildGetLibrary(loaderOf(named), base);
        expect(result.items.map(i => i.title)).toEqual(['Zulu', 'Alien']);
    });

    it('omits coverage for a sort that has nothing to do with ratings', async () => {
        const named = [film({ title: 'Zulu', ids: { tmdb: 1 } })];
        expect((await buildGetLibrary(loaderOf(named), { ...base, sort: 'title' })).ratingCoverage).toBeUndefined();
    });

    /** The acceptance test for the whole phase. */
    it('answers "which unwatched series is best rated"', async () => {
        const items = [
            series({
                title: 'Seen',
                ids: { tvdb: 11, imdb: 'tt0000011' },
                ratings: { imdb: 9.9 },
                playback: { user: 'u1', watched: true }
            }),
            series({ title: 'Unseen', ids: { tvdb: 12, imdb: 'tt0000012' }, ratings: { imdb: 8.4 } })
        ];

        const result = await buildGetLibrary(loaderOf(items, 'sonarr'), {
            ...base,
            kind: 'series',
            watched: false,
            rating_source: 'imdb',
            sort: 'rating',
            limit: 10
        });

        expect(result.items.map(i => i.title)).toEqual(['Unseen']);
    });
});

/**
 * "What arrived this week" was unanswerable before 0.9: nothing in the merged
 * shape carried an added date, which is also why 0.8 shipped `sort` without
 * `added` in it.
 */
describe('sorting by when things arrived', () => {
    const arrived = (title: string, at: string, tmdb: number): IndexInput =>
        film({
            title,
            ids: { tmdb },
            acquisition: { service: 'radarr', monitored: true, hasFile: true, addedAt: at }
        });

    it('puts the most recently added first', async () => {
        const items = [
            arrived('Old', '2020-01-01T00:00:00Z', 1),
            arrived('New', '2026-08-01T00:00:00Z', 2),
            arrived('Middle', '2023-05-05T00:00:00Z', 3)
        ];
        const result = await buildGetLibrary(loaderOf(items), { ...base, sort: 'added' });
        expect(result.items.map(i => i.title)).toEqual(['New', 'Middle', 'Old']);
    });

    /**
     * Media Jellyfin alone knows about has no acquisition half and so no added
     * date. Sorting it as the epoch would answer "we do not know" with "1970" —
     * the same failure as ranking an unrated title zero.
     */
    it('excludes items with no added date rather than dating them to the epoch', async () => {
        const items = [
            arrived('Known', '2026-08-01T00:00:00Z', 1),
            film({ title: 'Unknown', ids: { tmdb: 2 } })
        ];
        const result = await buildGetLibrary(loaderOf(items), { ...base, sort: 'added' });
        expect(result.items.map(i => i.title)).toEqual(['Known']);
    });
});

/**
 * "What am I still waiting for" is one of the most commonly asked questions of
 * an *arr stack, and every comparable MCP server has a wanted/missing tool for
 * it. arr-mcp could not express it at all: `monitored` existed, nothing about
 * whether a file was on disk, and `presence` answers a different question —
 * which services know about an item, not whether one exists.
 */
describe('filtering by whether a file exists', () => {
    const onDisk = film({ title: 'Have it', ids: { tmdb: 1 } });
    const waiting = film({
        title: 'Waiting',
        ids: { tmdb: 2 },
        acquisition: { service: 'radarr', monitored: true, hasFile: false }
    });
    const { acquisition: _drop, ...unmanaged } = film({ title: 'Unmanaged', ids: { tmdb: 3 } });

    it('answers "what am I still waiting for"', async () => {
        const result = await buildGetLibrary(loaderOf([onDisk, waiting]), {
            ...base,
            has_file: false,
            monitored: true
        });
        expect(result.items.map(i => i.title)).toEqual(['Waiting']);
    });

    it('answers "what can I actually watch"', async () => {
        const result = await buildGetLibrary(loaderOf([onDisk, waiting]), { ...base, has_file: true });
        expect(result.items.map(i => i.title)).toEqual(['Have it']);
    });

    /**
     * Absent is not false. Media no *arr manages is not "waiting for a
     * download" — nothing is going to fetch it — so sweeping it into
     * `has_file: false` would put it on a list of things to chase. The same
     * distinction `presence: unknown` exists to protect.
     */
    it('excludes unmanaged media from both answers', async () => {
        const items = [onDisk, waiting, unmanaged as IndexInput];

        expect(
            (await buildGetLibrary(loaderOf(items), { ...base, has_file: false })).items.map(i => i.title)
        ).toEqual(['Waiting']);
        expect((await buildGetLibrary(loaderOf(items), { ...base, has_file: true })).items.map(i => i.title)).toEqual([
            'Have it'
        ]);
    });

    it('leaves the library alone when not asked for', async () => {
        expect((await buildGetLibrary(loaderOf([onDisk, waiting]), base)).total).toBe(2);
    });
});

/**
 * Two hundred series at ten seasons each is two thousand objects, spent
 * straight out of a model's context budget by callers who did not ask for
 * season arithmetic. `full` is the only detail level that pays that cost.
 */
describe('seasons projection', () => {
    const withSeasons = series({ seasons: [{ season: 1, watched: 8, total: 8, complete: true }] });

    it('returns seasons at full', async () => {
        const result = await buildGetLibrary(loaderOf([withSeasons], 'sonarr'), {
            ...base,
            detail: 'full',
            kind: 'series'
        });
        expect(result.items[0]?.seasons).toBeDefined();
    });

    it('omits seasons at standard, which is the default', async () => {
        const result = await buildGetLibrary(loaderOf([withSeasons], 'sonarr'), {
            ...base,
            detail: 'standard',
            kind: 'series'
        });
        expect(result.items[0]).not.toHaveProperty('seasons');
    });

    it('omits seasons at minimal', async () => {
        const result = await buildGetLibrary(loaderOf([withSeasons], 'sonarr'), {
            ...base,
            detail: 'minimal',
            kind: 'series'
        });
        expect(result.items[0]).not.toHaveProperty('seasons');
    });
});

/**
 * The other half of #103. `limit` bounds one answer; without an offset a
 * library past `MAX_LIMIT` could not be read in full at all, which is what the
 * reporter's agent was reaching for when it invented the parameter.
 *
 * Driven through `buildGetLibrary` rather than the schema, because what matters
 * is that the window lands after sorting and filtering — an offset applied to
 * the wrong list is a paging bug that no amount of schema testing would find.
 */
describe('paging a library larger than one answer', () => {
    const shelf = () =>
        loaderOf(
            Array.from({ length: 12 }, (_, i) =>
                film({ title: `Film ${String(i).padStart(2, '0')}`, ids: { tmdb: i + 1 } })
            )
        );

    const titles = (items: { title: string }[]) => items.map(i => i.title);

    it('returns the second page, and counts the whole library in `total`', async () => {
        const result = await buildGetLibrary(shelf(), { ...base, sort: 'title', limit: 5, offset: 5 });

        expect(titles(result.items)).toEqual(['Film 05', 'Film 06', 'Film 07', 'Film 08', 'Film 09']);
        expect(result.total).toBe(12);
        expect(result.returned).toBe(5);
        expect(result.offset).toBe(5);
    });

    /**
     * The bug this test exists for: an offset applied before the sort would
     * page through the services' own order and return a different five films
     * for the same request, while still looking perfectly well-formed.
     */
    it('pages the sorted order, not the order the services happened to return', async () => {
        const pages = await Promise.all(
            [0, 4, 8].map(offset => buildGetLibrary(shelf(), { ...base, sort: 'title', limit: 4, offset }))
        );

        expect(pages.flatMap(p => titles(p.items))).toEqual(
            Array.from({ length: 12 }, (_, i) => `Film ${String(i).padStart(2, '0')}`)
        );
    });

    /** A filter narrows the list the offset walks, so the two compose. */
    it('offsets within the filtered list rather than the whole library', async () => {
        const loader = loaderOf([
            ...Array.from({ length: 3 }, (_, i) => film({ title: `Film ${i}`, ids: { tmdb: i + 1 } })),
            ...Array.from({ length: 3 }, (_, i) =>
                film({ kind: 'series', title: `Show ${i}`, ids: { tvdb: i + 100 } })
            )
        ]);
        const result = await buildGetLibrary(loader, { ...base, kind: 'series', sort: 'title', limit: 2, offset: 1 });

        expect(titles(result.items)).toEqual(['Show 1', 'Show 2']);
        expect(result.total).toBe(3);
    });

    /**
     * Past the end is an empty page whose `total` still names the library. A
     * bare `[]` here would read as "you have no films", which is the same
     * false conclusion #103 ended in.
     */
    it('reports an empty page past the end without disowning the library', async () => {
        const result = await buildGetLibrary(shelf(), { ...base, limit: 5, offset: 50 });

        expect(result.items).toEqual([]);
        expect(result.total).toBe(12);
        expect(result.truncated).toBe(true);
    });
});
