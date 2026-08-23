import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig, MultiUserServiceConfig } from '../src/config/schema.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { hasLibrary, hasUserLibrary, hasUserSeasons } from '../src/services/types.ts';
import { jsonResponse, serving } from './helpers/serve.ts';

const keyed: KeyedServiceConfig = {
    url: 'http://192.0.2.10:7878',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};
const multi: MultiUserServiceConfig = { ...keyed, default_user: 'Someone', allow_other_users: false };

const MOVIES = [
    {
        id: 1,
        title: 'Some Film',
        year: 2026,
        monitored: true,
        hasFile: true,
        tmdbId: 550,
        imdbId: 'tt0137523',
        genres: ['Drama', 'Thriller'],
        ratings: { imdb: { votes: 100, value: 8.8, type: 'user' }, rottenTomatoes: { votes: 0, value: 96, type: 'user' } },
        movieFile: { size: 4_000_000_000, quality: { quality: { name: 'Bluray-1080p' } } }
    }
];

const SERIES = [
    {
        id: 7,
        title: 'Some Show',
        year: 2017,
        monitored: true,
        tvdbId: 292157,
        imdbId: 'tt5687612',
        genres: ['Drama'],
        ratings: { votes: 164018, value: 8.3 },
        statistics: { sizeOnDisk: 90_000_000_000, episodeFileCount: 8 },
        seasons: [
            { seasonNumber: 0, monitored: false, statistics: { episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 3 } },
            { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8, episodeCount: 8, totalEpisodeCount: 8 } },
            { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 2, episodeCount: 6, totalEpisodeCount: 10 } }
        ]
    }
];

const ITEMS = {
    Items: [
        {
            Id: 'abc',
            Name: 'Some Film',
            Type: 'Movie',
            ProductionYear: 2026,
            Genres: ['Drama'],
            // Strings, as Jellyfin returns them — Radarr and Sonarr use numbers.
            ProviderIds: { Tmdb: '550', Imdb: 'tt0137523' },
            UserData: { Played: true, PlayCount: 2, LastPlayedDate: '2026-08-01T20:00:00Z' }
        },
        {
            Id: 'def',
            Name: 'Some Show',
            Type: 'Series',
            ProviderIds: { Tvdb: '292157' },
            UserData: { Played: false, PlayCount: 0 }
        }
    ]
};

/** Counts requests to one path, so a cache can be proven to skip the rest. */
const countingFetch = (path: string, body: unknown) => {
    let fetches = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
        const raw = input instanceof Request ? input.url : String(input);
        if (new URL(raw).pathname !== path) return jsonResponse({ message: 'not found' }, 404);
        fetches += 1;
        return jsonResponse(body);
    }) as unknown as typeof fetch;
    return { fetchImpl, fetches: () => fetches };
};

describe('Radarr.listLibrary', () => {
    const adapter = () => new RadarrAdapter(keyed, serving({ '/api/v3/movie': MOVIES }));

    it('is discoverable through the capability guard', () => {
        expect(hasLibrary(adapter())).toBe(true);
    });

    it('maps a film into an index input', async () => {
        const [item] = await adapter().listLibrary();
        expect(item).toMatchObject({
            kind: 'movie',
            year: 2026,
            // Fenced like every other string a service chose (§11). The filter
            // compares through the fence rather than against it.
            genres: [
                '<<untrusted:radarr.genre>>Drama<</untrusted>>',
                '<<untrusted:radarr.genre>>Thriller<</untrusted>>'
            ],
            ids: { tmdb: 550, imdb: 'tt0137523' },
            acquisition: {
                service: 'radarr',
                monitored: true,
                hasFile: true,
                quality: 'Bluray-1080p',
                sizeBytes: 4_000_000_000
            }
        });
    });

    it('fences the title, because it is a name a service chose', async () => {
        const [item] = await adapter().listLibrary();
        expect(item?.title).toBe('<<untrusted:radarr.title>>Some Film<</untrusted>>');
    });

    it('keeps only rating sources the merged type names', async () => {
        const [item] = await adapter().listLibrary();
        expect(item?.ratings).toEqual({ imdb: 8.8, rottenTomatoes: 96 });
    });
});

describe('Radarr library cache', () => {
    it('serves a repeated library search from one upstream read', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/movie', MOVIES);
        const radarr = new RadarrAdapter(keyed, fetchImpl);

        await radarr.search('some', 'library');
        await radarr.search('film', 'library');

        expect(fetches()).toBe(1);
    });

    it('shares that read with listLibrary', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/movie', MOVIES);
        const radarr = new RadarrAdapter(keyed, fetchImpl);

        await radarr.listLibrary();
        await radarr.search('some', 'library');

        expect(fetches()).toBe(1);
    });

    it('reads upstream again after the cache is invalidated', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/movie', MOVIES);
        const radarr = new RadarrAdapter(keyed, fetchImpl);

        await radarr.listLibrary();
        radarr.invalidateLibrary?.();
        await radarr.listLibrary();

        expect(fetches()).toBe(2);
    });

    it('does not cache a discover lookup', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/movie/lookup', MOVIES);
        const radarr = new RadarrAdapter(keyed, fetchImpl);

        await radarr.search('some', 'discover');
        await radarr.search('some', 'discover');

        expect(fetches()).toBe(2);
    });
});

describe('Sonarr.listLibrary', () => {
    const adapter = () => new SonarrAdapter(keyed, serving({ '/api/v3/series': SERIES }));

    it('maps a series, sized from statistics rather than a file', async () => {
        const [item] = await adapter().listLibrary();
        expect(item).toMatchObject({
            kind: 'series',
            ids: { tvdb: 292157, imdb: 'tt5687612' },
            acquisition: { service: 'sonarr', monitored: true, sizeBytes: 90_000_000_000 }
        });
    });

    it('reports hasFile from the episode file count, which is all a series has', async () => {
        const [item] = await adapter().listLibrary();
        expect(item?.acquisition?.hasFile).toBe(true);
    });

    it('labels the flat Sonarr rating tvdb, never as a per-source map', async () => {
        // §21.2: reporting this as `{ votes: 164018 }` is what 0.3.0 shipped.
        const [item] = await adapter().listLibrary();
        expect(item?.ratings).toEqual({ tvdb: 8.3 });
    });

    it('reports no quality, because a series quality would be a fiction', async () => {
        const [item] = await adapter().listLibrary();
        expect(item?.acquisition?.quality).toBeUndefined();
    });

    it('reports TVDB episode counts per season, which is what makes "finished" answerable', async () => {
        const [item] = await adapter().listLibrary();
        expect(item?.seasons).toEqual([
            { season: 0, monitored: false, onDisk: 0, aired: 0, total: 3 },
            { season: 1, monitored: true, onDisk: 8, aired: 8, total: 8 },
            { season: 2, monitored: true, onDisk: 2, aired: 6, total: 10 }
        ]);
    });

    // `get_media_details` returns the merged record for a title and Sonarr's
    // own view for a service+id, and both put their season rows on `seasons`.
    // Before this, only the by-id form carried `monitored` — so a model that
    // asked the natural way saw season rows with no monitoring at all and,
    // reading absent as false, could delete files Sonarr then re-downloads.
    it('carries per-season monitoring, so seasons[].monitored means one thing on both forms', async () => {
        const sonarr = new SonarrAdapter(
            keyed,
            serving({ '/api/v3/series': SERIES, '/api/v3/series/7': SERIES[0] })
        );
        const [merged] = await sonarr.listLibrary();
        const details = await sonarr.getMediaDetails('7', { includeEpisodes: false, episodeLimit: 0 });

        expect(merged?.seasons?.map(s => s.monitored)).toEqual([false, true, true]);
        expect(details.seasons?.map(s => s.monitored)).toEqual([false, true, true]);
    });

    it('omits monitored Sonarr did not report rather than calling it false', async () => {
        const bare = new SonarrAdapter(
            keyed,
            serving({ '/api/v3/series': [{ id: 7, title: 'Bare', tvdbId: 1, seasons: [{ seasonNumber: 1 }] }] })
        );
        const [item] = await bare.listLibrary();
        expect(item?.seasons?.[0]).not.toHaveProperty('monitored');
    });

    it('reports specials like any other season rather than dropping them', async () => {
        // Season 0 is real data. Deciding it is not television belongs to the
        // caller, which filters `season > 0`, not to this server.
        const [item] = await adapter().listLibrary();
        expect(item?.seasons?.some(s => s.season === 0)).toBe(true);
    });

    it('omits seasons entirely when Sonarr reported none', async () => {
        const bare = new SonarrAdapter(keyed, serving({ '/api/v3/series': [{ id: 7, title: 'Bare', tvdbId: 1 }] }));
        const [item] = await bare.listLibrary();
        expect(item).not.toHaveProperty('seasons');
    });
});

describe('Sonarr library cache', () => {
    it('serves a repeated library search from one upstream read', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/series', SERIES);
        const sonarr = new SonarrAdapter(keyed, fetchImpl);

        await sonarr.search('some', 'library');
        await sonarr.search('show', 'library');

        expect(fetches()).toBe(1);
    });

    it('shares that read with listLibrary', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/series', SERIES);
        const sonarr = new SonarrAdapter(keyed, fetchImpl);

        await sonarr.listLibrary();
        await sonarr.search('some', 'library');

        expect(fetches()).toBe(1);
    });

    it('reads upstream again after the cache is invalidated', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/series', SERIES);
        const sonarr = new SonarrAdapter(keyed, fetchImpl);

        await sonarr.listLibrary();
        sonarr.invalidateLibrary?.();
        await sonarr.listLibrary();

        expect(fetches()).toBe(2);
    });

    it('does not cache a discover lookup', async () => {
        const { fetchImpl, fetches } = countingFetch('/api/v3/series/lookup', SERIES);
        const sonarr = new SonarrAdapter(keyed, fetchImpl);

        await sonarr.search('some', 'discover');
        await sonarr.search('some', 'discover');

        expect(fetches()).toBe(2);
    });
});

describe('Jellyfin.listUserLibrary', () => {
    const path =
        '/Items?userId=u1&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,Genres&EnableUserData=true';
    const adapter = () => new JellyfinAdapter(multi, serving({ [path]: ITEMS }));
    const user = { id: 'u1', name: 'Someone' };

    it('is discoverable through the capability guard', () => {
        expect(hasUserLibrary(adapter())).toBe(true);
    });

    it('converts Jellyfin string ids to numbers, or every join silently fails', async () => {
        const items = await adapter().listUserLibrary(user);
        expect(items[0]?.ids).toEqual({ tmdb: 550, imdb: 'tt0137523' });
    });

    it('maps watch state, which exists nowhere else in the stack', async () => {
        const items = await adapter().listUserLibrary(user);
        expect(items[0]?.playback).toEqual({
            user: 'Someone',
            watched: true,
            playCount: 2,
            lastPlayed: '2026-08-01T20:00:00Z'
        });
    });

    it('reports an unwatched item as watched: false rather than omitting it', async () => {
        const items = await adapter().listUserLibrary(user);
        expect(items[1]?.playback).toMatchObject({ watched: false, playCount: 0 });
    });

    it('distinguishes series from films by Type', async () => {
        const items = await adapter().listUserLibrary(user);
        expect(items.map(i => i.kind)).toEqual(['movie', 'series']);
    });

    it('contributes no acquisition half — Jellyfin manages nothing', async () => {
        const items = await adapter().listUserLibrary(user);
        expect(items.every(i => i.acquisition === undefined)).toBe(true);
    });
});

const SERIES_ITEMS = {
    Items: [
        { Id: 'show-1', Name: 'Some Show', Type: 'Series', ProviderIds: { Tvdb: '292157' } },
        { Id: 'show-2', Name: 'Unwatched Show', Type: 'Series', ProviderIds: { Tvdb: '999' } },
        // Watched, and carrying no external id at all — a real Jellyfin state
        // for a series its metadata providers never matched.
        { Id: 'show-3', Name: 'Id-less Show', Type: 'Series' }
    ]
};

const EPISODE_ITEMS = {
    Items: [
        { Id: 'e1', SeriesId: 'show-1', ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: true, LastPlayedDate: '2026-08-09T20:00:00Z' } },
        { Id: 'e2', SeriesId: 'show-1', ParentIndexNumber: 1, IndexNumber: 2, UserData: { Played: true, LastPlayedDate: '2026-08-10T21:00:00Z' } },
        { Id: 'e3', SeriesId: 'show-1', ParentIndexNumber: 2, IndexNumber: 1, UserData: { Played: false } },
        { Id: 'e4', SeriesId: 'show-3', ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: true } }
    ]
};

const SERIES_ROUTE = '/Items?Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds';
const EPISODE_ROUTE = '/Items?userId=u1&Recursive=true&IncludeItemTypes=Episode&EnableUserData=true';

describe('Jellyfin.listUserSeasons', () => {
    const adapter = () =>
        new JellyfinAdapter(multi, serving({ [SERIES_ROUTE]: SERIES_ITEMS, [EPISODE_ROUTE]: EPISODE_ITEMS }));
    const someone = { id: 'u1', name: 'Someone' };

    it('is discoverable through the capability guard', () => {
        expect(hasUserSeasons(adapter())).toBe(true);
    });

    it('rolls episodes up per season, counting only played ones', async () => {
        const items = await adapter().listUserSeasons(someone);
        expect(items).toHaveLength(1);
        expect(items[0]?.seasons).toEqual([
            { season: 1, watched: 2, lastPlayed: '2026-08-10T21:00:00Z' },
            { season: 2, watched: 0 }
        ]);
    });

    it('carries the external ids the resolver joins on, never Jellyfin\'s own id', async () => {
        const [item] = await adapter().listUserSeasons(someone);
        expect(item?.ids).toEqual({ tvdb: 292157 });
        expect(JSON.stringify(item)).not.toContain('show-1');
    });

    it('omits a series with no episodes at all rather than inventing empty seasons', async () => {
        const items = await adapter().listUserSeasons(someone);
        expect(items.map(i => i.ids.tvdb)).not.toContain(999);
    });

    it('drops a series carrying no external id, which would otherwise duplicate a library row', async () => {
        // `LibraryIndex.build` keys on tmdb/tvdb/imdb. A seasons-only row with
        // none of them joins to nothing and becomes a second, near-empty item
        // beside the one `listUserLibrary` already returned for the same
        // series — a duplicated title and an inflated `total` in get_library.
        const items = await adapter().listUserSeasons(someone);
        expect(JSON.stringify(items)).not.toContain('Id-less Show');
        expect(items.every(i => Object.keys(i.ids).length > 0)).toBe(true);
    });

    it('carries no playback field, so it cannot fabricate presence on its own', async () => {
        // presence: 'both' means Jellyfin saw the item. That claim belongs to
        // listUserLibrary; this source only ever adds seasons to it.
        const [item] = await adapter().listUserSeasons(someone);
        expect(item).not.toHaveProperty('playback');
    });
});

const RESUMABLE_ROUTE = '/Users/u1/Items/Resume?Limit=500';

const RESUMABLE = {
    Items: [
        {
            Id: 'film-1',
            Name: 'Some Film',
            Type: 'Movie',
            RunTimeTicks: 72_000_000_000, // 2h in ticks
            UserData: { PlaybackPositionTicks: 18_000_000_000, LastPlayedDate: '2026-08-10T21:00:00Z' }
        },
        {
            Id: 'ep-1',
            Name: 'Some Episode',
            Type: 'Episode',
            SeriesName: 'Some Show',
            ParentIndexNumber: 2,
            IndexNumber: 3,
            RunTimeTicks: 18_000_000_000,
            UserData: { PlaybackPositionTicks: 9_000_000_000 }
        }
    ]
};

describe('Jellyfin.getPlayback', () => {
    const adapter = () =>
        new JellyfinAdapter(multi, serving({ '/Sessions': [], [RESUMABLE_ROUTE]: RESUMABLE }));
    const someone = { id: 'u1', name: 'Someone' };

    it('reads the resumable set from the supported endpoint', async () => {
        // /Users/{id}/Items/Resume is the supported way to ask for the resumable
        // set. /Items?IsResumable=true looks like the right query but is silently
        // ignored by Jellyfin 10.11 — it returns the entire library.
        const entries = await adapter().getPlayback(someone);
        expect(entries).toHaveLength(2);
        expect(entries.every(e => e.kind === 'resume')).toBe(true);
    });

    it('carries percentComplete, which is what a >20% rule filters on', async () => {
        const [film] = await adapter().getPlayback(someone);
        expect(film).toMatchObject({ percentComplete: 25, positionSeconds: 1800, runtimeSeconds: 7200 });
    });

    it('marks episodes with series and numbers, so films can be told apart', async () => {
        const episode = (await adapter().getPlayback(someone)).find(e => e.season !== undefined);
        expect(episode).toMatchObject({ season: 2, episode: 3 });
        // A film carries none of these — that is how a caller filters to films.
        const film = (await adapter().getPlayback(someone)).find(e => e.season === undefined);
        expect(film).not.toHaveProperty('seriesTitle');
    });
});

const NEXT_UP_ROUTE = '/Shows/NextUp?userId=u1';

// Captured against a live 10.11.11 — see task-5-brief.md.
const NEXT_UP = {
    Items: [
        {
            Id: 'nu-1',
            Name: 'Faceless Men',
            Type: 'Episode',
            SeriesName: 'House of the Dragon',
            SeriesId: 'series-1',
            ParentIndexNumber: 3,
            IndexNumber: 6,
            PremiereDate: '2026-07-25T22:00:00.0000000Z',
            UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false }
        }
    ]
};

describe('Jellyfin.getNextUp', () => {
    const someone = { id: 'u1', name: 'Someone' };
    const adapter = () => new JellyfinAdapter(multi, serving({ [NEXT_UP_ROUTE]: NEXT_UP }));

    it('reads the per-user Next Up list', async () => {
        const entries = await adapter().getNextUp(someone);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'next_up', itemId: 'nu-1', season: 3, episode: 6 });
    });

    it('carries the episode title and the series name distinguishably', async () => {
        const [entry] = await adapter().getNextUp(someone);
        expect(entry?.title).toContain('Faceless Men');
        expect(entry?.seriesTitle).toContain('House of the Dragon');
    });
});

const HISTORY_ROUTE =
    '/Items?userId=u1&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Episode,Movie&Recursive=true&Limit=500&Fields=UserData';

// Captured against a live 10.11.11 — see task-5-brief.md.
const HISTORY = {
    Items: [
        {
            Id: 'h-1',
            Name: 'Some Film',
            Type: 'Movie',
            UserData: { LastPlayedDate: '2026-08-19T18:29:55.0574726Z' }
        }
    ]
};

describe('Jellyfin.getWatchHistory', () => {
    const someone = { id: 'u1', name: 'Someone' };
    const adapter = () => new JellyfinAdapter(multi, serving({ [HISTORY_ROUTE]: HISTORY }));

    it('reads played items from the sort-by-DatePlayed query', async () => {
        const entries = await adapter().getWatchHistory(someone);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'watched', itemId: 'h-1', lastPlayed: '2026-08-19T18:29:55.0574726Z' });
    });
});
