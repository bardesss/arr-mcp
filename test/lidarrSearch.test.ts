import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import { hasReleaseGrab, hasReleaseSearch, hasSearchTrigger, type ServiceAdapter } from '../src/services/types.ts';
import { buildGetReleases } from '../src/tools/getReleases.ts';
import { registerGrabRelease } from '../src/tools/grabRelease.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { buildStackHealth } from '../src/tools/stackHealth.ts';
import { registerTriggerSearch } from '../src/tools/triggerSearch.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * Lidarr's indexer search: `trigger_search` on an artist or some of its albums,
 * and `get_releases` / `grab_release` for the artist or one album.
 * `release.json` was captured from an album search on Lidarr 3.1.6.5079 and
 * anonymised: titles, groups, indexers and qualities are placeholders, ids,
 * ages, weights, sizes, dates and peer counts are invented, every link is an
 * example URL, and hashes are blank or synthetic. The protocols, the
 * rejected/approved split and the discography flag are as captured.
 */

const config = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const permissive = (port: number): AnyServiceConfig =>
    ({ ...config(port), permissions: { safe_write: true, destructive: false } }) as AnyServiceConfig;

const RELEASES = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/lidarr/release.json'), 'utf8')) as Record<
    string,
    unknown
>[];

const ARTIST = { id: 4, artistName: 'Artist 1', monitored: true, statistics: { trackFileCount: 0, albumCount: 3 } };
const ALBUMS = [
    { id: 13, artistId: 4, title: 'Album 1', monitored: false, statistics: { trackFileCount: 0 } },
    { id: 14, artistId: 4, title: 'Album 2', monitored: false, statistics: { trackFileCount: 0 } },
    { id: 15, artistId: 4, title: 'Album 3', monitored: true, statistics: { trackFileCount: 0 } }
];
const COMMAND = { id: 31, name: 'ArtistSearch', status: 'queued' };

type Sent = { method: string; path: string; search: string; body: unknown };

/** Routes on the pathname and records the query too, which is where the scope lives. */
function lidarr(routes: Record<string, unknown>, port = 8686) {
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (method === 'POST' && url.pathname === '/api/v1/release') return new Response('', { status: 200 });
        const key = url.pathname === '/api/v1/album' ? `/api/v1/album${url.search.replace(/&.*$/, '')}` : url.pathname;
        if (!(key in routes) && !(url.pathname in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        return new Response(JSON.stringify(routes[key] ?? routes[url.pathname]), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { adapter: new LidarrAdapter(config(port), impl), sent };
}

const notFound = (async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 })) as unknown as typeof fetch;

const library = {
    '/api/v1/artist/4': ARTIST,
    '/api/v1/album?artistId=4': ALBUMS,
    '/api/v1/album/13': ALBUMS[0],
    '/api/v1/album/15': ALBUMS[2],
    '/api/v1/album/99': { id: 99, artistId: 5, title: 'Album 9', monitored: true },
    '/api/v1/command': COMMAND,
    '/api/v1/release': RELEASES
};

describe('LidarrAdapter search and grab', () => {
    it('claims the search trigger, the release search and the grab', () => {
        const { adapter } = lidarr({});
        expect(hasSearchTrigger(adapter)).toBe(true);
        expect(hasReleaseSearch(adapter)).toBe(true);
        expect(hasReleaseGrab(adapter)).toBe(true);
    });

    // Lidarr's own asymmetry, the same as Sonarr's: a bare id for the artist,
    // an array for albums. Sent the other way round, it searches nothing.
    it('posts ArtistSearch with a bare numeric artistId when no albums are named', async () => {
        const { adapter, sent } = lidarr(library);
        const handle = await adapter.triggerSearch('4');

        expect(sent.find(s => s.method === 'POST')).toMatchObject({ path: '/api/v1/command', body: { name: 'ArtistSearch', artistId: 4 } });
        expect(handle).toEqual({ service: 'lidarr', commandId: 31, name: 'ArtistSearch', status: 'queued' });
    });

    it('posts AlbumSearch with numeric albumIds when albums are named', async () => {
        const { adapter, sent } = lidarr(library);
        await adapter.triggerSearch('4', { albums: ['13', '15'] });

        expect(sent.find(s => s.method === 'POST')?.body).toEqual({ name: 'AlbumSearch', albumIds: [13, 15] });
    });

    it('refuses a season or episodes rather than searching the whole artist', async () => {
        const { adapter, sent } = lidarr(library);
        await expect(adapter.triggerSearch('4', { season: 1 })).rejects.toThrow(/no seasons or episodes/);
        await expect(adapter.triggerSearch('4', { episodes: ['13'] })).rejects.toThrow(/no seasons or episodes/);
        expect(sent).toHaveLength(0);
    });

    it('refuses a non-integer album id before posting anything', async () => {
        const { adapter, sent } = lidarr(library);
        await expect(adapter.triggerSearch('4', { albums: ['album-1'] })).rejects.toThrow(/is not a lidarr album id/);
        expect(sent).toHaveLength(0);
    });

    // A library row is an artist, so pointing at get_library for an album id
    // would send the caller somewhere it is not.
    it('points a bad album id at get_media_details, and a bad artist id at get_library', async () => {
        const { adapter } = lidarr(library);
        await expect(adapter.findReleases({ id: '4', album: 'album-1' })).rejects.toMatchObject({
            remedy: expect.stringMatching(/get_media_details on the artist/)
        });
        await expect(adapter.findReleases({ id: 'artist-4' })).rejects.toMatchObject({
            remedy: expect.stringMatching(/`acquisition\.id` on get_library/)
        });
    });

    it('searches releases for the artist by artistId', async () => {
        const { adapter, sent } = lidarr(library);
        const rows = await adapter.findReleases({ id: '4' });

        expect(sent.map(s => `${s.path}${s.search}`)).toEqual(['/api/v1/release?artistId=4']);
        expect(rows).toHaveLength(RELEASES.length);
    });

    // Lidarr 3.1.6 names the protocol by its class, as on the queue and the
    // blocklist; a release reads the same as Radarr's and Sonarr's.
    it('maps the captured rows, protocol class names included', async () => {
        const { adapter } = lidarr(library);
        const rows = await adapter.findReleases({ id: '4' });

        expect(rows.map(r => r.protocol)).toEqual(['usenet', 'usenet', 'torrent', 'usenet', 'torrent']);
        expect(rows.map(r => r.rejected)).toEqual([false, false, false, true, true]);
        expect(rows[0]).toMatchObject({ service: 'lidarr', guid: 'lidarr-guid-1', indexerId: 101, sizeBytes: 100_000_000, quality: 'Quality 1' });
        expect(unfenced(rows[0]?.title ?? '')).toBe('lidarr item 1');
        expect(rows[0]?.seeders).toBeUndefined();
        expect(rows[2]?.seeders).toBe(23);
        expect(rows[4]?.rejections?.map(unfenced)).toEqual(['Fixture rejection 1', 'Fixture rejection 2']);
    });

    it('searches one album by albumId after checking it is the artist\'s', async () => {
        const { adapter, sent } = lidarr(library);
        await adapter.findReleases({ id: '4', album: '15' });

        expect(sent.map(s => `${s.path}${s.search}`)).toEqual(['/api/v1/album/15', '/api/v1/release?albumId=15']);
    });

    // Lidarr searches an album by its id alone, so a pair that does not
    // match would list, and then grab, for an artist nobody named.
    it('refuses an album of another artist without searching', async () => {
        const { adapter, sent } = lidarr(library);
        await expect(adapter.findReleases({ id: '4', album: '99' })).rejects.toThrow(/not one of artist 4's albums/);
        expect(sent.some(s => s.path === '/api/v1/release')).toBe(false);
    });

    it('refuses a season or an episode on a release search', async () => {
        const { adapter, sent } = lidarr(library);
        await expect(adapter.findReleases({ id: '4', season: 1 })).rejects.toThrow(/no seasons or episodes/);
        await expect(adapter.findReleases({ id: '4', episode: '13' })).rejects.toThrow(/no seasons or episodes/);
        expect(sent).toHaveLength(0);
    });

    it('grabs by posting the guid and indexer id to /api/v1/release', async () => {
        const { adapter, sent } = lidarr(library);
        await adapter.grabRelease({ guid: 'lidarr-guid-1', indexerId: 101 });

        expect(sent).toEqual([
            { method: 'POST', path: '/api/v1/release', search: '', body: { guid: 'lidarr-guid-1', indexerId: 101 } }
        ]);
    });

    // Lidarr answers a grab only after handing the release to the download
    // client; live, that ran past the 10s default and reported a grab that
    // had happened as a timeout.
    it('gives a grab longer than the configured timeout', async () => {
        const slow = (async (_input: string, init?: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
                const timer = setTimeout(() => resolve(new Response('', { status: 200 })), 60);
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(init.signal?.reason as Error);
                });
            })) as unknown as typeof fetch;
        const adapter = new LidarrAdapter({ ...config(8686), timeout_ms: 20 }, slow);

        await expect(adapter.grabRelease({ guid: 'lidarr-guid-1', indexerId: 101 })).resolves.toBeUndefined();
    });

    // Posted once: a write is never retried, which is the double grab this
    // message exists to prevent.
    it('says a grab that still times out may have gone through, having posted it once', async () => {
        let posts = 0;
        const timedOut = (async () => {
            posts += 1;
            throw new DOMException('timed out', 'TimeoutError');
        }) as unknown as typeof fetch;
        const adapter = new LidarrAdapter(config(8686), timedOut);

        await expect(adapter.grabRelease({ guid: 'lidarr-guid-1', indexerId: 101 })).rejects.toThrow(
            /may still have gone through.*get_queue or get_history/
        );
        expect(posts).toBe(1);
    });

    // `get_stack_health` lists only the commands this server can start; a Lidarr
    // search left out of that list could never be followed up.
    it('keeps Lidarr searches in get_stack_health, and not the per-minute pollers', async () => {
        const now = Date.now();
        const ago = (ms: number) => new Date(now - ms).toISOString();
        const impl = (async (input: string | URL | Request) => {
            const path = new URL(input instanceof Request ? input.url : input).pathname;
            const body =
                path === '/api/v1/system/status'
                    ? { version: '3.1.6.5079' }
                    : path === '/api/v1/command'
                      ? [
                            { id: 31, name: 'ArtistSearch', status: 'started', queued: ago(60_000) },
                            { id: 32, name: 'AlbumSearch', status: 'queued', queued: ago(30_000) },
                            { id: 33, name: 'RefreshMonitoredDownloads', status: 'started', queued: ago(10_000) }
                        ]
                      : [];
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;

        const result = await buildStackHealth([new LidarrAdapter(config(8686), impl)], { detail: 'standard', limit: 50 });

        expect(result.commands?.map(c => c.name).sort()).toEqual(['AlbumSearch', 'ArtistSearch']);
    });
});

type Call = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: WriteToolResult }>;

const server = () => {
    let call: Call = () => Promise.reject(new Error('not registered'));
    return {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        },
        call: (args: Record<string, unknown>) => call(args)
    };
};

const context = (services: Partial<Record<ServiceId, AnyServiceConfig>>) => ({
    permissions: permissionSourceFrom(instancesOf(services)),
    confirm: new ConfirmTokens(),
    audit: WriteAudit.ephemeral(),
    library: { invalidate: vi.fn() } as unknown as LibraryLoader
});

function triggerSearch(adapters: ServiceAdapter[]) {
    const s = server();
    registerTriggerSearch(s as never, context({ lidarr: permissive(8686), radarr: permissive(7878), sonarr: permissive(8989) }), adapters);
    return s.call;
}

describe('trigger_search on Lidarr', () => {
    it('says a whole-artist search covers only the monitored albums', async () => {
        const { adapter } = lidarr(library);
        const { structuredContent } = await triggerSearch([adapter])({ service: 'lidarr', id: '4', dry_run: true });

        expect(structuredContent.summary).toContain('Artist 1');
        expect(structuredContent.effects.join(' ')).toContain('whole-artist search');
        expect(structuredContent.effects.join(' ')).toContain('Grabs only releases of its monitored albums: 1 of 3.');
        // `ParsingService` maps a discography release to every album, so it passes
        // while any one is monitored and brings the unmonitored ones with it.
        expect(structuredContent.effects.join(' ')).toContain('A discography release counts as every album');
    });

    it('leaves the discography note out when every album is monitored', async () => {
        const { adapter } = lidarr({ ...library, '/api/v1/album?artistId=4': ALBUMS.map(a => ({ ...a, monitored: true })) });
        const { structuredContent } = await triggerSearch([adapter])({ service: 'lidarr', id: '4', dry_run: true });

        const said = structuredContent.effects.join(' ');
        expect(said).toContain('Grabs only releases of its monitored albums: 3 of 3.');
        expect(said).not.toContain('discography');
    });

    // `AlbumRequestedSpecification` rejects every release outside the monitored
    // albums, so with none monitored the indexers are still asked and nothing is grabbed.
    it('says a whole-artist search with no monitored album will grab nothing, and what to do', async () => {
        const { adapter } = lidarr({ ...library, '/api/v1/album?artistId=4': ALBUMS.map(a => ({ ...a, monitored: false })) });
        const { structuredContent } = await triggerSearch([adapter])({ service: 'lidarr', id: '4', dry_run: true });

        const said = structuredContent.effects.join(' ');
        expect(said).toMatch(/None of .*Artist 1.*'s albums is monitored\. A whole-artist search still asks every indexer/);
        expect(said).toContain('so it will grab nothing. Name albums in `albums`, or monitor them with set_monitoring first.');
    });

    it('says an artist with no albums has nothing to grab, without telling it to name albums', async () => {
        const { adapter } = lidarr({ ...library, '/api/v1/album?artistId=4': [] });
        const { structuredContent } = await triggerSearch([adapter])({ service: 'lidarr', id: '4', dry_run: true });

        const said = structuredContent.effects.join(' ');
        expect(said).toMatch(/has no albums in Lidarr, so a whole-artist search has nothing to grab\. Refresh the artist with trigger_scan/);
        expect(said).not.toContain('Name albums');
    });

    // The Radarr and Sonarr preview says an unmonitored item may not be
    // grabbed. On Lidarr the reverse holds: a search skips the monitored check.
    it('warns that a named album is grabbed even when it is not monitored', async () => {
        const { adapter } = lidarr(library);
        const { structuredContent } = await triggerSearch([adapter])({ service: 'lidarr', id: '4', albums: ['13', '15'], dry_run: true });

        expect(structuredContent.summary).toContain('2 album(s)');
        expect(structuredContent.effects.join(' ')).toContain('1 of these albums is not monitored');
        expect(structuredContent.effects.join(' ')).toContain('can still grab it');
    });

    // `MonitoredAlbumSpecification` accepts during a search before it reads the
    // artist's flag, so an unmonitored artist is still grabbed for, though
    // Lidarr leaves its albums out of its own automatic searches.
    it("says an unmonitored artist's flag does not stop the search, for the artist and for named albums", async () => {
        const off = { ...library, '/api/v1/artist/4': { ...ARTIST, monitored: false } };
        const note =
            "is not monitored in Lidarr, which keeps its albums out of Lidarr's own automatic searches. A search started here skips that check, so the artist's flag does not stop it grabbing.";

        const whole = await triggerSearch([lidarr(off).adapter])({ service: 'lidarr', id: '4', dry_run: true });
        expect(whole.structuredContent.effects.join(' ')).toContain(note);
        const named = await triggerSearch([lidarr(off).adapter])({ service: 'lidarr', id: '4', albums: ['15'], dry_run: true });
        expect(named.structuredContent.effects.join(' ')).toContain(note);

        const on = await triggerSearch([lidarr(library).adapter])({ service: 'lidarr', id: '4', dry_run: true });
        expect(on.structuredContent.effects.join(' ')).not.toContain("artist's flag");
    });

    it('says an upgrade may replace tracks already on disk, for the artist and for named albums', async () => {
        const had = { ...library, '/api/v1/artist/4': { ...ARTIST, statistics: { trackFileCount: 5, albumCount: 3 } } };
        const withTracks = { ...had, '/api/v1/album?artistId=4': ALBUMS.map(a => (a.id === 15 ? { ...a, statistics: { trackFileCount: 5 } } : a)) };

        // An album missing a track skips Lidarr's upgrade and cutoff checks, so
        // "an upgrade" alone would be wrong for a partly downloaded album.
        // ...and the import still replaces a track on disk only with a better one.
        const replaces =
            'A search may grab an upgrade for them. Where an album is missing a track it can grab any quality the profile allows: that fills the missing tracks, and a track on disk is replaced only by a better one.';
        const whole = await triggerSearch([lidarr(withTracks).adapter])({ service: 'lidarr', id: '4', dry_run: true });
        expect(whole.structuredContent.effects).toContain(`Some of its albums already have tracks. ${replaces}`);

        const named = await triggerSearch([lidarr(withTracks).adapter])({ service: 'lidarr', id: '4', albums: ['13', '15'], dry_run: true });
        expect(named.structuredContent.effects).toContain(`1 of these albums already has tracks. ${replaces}`);
    });

    // `get_media_details` reads at most 500 albums; a count over a truncated
    // list must not read as the artist's whole discography.
    it('says the monitored count covers only the albums read when the list was truncated', async () => {
        const many = Array.from({ length: 501 }, (_, i) => ({ id: 101 + i, artistId: 4, title: `Album ${i + 1}`, monitored: i < 2 }));
        const { adapter } = lidarr({ ...library, '/api/v1/album?artistId=4': many });
        const { structuredContent } = await triggerSearch([adapter])({ service: 'lidarr', id: '4', dry_run: true });

        expect(structuredContent.effects.join(' ')).toContain('Grabs only releases of its monitored albums: 2 of the first 500 read.');
    });

    it('says only that a search may grab nothing when none of a truncated list is monitored', async () => {
        const many = Array.from({ length: 501 }, (_, i) => ({ id: 101 + i, artistId: 4, title: `Album ${i + 1}`, monitored: i === 500 }));
        const { adapter } = lidarr({ ...library, '/api/v1/album?artistId=4': many });
        const { structuredContent } = await triggerSearch([adapter])({ service: 'lidarr', id: '4', dry_run: true });

        const said = structuredContent.effects.join(' ');
        expect(said).toContain('is monitored among the first 500 read.');
        expect(said).toContain('so it may grab nothing.');
    });

    it('refuses an album the artist does not have, naming it, before posting', async () => {
        const { adapter, sent } = lidarr(library);
        await expect(triggerSearch([adapter])({ service: 'lidarr', id: '4', albums: ['13', '99'], dry_run: true })).rejects.toThrow(
            /Could not find album\(s\) 99/
        );
        expect(sent.some(s => s.method === 'POST')).toBe(false);
    });

    it('counts and searches an album named twice once', async () => {
        const { adapter, sent } = lidarr(library);
        const call = triggerSearch([adapter]);
        const first = await call({ service: 'lidarr', id: '4', albums: ['15', '15'] });
        expect(first.structuredContent.summary).toContain('1 album(s)');
        await call({ service: 'lidarr', id: '4', albums: ['15', '15'], confirm: first.structuredContent.confirm_token });

        expect(sent.filter(s => s.method === 'POST').map(s => s.body)).toEqual([{ name: 'AlbumSearch', albumIds: [15] }]);
    });

    it('confirms by posting AlbumSearch for the named albums', async () => {
        const { adapter, sent } = lidarr(library);
        const call = triggerSearch([adapter]);
        const first = await call({ service: 'lidarr', id: '4', albums: ['15'] });
        await call({ service: 'lidarr', id: '4', albums: ['15'], confirm: first.structuredContent.confirm_token });

        expect(sent.filter(s => s.method === 'POST').map(s => s.body)).toEqual([{ name: 'AlbumSearch', albumIds: [15] }]);
    });

    it('refuses a season on Lidarr, naming albums instead', async () => {
        const { adapter } = lidarr(library);
        await expect(triggerSearch([adapter])({ service: 'lidarr', id: '4', season: 1, dry_run: true })).rejects.toThrow(
            /no seasons or episodes/
        );
    });

    it('refuses albums on a service that has none', async () => {
        const radarr = new RadarrAdapter(config(7878), notFound);
        await expect(triggerSearch([radarr])({ service: 'radarr', id: '5', albums: ['13'], dry_run: true })).rejects.toThrow(
            /`albums` is a Lidarr option/
        );
        const sonarr = new SonarrAdapter(config(8989), notFound);
        await expect(triggerSearch([sonarr])({ service: 'sonarr', id: '5', albums: ['13'], dry_run: true })).rejects.toThrow(
            /`albums` is a Lidarr option/
        );
    });
});

describe('get_releases and grab_release on Lidarr', () => {
    const opts = { detail: 'full' as const, limit: 50 };

    it('passes the album to the search', async () => {
        const { adapter, sent } = lidarr(library);
        const result = await buildGetReleases([adapter], { ...opts, service: 'lidarr', id: '4', album: '15' });

        expect(sent.map(s => `${s.path}${s.search}`)).toContain('/api/v1/release?albumId=15');
        expect(result.total).toBe(RELEASES.length);
    });

    it('refuses an album on a service that has none, rather than searching the whole film', async () => {
        const radarr = new RadarrAdapter(config(7878), notFound);
        await expect(buildGetReleases([radarr], { ...opts, service: 'radarr', id: '5', album: '15' })).rejects.toThrow(
            /`album` is a Lidarr option/
        );
    });

    it('refuses an album in the Sonarr adapter itself, before any request', async () => {
        // The refusal belongs to the services without albums, as Radarr's
        // refusal of `season` does, so no tool has to name Lidarr.
        const calls = vi.fn(notFound);
        const sonarr = new SonarrAdapter(config(8989), calls as unknown as typeof fetch);
        await expect(sonarr.findReleases({ id: '5', album: '15' })).rejects.toThrow(/`album` is a Lidarr option/);
        expect(calls).not.toHaveBeenCalled();
    });

    function grabRelease(adapters: ServiceAdapter[]) {
        const s = server();
        registerGrabRelease(s as never, context({ lidarr: permissive(8686), radarr: permissive(7878) }), adapters);
        return s.call;
    }

    it('re-searches the same album before it will grab, then posts the release', async () => {
        const { adapter, sent } = lidarr(library);
        const call = grabRelease([adapter]);
        const args = { service: 'lidarr', id: '4', album: '15', guid: 'lidarr-guid-1', indexer_id: 101 };
        const first = await call(args);
        await call({ ...args, confirm: first.structuredContent.confirm_token });

        // The confirmation plans again, so the album is searched twice — and
        // only ever the album, never the whole artist.
        const searches = sent.filter(s => s.path === '/api/v1/release' && s.method === 'GET').map(s => s.search);
        expect(searches.length).toBeGreaterThan(0);
        expect(new Set(searches)).toEqual(new Set(['?albumId=15']));
        expect(sent.filter(s => s.method === 'POST').map(s => s.body)).toEqual([{ guid: 'lidarr-guid-1', indexerId: 101 }]);
    });

    it('refuses an album alongside a magnet', async () => {
        const client = { url: 'http://192.0.2.10:9091', timeout_ms: 10_000, permissions: { safe_write: true, destructive: false } };
        const s = server();
        registerGrabRelease(
            s as never,
            context({ transmission: client as AnyServiceConfig }),
            [new TransmissionAdapter(client as never, notFound)]
        );
        await expect(
            s.call({ service: 'transmission', album: '15', magnet: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000001' })
        ).rejects.toThrow(/`album` a Lidarr one/);
    });

    it('refuses an album on a service that has none', async () => {
        const radarr = new RadarrAdapter(config(7878), notFound);
        await expect(grabRelease([radarr])({ service: 'radarr', id: '5', album: '15', guid: 'lidarr-guid-1', indexer_id: 101 })).rejects.toThrow(
            /`album` is a Lidarr option/
        );
    });
});
