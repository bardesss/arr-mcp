import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import {
    hasDiskSpace,
    hasLibrary,
    hasMediaDetails,
    hasMonitorState,
    hasMonitoring,
    hasQueue,
    hasSearch,
    hasWanted
} from '../src/services/types.ts';

const config: KeyedServiceConfig = {
    url: 'http://192.168.1.20:8686',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const STATUS = { appName: 'Lidarr', version: '3.0.0.1740', instanceName: 'Lidarr', urlBase: '' };

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every pathname it was asked for, so a test can prove which root was used. */
const serving = (routes: Record<string, unknown>, seen: string[] = []) =>
    ((async (input: string) => {
        const path = new URL(String(input)).pathname;
        seen.push(path);
        if (!(path in routes)) return json({ message: 'not found' }, 404);
        return json(routes[path]);
    }) as unknown) as typeof fetch;

const adapter = (routes: Record<string, unknown>, seen?: string[]) => new LidarrAdapter(config, serving(routes, seen));

describe('LidarrAdapter', () => {
    it('is lidarr, single-instance', () => {
        const a = adapter({});
        expect(a.id).toBe('lidarr');
        expect(a.type).toBe('lidarr');
        expect(a.instance).toBeUndefined();
    });

    /**
     * Lidarr never served a v3, so a `/api/v3` here means the root never reached
     * `ServiceHttp` and every shared helper is off by a version.
     */
    it('reads its version from /api/v1, not /api/v3', async () => {
        const seen: string[] = [];
        const version = await adapter({ '/api/v1/system/status': STATUS }, seen).getVersion();

        expect(version).toBe('3.0.0.1740');
        expect(seen).toEqual(['/api/v1/system/status']);
    });

    it('reports a working connection with the version', async () => {
        const diagnosis = await adapter({ '/api/v1/system/status': STATUS }).testConnection();

        expect(diagnosis).toMatchObject({ ok: true, service: 'lidarr', version: '3.0.0.1740' });
    });

    it('reports an unreachable service rather than throwing', async () => {
        const failing = new LidarrAdapter(
            config,
            ((async () => {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }) as unknown) as typeof fetch
        );
        const diagnosis = await failing.testConnection();

        expect(diagnosis.ok).toBe(false);
    });

    /**
     * Every capability interface is structural, so a method is the whole claim.
     * Listing the prototype covers all 46 guards; sampling a few of them stays
     * green when someone adds the one that was not sampled.
     */
    it('claims library reads, search, monitoring, queue, history and blocklist, and nothing else', () => {
        const a = adapter({});
        const own = Object.getOwnPropertyNames(LidarrAdapter.prototype).filter(name => name !== 'constructor');

        expect(own.sort()).toEqual([
            'getMediaDetails',
            'getMonitorState',
            'getQueue',
            'getVersion',
            'invalidateLibrary',
            'listArtistMonitorPolicies',
            'listLibrary',
            'readBlocklist',
            'readHistory',
            'refusePartialSelection',
            'removeBlocklistItem',
            'search',
            'setArtistMonitorPolicy',
            'setMonitoring',
            'testConnection'
        ]);
        expect(hasLibrary(a)).toBe(true);
        expect(hasSearch(a)).toBe(true);
        expect(hasMonitoring(a)).toBe(true);
        expect(hasMonitorState(a)).toBe(true);
        expect(hasMediaDetails(a)).toBe(true);
        expect(hasQueue(a)).toBe(true);
        expect(hasDiskSpace(a)).toBe(false);
        expect(hasWanted(a)).toBe(false);
    });

    describe('monitoring', () => {
        const ALBUM = { id: 7, title: 'House of Sugar', releaseDate: '2019-09-13', monitored: true, artist: { artistName: 'Alex G' } };

        it('reads back the album it is about to write, not the cached library', async () => {
            const seen: string[] = [];
            const state = await adapter({ '/api/v1/album/7': ALBUM }, seen).getMonitorState('7');

            expect(state).toEqual({
                label: '<<untrusted:lidarr.title>>House of Sugar<</untrusted>> — <<untrusted:lidarr.artist>>Alex G<</untrusted>> (2019)',
                monitored: true
            });
            expect(seen).toEqual(['/api/v1/album/7']);
        });

        it('refuses a non-integer album id rather than sending it on', async () => {
            const seen: string[] = [];
            await expect(adapter({ '/api/v1/album/7': ALBUM }, seen).getMonitorState('not-a-number')).rejects.toThrow(
                /is not a Lidarr album id/
            );
            expect(seen).toEqual([]);
        });

        it('writes the album monitor endpoint with a one-element list', async () => {
            const seen: string[] = [];
            const routes: Record<string, unknown> = { '/api/v1/album/monitor': { albumIds: [7], monitored: false } };

            await adapter(routes, seen).setMonitoring('7', { monitored: false });

            expect(seen).toEqual(['/api/v1/album/monitor']);
        });

        /**
         * Lidarr ignores a body field it has no use for and answers 200, so a
         * season sent to an album would report success for a write that monitored
         * the whole album instead. Refused before anything is sent.
         */
        it('refuses a season or episode id on an album', async () => {
            const seen: string[] = [];
            const a = adapter({ '/api/v1/album/monitor': {} }, seen);

            await expect(a.setMonitoring('7', { monitored: false, season: 1 })).rejects.toThrow(/no seasons/);
            await expect(a.setMonitoring('7', { monitored: false, episodeIds: ['3'] })).rejects.toThrow(/no seasons/);
            expect(seen).toEqual([]);
        });
    });

    describe('search', () => {
        const ARTIST = {
            id: 1,
            artistName: 'Daft Punk',
            foreignArtistId: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
            status: 'ended',
            monitored: true,
            statistics: { trackFileCount: 14, albumCount: 4 }
        };

        it('finds an artist by name', async () => {
            const a = adapter({ '/api/v1/artist': [ARTIST] });

            expect((await a.search('daft', 'library')).map(h => h.kind)).toEqual(['artist']);
            expect(await a.search('homework', 'library')).toEqual([]);
        });

        it('answers nothing for a source it cannot serve', async () => {
            // No lookup call either: an artist-to-add is not a library row, and
            // nothing here can add music anyway.
            const seen: string[] = [];
            const a = adapter({ '/api/v1/artist': [ARTIST] }, seen);

            expect(await a.search('daft punk', 'discover')).toEqual([]);
            expect(seen).toEqual([]);
        });

        it('carries the id a follow-up call needs', async () => {
            const [hit] = await adapter({ '/api/v1/artist': [ARTIST] }).search('daft', 'library');

            expect(hit).toMatchObject({
                service: 'lidarr',
                source: 'library',
                kind: 'artist',
                id: '1',
                // The MusicBrainz artist id, which is what a media server
                // publishes for the same artist.
                ids: { mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56' },
                hasFile: true,
                monitored: true
            });
            expect(unfenced(hit?.title ?? '')).toBe('Daft Punk');
        });
    });

    describe('listLibrary', () => {
        const ARTIST = {
            id: 4,
            artistName: 'Daft Punk',
            foreignArtistId: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
            status: 'ended',
            monitored: true,
            added: '2026-10-27T04:14:06Z',
            genres: ['Electronic', 'Disco'],
            path: '/music/Daft Punk',
            qualityProfileId: 1,
            statistics: { albumCount: 4, trackFileCount: 0, trackCount: 108, sizeOnDisk: 0 }
        };
        const PROFILES = [{ id: 1, name: 'Lossless' }];

        it('maps an artist to a library row', async () => {
            const seen: string[] = [];
            const rows = await adapter(
                { '/api/v1/artist': [ARTIST], '/api/v1/qualityprofile': PROFILES },
                seen
            ).listLibrary();

            expect(seen).toEqual(['/api/v1/artist', '/api/v1/qualityprofile']);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                kind: 'artist',
                // The MusicBrainz artist id, and no integer ids invented from
                // the internal `id`.
                ids: { mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56' },
                albumCount: 4,
                acquisition: {
                    service: 'lidarr',
                    id: '4',
                    status: 'ended',
                    monitored: true,
                    hasFile: false,
                    qualityProfileId: 1,
                    addedAt: '2026-10-27T04:14:06Z',
                    sizeBytes: 0
                }
            });
            expect(unfenced(rows[0]?.title ?? '')).toBe('Daft Punk');
            // `readQualityProfiles` fences the name itself, as it does for
            // Radarr and Sonarr.
            expect(unfenced(rows[0]?.acquisition?.qualityProfile ?? '')).toBe('Lossless');
        });

        it('fences every string it takes from the service', async () => {
            const rows = await adapter({ '/api/v1/artist': [ARTIST] }).listLibrary();

            expect(rows[0]?.title.startsWith('<<untrusted:lidarr.title>>')).toBe(true);
            expect(rows[0]?.genres?.[0]?.startsWith('<<untrusted:lidarr.genre>>')).toBe(true);
            expect(rows[0]?.acquisition?.path?.startsWith('<<untrusted:lidarr.path>>')).toBe(true);
        });

        it('reports a file once any track is on disk', async () => {
            const partial = { ...ARTIST, statistics: { albumCount: 4, trackFileCount: 5, sizeOnDisk: 900 } };
            const [row] = await adapter({ '/api/v1/artist': [partial] }).listLibrary();

            expect(row?.acquisition?.hasFile).toBe(true);
            expect(row?.acquisition?.sizeBytes).toBe(900);
        });

        it('keeps the profile id when the profile list cannot be read', async () => {
            const [row] = await adapter({ '/api/v1/artist': [ARTIST] }).listLibrary();

            expect(row?.acquisition?.qualityProfileId).toBe(1);
            expect(row?.acquisition?.qualityProfile).toBeUndefined();
        });

        it('omits what the row did not carry rather than inventing it', async () => {
            const bare = { id: 9, monitored: false };
            const [row] = await adapter({ '/api/v1/artist': [bare] }).listLibrary();

            expect(row).toMatchObject({ kind: 'artist', ids: {}, acquisition: { monitored: false, hasFile: false } });
            expect(row?.title).toBe('');
            expect(row?.albumCount).toBeUndefined();
            expect(row?.genres).toBeUndefined();
            expect(row?.acquisition?.addedAt).toBeUndefined();
        });

        /**
         * Rows on artists, so an album id has to come from somewhere else. This
         * is that somewhere: one artist, its albums, and the ids a
         * `level: "album"` write takes.
         */
        it('reads one artist with its albums for get_media_details', async () => {
            const rows = await adapter({
                '/api/v1/artist/4': ARTIST,
                '/api/v1/album': [
                    {
                        id: 17,
                        title: 'Discovery',
                        foreignAlbumId: '48117b90-a16e-34ca-a514-19c702df1158',
                        releaseDate: '2001-02-26T00:00:00Z',
                        albumType: 'Album',
                        monitored: true,
                        statistics: { trackFileCount: 14 }
                    }
                ]
            }).getMediaDetails('4', { includeEpisodes: true, episodeLimit: 50 });

            expect(rows).toMatchObject({
                service: 'lidarr',
                kind: 'artist',
                id: '4',
                ids: { mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56' },
                albumCount: 4,
                albumsTruncated: false
            });
            expect(rows.albums).toMatchObject([
                {
                    id: '17',
                    title: '<<untrusted:lidarr.title>>Discovery<</untrusted>>',
                    year: 2001,
                    albumType: 'Album',
                    monitored: true,
                    hasFile: true,
                    mbid: '48117b90-a16e-34ca-a514-19c702df1158'
                }
            ]);
            expect(unfenced(rows.albums?.[0]?.title ?? '')).toBe('Discovery');
        });

        it('does not read albums at standard detail', async () => {
            const seen: string[] = [];
            const rows = await adapter({ '/api/v1/artist/4': ARTIST }, seen).getMediaDetails('4', {
                includeEpisodes: false,
                episodeLimit: 50
            });

            expect(rows.albums).toBeUndefined();
            expect(seen).toEqual(['/api/v1/artist/4']);
        });
    });
});
