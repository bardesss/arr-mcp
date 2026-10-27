import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { hasDiskSpace, hasLibrary, hasQueue, hasSearch, hasWanted } from '../src/services/types.ts';

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
    it('claims library reads and nothing else', () => {
        const a = adapter({});
        const own = Object.getOwnPropertyNames(LidarrAdapter.prototype).filter(name => name !== 'constructor');

        expect(own.sort()).toEqual(['getVersion', 'invalidateLibrary', 'listLibrary', 'search', 'testConnection']);
        expect(hasLibrary(a)).toBe(true);
        expect(hasSearch(a)).toBe(true);
        expect(hasQueue(a)).toBe(false);
        expect(hasDiskSpace(a)).toBe(false);
        expect(hasWanted(a)).toBe(false);
    });

    describe('search', () => {
        const ALBUM = {
            id: 1,
            title: 'Discovery',
            foreignAlbumId: '48117b90-a16e-34ca-a514-19c702df1158',
            releaseDate: '2001-02-26T00:00:00Z',
            monitored: true,
            statistics: { trackFileCount: 14, trackCount: 14 },
            artist: { artistName: 'Daft Punk' }
        };

        it('finds an album by title and by artist', async () => {
            const a = adapter({ '/api/v1/album': [ALBUM] });

            expect((await a.search('discover', 'library')).map(h => h.kind)).toEqual(['album']);
            expect(await a.search('daft punk', 'library')).toHaveLength(1);
            expect(await a.search('homework', 'library')).toEqual([]);
        });

        it('answers nothing for a source it cannot serve', async () => {
            // No lookup call either: an artist-to-add is not an album, and
            // nothing here can add music anyway.
            const seen: string[] = [];
            const a = adapter({ '/api/v1/album': [ALBUM] }, seen);

            expect(await a.search('daft punk', 'discover')).toEqual([]);
            expect(seen).toEqual([]);
        });

        it('carries the id a follow-up call needs', async () => {
            const [hit] = await adapter({ '/api/v1/album': [ALBUM] }).search('discovery', 'library');

            expect(hit).toMatchObject({
                service: 'lidarr',
                source: 'library',
                id: '1',
                year: 2001,
                ids: { mbid: '48117b90-a16e-34ca-a514-19c702df1158' },
                hasFile: true,
                monitored: true
            });
            expect(unfenced(hit?.title ?? '')).toBe('Discovery');
        });
    });

    describe('listLibrary', () => {
        const ALBUM = {
            id: 4,
            title: 'Random Access Memories',
            foreignAlbumId: 'aa997ea0-2936-40bd-884d-3af8a0e064dc',
            releaseDate: '2013-05-17T00:00:00Z',
            albumType: 'Album',
            monitored: true,
            genres: ['Electronic', 'Disco'],
            statistics: { trackFileCount: 0, trackCount: 13, sizeOnDisk: 0 },
            artist: { artistName: 'Daft Punk', qualityProfileId: 1, path: '/music/Daft Punk' }
        };
        const PROFILES = [{ id: 1, name: 'Lossless' }];

        it('maps an album to a library row', async () => {
            const seen: string[] = [];
            const rows = await adapter(
                { '/api/v1/album': [ALBUM], '/api/v1/qualityprofile': PROFILES },
                seen
            ).listLibrary();

            expect(seen).toEqual(['/api/v1/album', '/api/v1/qualityprofile']);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                kind: 'album',
                year: 2013,
                // The album's own MusicBrainz id, and no integer ids invented
                // from the internal `id`.
                ids: { mbid: 'aa997ea0-2936-40bd-884d-3af8a0e064dc' },
                acquisition: {
                    service: 'lidarr',
                    id: '4',
                    status: 'Album',
                    monitored: true,
                    hasFile: false,
                    qualityProfileId: 1,
                    sizeBytes: 0
                }
            });
            expect(unfenced(rows[0]?.title ?? '')).toBe('Random Access Memories');
            expect(unfenced(rows[0]?.artist ?? '')).toBe('Daft Punk');
            // `readQualityProfiles` fences the name itself, as it does for
            // Radarr and Sonarr.
            expect(unfenced(rows[0]?.acquisition?.qualityProfile ?? '')).toBe('Lossless');
        });

        it('fences every string it takes from the service', async () => {
            const rows = await adapter({ '/api/v1/album': [ALBUM] }).listLibrary();

            expect(rows[0]?.title.startsWith('<<untrusted:lidarr.title>>')).toBe(true);
            expect(rows[0]?.artist?.startsWith('<<untrusted:lidarr.artist>>')).toBe(true);
            expect(rows[0]?.genres?.[0]?.startsWith('<<untrusted:lidarr.genre>>')).toBe(true);
            expect(rows[0]?.acquisition?.path?.startsWith('<<untrusted:lidarr.path>>')).toBe(true);
        });

        it('reports a file once any track is on disk', async () => {
            const partial = { ...ALBUM, statistics: { trackFileCount: 5, trackCount: 13, sizeOnDisk: 900 } };
            const [row] = await adapter({ '/api/v1/album': [partial] }).listLibrary();

            expect(row?.acquisition?.hasFile).toBe(true);
            expect(row?.acquisition?.sizeBytes).toBe(900);
        });

        it('keeps the profile id when the profile list cannot be read', async () => {
            const [row] = await adapter({ '/api/v1/album': [ALBUM] }).listLibrary();

            expect(row?.acquisition?.qualityProfileId).toBe(1);
            expect(row?.acquisition?.qualityProfile).toBeUndefined();
        });

        it('omits what the row did not carry rather than inventing it', async () => {
            const bare = { id: 9, monitored: false };
            const [row] = await adapter({ '/api/v1/album': [bare] }).listLibrary();

            expect(row).toMatchObject({ kind: 'album', ids: {}, acquisition: { monitored: false, hasFile: false } });
            expect(row?.title).toBe('');
            expect(row?.artist).toBeUndefined();
            expect(row?.year).toBeUndefined();
            expect(row?.genres).toBeUndefined();
        });
    });
});
