import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { EmbyAdapter } from '../src/services/emby.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { hasUserMusic, hasWatchState } from '../src/services/types.ts';
import { jsonResponse, serving } from './helpers/serve.ts';

// Every fixture here was captured from Emby 4.10.2.0 on the test server, as
// its non-admin user (anonymised to "User 2"). Each test pins one way Emby's
// answer or route differs from Jellyfin's.

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/emby', name), 'utf8'));

const config: MultiUserServiceConfig = {
    url: 'http://192.0.2.10:8096',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false },
    default_user: 'User 2',
    allow_other_users: false
};

const VIEWER = '00000000000000000000000000000003';
const viewer = { id: VIEWER, name: 'User 2' };

/** A fetch that records each request as `METHOD path?query` and answers from `routes`. */
const recording = (routes: Record<string, unknown>) => {
    const asked: string[] = [];
    const answer = serving(routes);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        return answer(input, init);
    }) as unknown as typeof fetch;
    return { asked, fetchImpl };
};

describe('EmbyAdapter basics', () => {
    const adapter = new EmbyAdapter(
        config,
        serving({ '/System/Info': fixture('system-info.json'), '/Users': fixture('users.json'), '/ScheduledTasks': fixture('scheduled-tasks.json') })
    );

    it('is the emby service, named Emby', () => {
        expect([adapter.type, adapter.id, adapter.name]).toEqual(['emby', 'emby', 'Emby']);
    });

    it('reads the version from System/Info', async () => {
        expect(await adapter.getVersion()).toBe('4.10.2.0');
    });

    it('lists users by their 32-hex ids', async () => {
        expect(await adapter.listUsers()).toEqual([
            { id: '00000000000000000000000000000002', name: 'User 1' },
            { id: VIEWER, name: 'User 2' }
        ]);
    });

    it('finds the library scan by its Key, as on Jellyfin', async () => {
        expect(await adapter.getScanState()).toEqual({ service: 'emby', running: false, lastCompleted: '2024-01-02T12:49:31.499Z' });
    });

    it('sends the MediaBrowser token, which Emby accepts', async () => {
        let seen: Headers | undefined;
        const probe = (async (_i: string, init?: RequestInit) => {
            seen = new Headers(init?.headers);
            return jsonResponse({ Version: '4.10.2.0' });
        }) as unknown as typeof fetch;
        await new EmbyAdapter(config, probe).getVersion();
        expect(seen?.get('Authorization')).toBe('MediaBrowser Token="k"');
    });

    it("says where Emby's own UI makes a key when it refuses one", async () => {
        const refused = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
        await expect(new EmbyAdapter(config, refused).getVersion()).rejects.toMatchObject({
            kind: 'AuthFailed',
            remedy: 'The API key is wrong. Create one under Manage Emby Server → Advanced → Api Keys in Emby.'
        });
    });

    it('writes watch state and reads music, as the Jellyfin adapter does', () => {
        expect([hasWatchState(adapter), hasUserMusic(adapter)]).toEqual([true, true]);
    });
});

describe('Emby playback', () => {
    const RESUME = `/Users/${VIEWER}/Items/Resume?MediaTypes=Video&Limit=500`;

    it('reads the resumable set from the per-user route, keeping only what was started', async () => {
        const { asked, fetchImpl } = recording({ '/Sessions': fixture('sessions.json'), [RESUME]: fixture('resume.json') });
        const entries = await new EmbyAdapter(config, fetchImpl).getPlayback(viewer);

        expect(asked).toContain(`GET ${RESUME}`);
        // resume.json also holds The Last Round at position zero: Emby puts
        // the next episode there, and that is next_up, not resume.
        expect(entries.filter(e => e.kind === 'resume').map(e => e.itemId)).toEqual(['10', '11']);
    });

    it("reports what the user's session is playing, and where", async () => {
        const entries = await new EmbyAdapter(config, serving({ '/Sessions': fixture('sessions.json'), [RESUME]: fixture('resume.json') })).getPlayback(viewer);
        expect(entries.find(e => e.kind === 'now_playing')).toMatchObject({ itemId: '10', device: 'test-player', positionSeconds: 1889, percentComplete: 40 });
    });

    it('asks for Next Up the legacy way, which is the way Emby answers', async () => {
        const { asked, fetchImpl } = recording({ [`/Shows/NextUp?userId=${VIEWER}&LegacyNextUp=true`]: fixture('next-up.json') });
        const entries = await new EmbyAdapter(config, fetchImpl).getNextUp(viewer);
        expect(asked).toEqual([`GET /Shows/NextUp?userId=${VIEWER}&LegacyNextUp=true`]);
        expect(entries).toMatchObject([{ kind: 'next_up', itemId: '16', season: 3, episode: 16 }]);
    });
});

describe('Emby watch history', () => {
    const playedFor = (userId: string) =>
        `/Items?userId=${userId}&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Episode,Movie&Recursive=true&Limit=500&Fields=UserData`;
    const PLAYED = playedFor(VIEWER);
    const LOG = '/System/ActivityLog/Entries?hasUserId=true&Limit=500&StartIndex=0';
    const library = fixture('items-library.json') as { Items: { Id: string; UserData: { Played?: boolean } }[] };
    const resume = fixture('resume.json') as { Items: { Id: string }[] };
    const episodes = fixture('show-episodes.json') as { Items: { Id: string }[] };
    const played = { Items: library.Items.filter(i => i.UserData.Played === true && i.Id === '12') };
    const logged = (ids: string[]) => ({ Items: [...resume.Items, ...episodes.Items].filter(i => ids.includes(i.Id)) });

    it('reads the log without a type filter, which Emby ignores, and keeps the stops', async () => {
        const { asked, fetchImpl } = recording({
            [PLAYED]: played,
            [LOG]: fixture('activity-log.json'),
            '/Users/2': fixture('log-user.json'),
            [`/Items?userId=${VIEWER}&ids=10,17,11&Fields=UserData`]: logged(['10', '17', '11'])
        });
        const entries = await new EmbyAdapter(config, fetchImpl).getWatchHistory(viewer);

        expect(asked).toContain(`GET ${LOG}`);
        // One stop each for 10, 17 and 11, beside starts and sign-ins.
        expect(entries.filter(e => e.source === 'activity_log').map(e => e.itemId).sort()).toEqual(['10', '11', '17']);
        expect(entries.filter(e => e.source === 'marked_played').map(e => e.itemId)).toEqual(['12']);
    });

    it("turns the log's internal user number into the /Users id before matching", async () => {
        const someoneElse = { id: '00000000000000000000000000000002', name: 'User 1' };
        const { asked, fetchImpl } = recording({
            [playedFor(someoneElse.id)]: { Items: [] },
            [LOG]: fixture('activity-log.json'),
            '/Users/2': fixture('log-user.json')
        });
        expect(await new EmbyAdapter(config, fetchImpl).getWatchHistory(someoneElse)).toEqual([]);
        // Only `2` stopped anything, so only `2` is looked up.
        expect(asked.filter(a => a.startsWith('GET /Users/'))).toEqual(['GET /Users/2']);
    });

    it("leaves out a deleted user's stops rather than every stop", async () => {
        const log = fixture('activity-log.json') as { Items: Record<string, unknown>[] };
        const withGone = { Items: [...log.Items, { Type: 'playback.stop', ItemId: '13', UserId: '9', Date: '2024-01-02T13:20:00.000Z', Name: 'gone' }] };
        const routes = {
            [PLAYED]: { Items: [] },
            [LOG]: withGone,
            '/Users/2': fixture('log-user.json'),
            [`/Items?userId=${VIEWER}&ids=10,17,11&Fields=UserData`]: logged(['10', '17', '11'])
        };
        // serving() answers 404 for /Users/9, as Emby does for a removed user.
        const entries = await new EmbyAdapter(config, serving(routes)).getWatchHistory(viewer);
        expect(entries.map(e => e.itemId).sort()).toEqual(['10', '11', '17']);
    });

    it('pages the log until it holds 500 stops, since a page holds entries of every kind', async () => {
        const page = (start: number, stops: number) => ({
            Items: Array.from({ length: 500 }, (_, i) => ({
                Type: i < stops ? 'playback.stop' : 'user.authenticated',
                ItemId: String(start + i),
                UserId: '2',
                Date: '2024-01-02T12:00:00.000Z'
            }))
        });
        const route = '/System/ActivityLog/Entries?hasUserId=true&Limit=500';
        const { asked, fetchImpl } = recording({
            [PLAYED]: { Items: [] },
            [`${route}&StartIndex=0`]: page(0, 300),
            [`${route}&StartIndex=500`]: page(500, 300),
            [`${route}&StartIndex=1000`]: page(1000, 300),
            '/Users/2': fixture('log-user.json'),
            '/Items': { Items: [] }
        });
        await new EmbyAdapter(config, fetchImpl).getWatchHistory(viewer);
        // 300 stops on the first page, 600 by the second: the third is never read.
        expect(asked.filter(a => a.includes('ActivityLog'))).toEqual([`GET ${route}&StartIndex=0`, `GET ${route}&StartIndex=500`]);
        // The newest 500 of them, as one filtered read would give.
        const ids = asked.flatMap(a => /&ids=([\d,]+)/.exec(a)?.[1]?.split(',') ?? []);
        expect(ids).toHaveLength(500);
        expect(ids).toContain('699');
        expect(ids).not.toContain('700');
    });

    it('stops after 10 pages of a log with few stops, keeping the stops it found', async () => {
        const page = (start: number) => ({
            Items: Array.from({ length: 500 }, (_, i) => ({
                Type: i === 0 ? 'playback.stop' : 'user.authenticated',
                ItemId: String(start + i),
                UserId: '2',
                Date: '2024-01-02T12:00:00.000Z'
            }))
        });
        const route = '/System/ActivityLog/Entries?hasUserId=true&Limit=500';
        const starts = Array.from({ length: 11 }, (_, n) => n * 500);
        const { asked, fetchImpl } = recording({
            [PLAYED]: { Items: [] },
            ...Object.fromEntries(starts.map(start => [`${route}&StartIndex=${start}`, page(start)])),
            '/Users/2': fixture('log-user.json'),
            '/Items': { Items: [] }
        });
        await new EmbyAdapter(config, fetchImpl).getWatchHistory(viewer);
        // 5,000 entries, one stop a page: the eleventh page is never read.
        expect(asked.filter(a => a.includes('ActivityLog'))).toEqual(starts.slice(0, 10).map(start => `GET ${route}&StartIndex=${start}`));
        const ids = asked.flatMap(a => /&ids=([\d,]+)/.exec(a)?.[1]?.split(',') ?? []);
        expect(ids.sort((a, b) => Number(a) - Number(b))).toEqual(starts.slice(0, 10).map(String));
    });

    it('keeps the newest 200,000 entries of a longer log on the catch-up, rather than none', async () => {
        const route = '/System/ActivityLog/Entries?hasUserId=true&Limit=500&StartIndex=';
        const asked: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const path = `${url.pathname}${url.search}`;
            asked.push(path);
            if (path.startsWith(route)) {
                const start = Number(path.slice(route.length));
                return jsonResponse({
                    Items: Array.from({ length: 500 }, (_, i) => ({
                        Type: i === 0 ? 'playback.stop' : 'user.authenticated',
                        ItemId: String(start + i),
                        UserId: '2',
                        Date: '2024-01-02T12:00:00.000Z'
                    }))
                });
            }
            if (url.pathname === '/Users/2') return jsonResponse(fixture('log-user.json'));
            return jsonResponse({ Items: [] });
        }) as unknown as typeof fetch;
        await new EmbyAdapter(config, fetchImpl).getWatchHistory(viewer, { full: true });
        const pages = asked.filter(a => a.startsWith(route)).map(a => Number(a.slice(route.length)));
        expect(pages).toHaveLength(400);
        expect(pages.at(-1)).toBe(399 * 500);
        // One stop a page, each looked up: the log half was kept, not dropped.
        expect(asked.flatMap(a => /&ids=([\d,]+)/.exec(a)?.[1]?.split(',') ?? [])).toHaveLength(400);
    });

    it("leaves out a stop whose item is gone, since Emby logs a song's stop the same way", async () => {
        const log = fixture('activity-log.json') as { Items: Record<string, unknown>[] };
        const withGone = { Items: [{ Type: 'playback.stop', ItemId: '99', UserId: '2', Date: '2024-01-02T13:20:00.000Z', Name: 'gone' }, ...log.Items] };
        const routes = { [PLAYED]: { Items: [] }, [LOG]: withGone, '/Users/2': fixture('log-user.json'), '/Items': logged(['10', '17', '11']) };
        const entries = await new EmbyAdapter(config, serving(routes)).getWatchHistory(viewer);
        expect(entries.map(e => e.itemId).sort()).toEqual(['10', '11', '17']);
        expect(entries.some(e => e.removedFromLibrary === true)).toBe(false);
    });

    it('answers from the played list alone when a user lookup fails for another reason', async () => {
        const answer = serving({ [PLAYED]: played, [LOG]: fixture('activity-log.json') });
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
            new URL(input instanceof Request ? input.url : String(input)).pathname === '/Users/2'
                ? jsonResponse({ message: 'forbidden' }, 403)
                : answer(input, init)) as unknown as typeof fetch;
        const entries = await new EmbyAdapter(config, fetchImpl).getWatchHistory(viewer);
        // Which stops were whose cannot be told, so none are claimed.
        expect(entries.map(e => [e.itemId, e.source])).toEqual([['12', 'marked_played']]);
    });
});

describe('Emby watch state', () => {
    it('reads one item through the per-user route', async () => {
        const { asked, fetchImpl } = recording({ [`/Users/${VIEWER}/Items/12`]: fixture('watch-target.json') });
        const target = await new EmbyAdapter(config, fetchImpl).readWatchTarget(viewer, '12');
        expect(asked).toEqual([`GET /Users/${VIEWER}/Items/12`]);
        expect(target).toMatchObject({ id: '12', kind: 'movie', watched: false });
    });

    it('refuses an id that is not a whole number before asking Emby', async () => {
        const { asked, fetchImpl } = recording({});
        await expect(new EmbyAdapter(config, fetchImpl).readWatchTarget(viewer, 'f1e2d3c4b5a69788f1e2d3c4b5a69788')).rejects.toMatchObject({
            kind: 'NotFound',
            detail: '"f1e2d3c4b5a69788f1e2d3c4b5a69788" is not an Emby item id',
            remedy: expect.stringMatching(/^Emby item ids are digits only, and are not Radarr or Sonarr ids\./)
        });
        expect(asked).toEqual([]);
    });

    it('marks and unmarks through PlayedItems, with the user in the path', async () => {
        const { asked, fetchImpl } = recording({ [`/Users/${VIEWER}/PlayedItems/12`]: {} });
        const adapter = new EmbyAdapter(config, fetchImpl);
        await adapter.setWatched(viewer, '12', true);
        await adapter.setWatched(viewer, '12', false);
        expect(asked).toEqual([`POST /Users/${VIEWER}/PlayedItems/12`, `DELETE /Users/${VIEWER}/PlayedItems/12`]);
    });

    it('lists episodes with their numbers for a season mark', async () => {
        const fetchImpl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            return url.pathname === '/Shows/13/Episodes' ? jsonResponse(fixture('show-episodes.json')) : jsonResponse({}, 404);
        }) as unknown as typeof fetch;
        const episodes = await new EmbyAdapter(config, fetchImpl).listEpisodeItems(viewer, '13');
        expect(episodes.map(e => [e.id, e.season, e.episode, e.watched])).toEqual([
            ['17', 1, 1, true],
            ['16', 3, 16, false]
        ]);
    });
});

describe('Emby library reads', () => {
    const pages = (body: unknown) =>
        (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            return jsonResponse(Number(url.searchParams.get('StartIndex') ?? '0') === 0 ? body : { Items: [] });
        }) as unknown as typeof fetch;

    it("reads a series' IMDb id from the IMDB key Emby spells it with", async () => {
        const rows = await new EmbyAdapter(config, pages(fixture('items-library.json'))).listUserLibrary(viewer);
        expect(rows.find(r => r.kind === 'series')?.ids).toEqual({ tmdb: 10377, tvdb: 76479, imdb: 'tt0052442' });
        // A film's key is `Imdb`, as on Jellyfin.
        expect(rows.find(r => r.playback?.itemId === '12')?.ids).toMatchObject({ imdb: 'tt0037638' });
    });

    /** Emby sends a year only when `Fields` names it; Jellyfin sends it unasked. */
    it('asks for the year on every read that maps one, and maps it', async () => {
        const { asked, fetchImpl } = recording({
            '/Items': fixture('items-search.json')
        });
        const adapter = new EmbyAdapter(config, fetchImpl);
        expect((await adapter.search('de', 'library')).map(h => [h.title, h.year])).toEqual([
            ['<<untrusted:emby.Name>>Detour<</>>', 1945],
            ['<<untrusted:emby.Name>>Night of the Living Dead<</>>', 1968]
        ]);
        expect((await adapter.getMediaDetails('12')).year).toBe(1945);
        expect((await adapter.readMovieMetadata(viewer, '12'))[0]?.year).toBe(1945);
        expect((await adapter.listUserLibrary(viewer)).find(r => r.playback?.itemId === '12')?.year).toBe(1945);
        expect(asked.map(a => new URL(`http://h${a.split(' ')[1]}`).searchParams.get('Fields'))).toEqual([
            'ProviderIds,ProductionYear',
            'ProviderIds,Path,MediaSources,Overview,ProductionYear',
            'Path,ProviderIds,Settings,ProductionYear',
            'ProviderIds,Genres,OriginalTitle,RecursiveItemCount,ProductionYear'
        ]);
    });

    /** `RecursiveItemCount` comes back on a series row when `Fields` names it, as on Jellyfin. */
    it("tells an empty series from one with episodes by its episode count", async () => {
        const page = fixture('items-library.json') as { Items: Record<string, unknown>[] };
        const series = page.Items.find(i => i.Type === 'Series');
        expect(series?.RecursiveItemCount).toBe(2);
        const rows = await new EmbyAdapter(config, pages(page)).listUserLibrary(viewer);
        expect(rows.find(r => r.kind === 'series')?.playback).not.toHaveProperty('empty');
        const emptied = { ...page, Items: page.Items.map(i => (i.Type === 'Series' ? { ...i, RecursiveItemCount: 0 } : i)) };
        const none = await new EmbyAdapter(config, pages(emptied)).listUserLibrary(viewer);
        expect(none.find(r => r.kind === 'series')?.playback).toMatchObject({ empty: true });
    });

    it('joins an album artist on its MusicBrainz id', async () => {
        expect(await new EmbyAdapter(config, pages(fixture('album-artists.json'))).listUserMusic(viewer)).toMatchObject([
            { kind: 'artist', ids: { mbid: '09ff1fe8-d61c-4b98-bb82-18487c74d7b7' }, playback: { itemId: '135' } }
        ]);
    });
});

describe('Emby metadata repair', () => {
    it('reports a pinned repair as not settled, because Emby answers before it rebuilds the item', async () => {
        const { asked, fetchImpl } = recording({ '/Items/RemoteSearch/Apply/12': {} });
        expect(await new EmbyAdapter(config, fetchImpl).repairMetadata('12', { tmdbId: 20367 })).toEqual({ settled: false });
        expect(asked).toEqual(['POST /Items/RemoteSearch/Apply/12?replaceAllImages=false']);
    });

    const FILM = `/Items?userId=${VIEWER}&ids=12&Fields=Path,ProviderIds,Settings,ProductionYear&EnableImages=false`;
    // A series' locks are read with no user: see `identifyLockLoss`.
    const SERIES = '/Items?ids=13&Fields=Settings&EnableImages=false';
    const EPISODES = '/Shows/13/Episodes?Fields=Settings&EnableImages=false';
    /** One of the fixture's rows with the locks a test sets on it. */
    const locked = (name: string, id: string, locks: Record<string, unknown>) => {
        const page = fixture(name) as { Items: Record<string, unknown>[] };
        return { ...page, Items: page.Items.map(i => (i.Id === id ? { ...i, ...locks } : i)) };
    };

    it("keeps a film's locks as Emby reports them, false and empty when nothing is locked", async () => {
        const adapter = new EmbyAdapter(config, serving({ [FILM]: fixture('film-metadata.json') }));
        expect((await adapter.readMovieMetadata(viewer, '12')).map(f => f.locks)).toEqual([{ item: false, fields: [] }]);
    });

    it("names a film's own locks from the film read already made, with no request of its own", async () => {
        const { asked, fetchImpl } = recording({ [FILM]: locked('film-metadata.json', '12', { LockData: true, LockedFields: ['Name'] }) });
        const adapter = new EmbyAdapter(config, fetchImpl);
        const films = await adapter.readMovieMetadata(viewer, '12');
        expect(await adapter.identifyLockLoss({ itemId: '12', kind: 'movie' }, films)).toEqual({ own: ['item', 'Name'], wholeLockedEpisodes: [] });
        expect(asked).toEqual([`GET ${FILM}`]);
    });

    it("reads a series' own locks and its episodes' with no user, naming each episode locked as a whole", async () => {
        const { asked, fetchImpl } = recording({
            [SERIES]: locked('series-locks.json', '13', { LockedFields: ['Name'] }),
            [EPISODES]: locked('episode-locks.json', '17', { LockData: true })
        });
        // No episode records: the read the repair's user made is not what the server holds.
        expect(await new EmbyAdapter(config, fetchImpl).identifyLockLoss({ itemId: '13', kind: 'series' }, [])).toEqual({
            own: ['Name'],
            wholeLockedEpisodes: [{ id: '17', name: '<<untrusted:emby.Name>>The Bride Possessed<</>>', season: 1, episode: 1 }]
        });
        expect([...asked].sort()).toEqual([`GET ${SERIES}`, `GET ${EPISODES}`]);
    });

    it('does not count an episode whose only locks are on fields, which Emby keeps', async () => {
        const adapter = new EmbyAdapter(config, serving({ [SERIES]: fixture('series-locks.json'), [EPISODES]: locked('episode-locks.json', '16', { LockedFields: ['Name'] }) }));
        expect(await adapter.identifyLockLoss({ itemId: '13', kind: 'series' }, [])).toEqual({ own: [], wholeLockedEpisodes: [] });
    });

    it('is unread when Emby leaves the locks out, so none can be ruled out', async () => {
        const without = (name: string) => {
            const page = fixture(name) as { Items: Record<string, unknown>[] };
            return { ...page, Items: page.Items.map(({ LockData: _l, LockedFields: _f, ...i }) => i) };
        };
        const film = new EmbyAdapter(config, serving({ [FILM]: without('film-metadata.json') }));
        expect(await film.identifyLockLoss({ itemId: '12', kind: 'movie' }, await film.readMovieMetadata(viewer, '12'))).toEqual({ unread: true });
        const episodes = new EmbyAdapter(config, serving({ [SERIES]: fixture('series-locks.json'), [EPISODES]: without('episode-locks.json') }));
        expect(await episodes.identifyLockLoss({ itemId: '13', kind: 'series' }, [])).toEqual({ unread: true });
        const series = new EmbyAdapter(config, serving({ [SERIES]: without('series-locks.json'), [EPISODES]: fixture('episode-locks.json') }));
        expect(await series.identifyLockLoss({ itemId: '13', kind: 'series' }, [])).toEqual({ unread: true });
    });

    it('is unread when the episode read holds no list, or a row that cannot say what it locks', async () => {
        const lossWith = (episodes: unknown) =>
            new EmbyAdapter(config, serving({ [SERIES]: fixture('series-locks.json'), [EPISODES]: episodes })).identifyLockLoss({ itemId: '13', kind: 'series' }, []);
        const page = fixture('episode-locks.json') as { Items: unknown[] };
        expect(await lossWith({})).toEqual({ unread: true });
        expect(await lossWith({ ...page, Items: [...page.Items, null] })).toEqual({ unread: true });
        // Locked as a whole, but with no id to name it by.
        expect(await lossWith({ ...page, Items: [...page.Items, { Name: 'Unnamed', LockData: true }] })).toEqual({ unread: true });
        expect(await lossWith({ ...page, Items: [...page.Items, { Id: '', Name: 'Unnamed', LockData: true }] })).toEqual({ unread: true });
        // An unlocked row needs no id: nothing about it is lost.
        expect(await lossWith({ ...page, Items: [...page.Items, { Name: 'Unnamed', LockData: false }] })).toEqual({ own: [], wholeLockedEpisodes: [] });
    });

    it('asks Jellyfin nothing and keeps no locks on its records, since its identify keeps every lock', async () => {
        const { asked, fetchImpl } = recording({});
        const jellyfin = new JellyfinAdapter(config, fetchImpl);
        expect(await jellyfin.identifyLockLoss({ itemId: 'f1e2d3c4b5a69788f1e2d3c4b5a69788', kind: 'series' }, [{ id: 'a' }])).toEqual({
            own: [],
            wholeLockedEpisodes: []
        });
        expect(asked).toEqual([]);
        const page = { Items: [{ Id: 'f1e2d3c4b5a69788f1e2d3c4b5a69788', Name: 'Alien', LockData: true, LockedFields: [] }] };
        const films = await new JellyfinAdapter(config, serving({ '/Items': page })).readMovieMetadata(viewer, 'f1e2d3c4b5a69788f1e2d3c4b5a69788');
        expect(films[0]).not.toHaveProperty('locks');
        expect(films[0]?.lockedFields).toEqual(['title', 'year']);
    });
});
