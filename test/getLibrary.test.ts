import { describe, expect, it } from 'vitest';
import { LibraryIndex, type IndexInput } from '../src/core/resolver.ts';
import type { IdentityResolver } from '../src/core/identity.ts';
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

    it('refuses a per-source rating filter on series', async () => {
        // §21.2: Sonarr's rating is one flat TVDB value. Returning an empty
        // list here would read as "no such series exist".
        await expect(
            buildGetLibrary(loaderOf([film()]), { ...base, kind: 'series', min_rating: 8, rating_source: 'imdb' })
        ).rejects.toThrow(/flat TVDB/);
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
