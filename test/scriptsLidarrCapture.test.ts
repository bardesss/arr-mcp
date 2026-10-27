import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    anonymiseLidarrAlbum,
    anonymiseLidarrArtist,
    anonymiseLidarrBlocklistRow,
    anonymiseLidarrHistoryRow,
    anonymiseLidarrMembers,
    anonymiseLidarrQueueRow,
    lidarrAlbumPath,
    lidarrArtistDetailPath,
    lidarrCalendarPath,
    lidarrReleasePath,
    LIDARR_STATIC_PATHS
} from '../scripts/lib/lidarrCapture.ts';
import { ANONYMOUS_URL } from '../scripts/lib/redact.ts';

/**
 * Lidarr capture paths and scrubbers, checked against the vendored OpenAPI
 * document rather than against anyone's memory of it. A field the API does not
 * have scrubs nothing and still reads as coverage.
 */
const ROOT = join(import.meta.dirname, '..');
const spec = JSON.parse(readFileSync(join(ROOT, 'specs/lidarr.json'), 'utf8')) as {
    paths: Record<string, { get?: unknown }>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

/** `/api/v1/queue?includeUnknownArtistItems=true` -> `/api/v1/queue` */
const withoutQuery = (path: string): string => path.split('?')[0] ?? path;

/** The declared properties of one component schema, or an empty object. */
const propsOf = (name: string): Record<string, unknown> => spec.components.schemas[name]?.properties ?? {};

describe('Lidarr capture paths against the vendored spec', () => {
    for (const [name, path] of Object.entries(LIDARR_STATIC_PATHS)) {
        it(`${name} is a GET the spec publishes`, () => {
            expect(spec.paths[withoutQuery(path)]?.get, `${path} has no GET in specs/lidarr.json`).toBeDefined();
        });
    }

    it('names no path outside /api/v1', () => {
        const offenders = Object.entries(LIDARR_STATIC_PATHS).filter(([, p]) => !withoutQuery(p).startsWith('/api/v1/'));
        expect(offenders).toEqual([]);
    });

    it('builds the three id-derived paths on spec routes', () => {
        expect(spec.paths['/api/v1/artist/{id}']?.get).toBeDefined();
        expect(lidarrArtistDetailPath(7)).toBe('/api/v1/artist/7');
        expect(withoutQuery(lidarrAlbumPath(7))).toBe('/api/v1/album');
        expect(spec.paths['/api/v1/album']?.get).toBeDefined();
        expect(withoutQuery(lidarrReleasePath(9))).toBe('/api/v1/release');
        expect(spec.paths['/api/v1/release']?.get).toBeDefined();
    });

    /**
     * An unknown query parameter is not an error: Lidarr ignores it and answers
     * 200 with a differently-filtered body, so the fixture looks populated and
     * describes the wrong thing.
     */
    it('uses only query parameters the route declares', () => {
        const declared = (path: string): Set<string> =>
            new Set(((spec.paths[path]?.get as { parameters?: { name: string }[] } | undefined)?.parameters ?? []).map(p => p.name));

        const all: readonly (readonly [string, string])[] = [
            ...Object.entries(LIDARR_STATIC_PATHS),
            ['artist-detail', lidarrArtistDetailPath(1)],
            ['album', lidarrAlbumPath(1)],
            ['release', lidarrReleasePath(1)],
            ['calendar', lidarrCalendarPath([{ releaseDate: '2013-05-17T00:00:00Z' }])]
        ];

        for (const [name, path] of all) {
            const [, query] = path.split('?');
            if (query === undefined) continue;
            for (const pair of query.split('&')) {
                const key = pair.split('=')[0] ?? '';
                expect(declared(withoutQuery(path)).has(key), `${name}: ${key} is not a parameter of ${withoutQuery(path)}`).toBe(true);
            }
        }
    });

    it('spans the library\'s own release dates', () => {
        const path = lidarrCalendarPath([
            { releaseDate: '2013-05-17T00:00:00Z' },
            { releaseDate: '1997-03-20T00:00:00Z' },
            { releaseDate: null },
            {}
        ]);
        expect(path).toBe('/api/v1/calendar?start=1997-03-19&end=2013-05-18');
    });

    it('falls back to a today-relative window when nothing has a date', () => {
        const path = lidarrCalendarPath([{}, { releaseDate: 'not a date' }]);
        const [, query] = path.split('?');
        const params = new URLSearchParams(query);
        const start = Date.parse(`${params.get('start')}T00:00:00Z`);
        const end = Date.parse(`${params.get('end')}T00:00:00Z`);
        const today = Date.now();
        expect(start).toBeLessThan(today);
        expect(end).toBeGreaterThan(today);
        expect(end - start).toBeGreaterThan(500 * 86_400_000);
    });

    it('handles a single album without collapsing the window to a day', () => {
        expect(lidarrCalendarPath([{ releaseDate: '2020-01-15T00:00:00Z' }]))
            .toBe('/api/v1/calendar?start=2020-01-14&end=2020-01-16');
    });

    it('asks the queue for the nested artist and album it scrubs', () => {
        expect(LIDARR_STATIC_PATHS.queue).toContain('includeArtist=true');
        expect(LIDARR_STATIC_PATHS.queue).toContain('includeAlbum=true');
    });

    /**
     * The checks above only reach paths held in `LIDARR_STATIC_PATHS`, so a
     * literal added to the `lidarr` block of `capture-fixtures.ts` would bypass
     * the spec entirely. That file cannot be imported, so this reads it.
     */
    it('leaves no literal path in the capture script', () => {
        const source = readFileSync(join(ROOT, 'scripts/capture-fixtures.ts'), 'utf8');
        const start = source.indexOf('\n    lidarr: [');
        const end = source.indexOf('\n    prowlarr: [');
        expect(start, 'no `lidarr: [` block in scripts/capture-fixtures.ts').toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);

        const block = source.slice(start, end);
        expect(block.match(/\/api\//g) ?? []).toEqual([]);
    });
});

describe('Lidarr scrubbers only touch fields the spec has', () => {
    /** Without this the negative assertions below pass vacuously on a typo. */
    it('names schemas the spec actually publishes', () => {
        for (const name of ['ArtistStatisticsResource', 'AlbumResource', 'BlocklistResource', 'ArtistResource', 'HistoryResource']) {
            expect(Object.keys(propsOf(name)).length, `${name} is absent from specs/lidarr.json`).toBeGreaterThan(0);
        }
    });
    /** A scrubber must not add a key the response did not carry. */
    const preservesKeys = (input: Record<string, unknown>, out: Record<string, unknown>, label: string): void => {
        expect(Object.keys(out).sort(), `${label} added or dropped a key`).toEqual(Object.keys(input).sort());
    };

    const ARTIST = {
        id: 1,
        artistName: 'A Real Artist',
        mbId: '8ca44714-4ec0-46c9-a379-9056e3dbf2a2',
        path: '/mnt/music/A Real Artist',
        rootFolderPath: '/mnt/music',
        remotePoster: 'https://raw.githubusercontent.com/Lidarr/a-real-artist.jpg',
        images: [{ url: '/MediaCover/1/poster.jpg', remoteUrl: 'https://coverartarchive.org/a-real-artist' }],
        members: [
            { name: 'A Real Person', instrument: 'guitar', images: [{ url: '/MediaCover/2/cover.jpg' }] },
            { name: 'Another Person', instrument: 'vocals', images: [] }
        ],
        statistics: { albumCount: 4, trackFileCount: 90, percentOfTracks: 100 }
    };

    const ALBUM = {
        id: 2,
        title: 'A Real Album',
        remoteCover: 'https://coverartarchive.org/a-real-album',
        images: [{ url: '/MediaCover/3/front.jpg', remoteUrl: 'https://coverartarchive.org/a-real-album' }],
        statistics: { trackFileCount: 12, trackCount: 12 }
    };

    it('replaces the artist cover URLs and the lineup, and nothing else', () => {
        const out = anonymiseLidarrArtist(ARTIST);

        preservesKeys(ARTIST, out, 'artist');
        expect(out.artistName).toBe('A Real Artist');
        expect(out.mbId).toBe(ARTIST.mbId);
        expect(out.path).toBe('/mnt/music/A Real Artist');
        expect(out.remotePoster).not.toContain('a-real-artist');
        expect(out.images).toEqual([{ url: '/MediaCover/1/poster.jpg', remoteUrl: 'https://indexer.example.test/' }]);
        expect(out.statistics).toEqual(ARTIST.statistics);
    });

    it('names every member and scrubs the images each one carries', () => {
        const members = anonymiseLidarrMembers(ARTIST.members) as Record<string, unknown>[];
        const urls = (m: Record<string, unknown>) => (m.images as { url?: string }[]).map(i => i.url);

        expect(members.map(m => m.name)).toEqual(['Member 1', 'Member 2']);
        expect(members.map(m => m.instrument)).toEqual(['Instrument 1', 'Instrument 2']);
        expect(members.map(urls)).toEqual([['/MediaCover/1/poster.jpg'], []]);
    });

    it('leaves statistics alone, because Lidarr has no releaseGroups to scrub', () => {
        expect(propsOf('ArtistStatisticsResource')).not.toHaveProperty('releaseGroups');
        expect(anonymiseLidarrArtist(ARTIST).statistics).toEqual(ARTIST.statistics);
    });

    it('replaces the album cover URL and keeps the title', () => {
        const out = anonymiseLidarrAlbum(ALBUM);

        preservesKeys(ALBUM, out, 'album');
        expect(out.title).toBe('A Real Album');
        expect(out.remoteCover).not.toContain('a-real-album');
        expect(out.statistics).toEqual(ALBUM.statistics);
    });

    it('does not reach for a remoteThumbnail, which Lidarr never sends', () => {
        expect(propsOf('AlbumResource')).not.toHaveProperty('remoteThumbnail');
        expect(anonymiseLidarrAlbum(ALBUM)).not.toHaveProperty('remoteThumbnail');
    });

    it('scrubs the artist and album nested in a queue row', () => {
        const row = { id: 3, title: 'A Real Artist - A Real Album', outputPath: '/mnt/music/x', artist: ARTIST, album: ALBUM };
        const out = anonymiseLidarrQueueRow(row);

        preservesKeys(row, out, 'queue row');
        expect(out.title).toBe('A Real Artist - A Real Album');
        expect(
            ((out.artist as Record<string, unknown>).members as Record<string, unknown>[]).map(m => m.name)
        ).toEqual(['Member 1', 'Member 2']);
    });

    /**
     * `lastAlbum` and `nextAlbum` are whole albums, and each carries an artist
     * again. A scrub that stopped at the top level left both cover URLs in the
     * committed fixtures.
     */
    it('reaches the album and artist nested in an artist row', () => {
        const row = { ...ARTIST, lastAlbum: { ...ALBUM, artist: ARTIST }, nextAlbum: null };
        const out = anonymiseLidarrArtist(row);
        const album = out.lastAlbum as Record<string, unknown>;

        preservesKeys(row, out, 'artist with albums');
        expect(album.title).toBe('A Real Album');
        expect(album.remoteCover).toBe(ANONYMOUS_URL);
        expect(album.images).toEqual([{ url: '/MediaCover/1/poster.jpg', remoteUrl: ANONYMOUS_URL }]);
        expect((album.artist as Record<string, unknown>).remotePoster).toBe(ANONYMOUS_URL);
        expect(out.nextAlbum).toBeNull();
    });

    it('scrubs the artist nested in an album row', () => {
        const row = { ...ALBUM, artist: ARTIST };
        const out = anonymiseLidarrAlbum(row);

        preservesKeys(row, out, 'album with artist');
        expect((out.artist as Record<string, unknown>).remotePoster).toBe(ANONYMOUS_URL);
    });

    it('reaches the artist nested inside a history row, which a queue scrub would miss', () => {
        const row = {
            id: 4,
            sourceTitle: 'A.Real.Artist.-.A.Real.Album',
            artist: ARTIST,
            album: ALBUM,
            track: { id: 5, title: 'A Real Song', artist: ARTIST, trackFile: { path: '/mnt/music/x.flac' } }
        };
        const out = anonymiseLidarrHistoryRow(row);

        preservesKeys(row, out, 'history row');
        const track = out.track as Record<string, unknown>;
        expect(track.title).toBe('A Real Song');
        expect(
            ((track.artist as Record<string, unknown>).members as Record<string, unknown>[]).map(m => m.name)
        ).toEqual(['Member 1', 'Member 2']);
    });

    it('does not invent an album on a blocklist row, which carries only albumIds', () => {
        expect(propsOf('BlocklistResource')).not.toHaveProperty('album');
        expect(propsOf('BlocklistResource')).toHaveProperty('albumIds');

        const row = { id: 6, sourceTitle: 'A.Real.Artist', albumIds: [2], artist: ARTIST };
        const out = anonymiseLidarrBlocklistRow(row);

        preservesKeys(row, out, 'blocklist row');
        expect(out.albumIds).toEqual([2]);
        expect((out.artist as Record<string, unknown>).remotePoster).not.toContain('a-real-artist');
    });

    it('is a no-op on a row with none of the scrubbed fields', () => {
        const bare = { id: 7, artistName: 'x' };
        expect(anonymiseLidarrArtist(bare)).toEqual(bare);
        expect(anonymiseLidarrAlbum(bare)).toEqual(bare);
        expect(anonymiseLidarrQueueRow(bare)).toEqual(bare);
        expect(anonymiseLidarrBlocklistRow(bare)).toEqual(bare);
        expect(anonymiseLidarrHistoryRow(bare)).toEqual(bare);
    });
});

/**
 * The fixture policy, read back off what was committed. A cover field is either
 * the placeholder or absent, at every depth — which is what a scrub that missed
 * a nesting level broke.
 */
describe('the committed Lidarr fixtures', () => {
    const COVER_FIELD = /"(?:remoteUrl|remotePoster|remoteCover)":\s*"([^"]*)"/g;

    it('hold no cover URL that is not the placeholder', () => {
        const offenders: string[] = [];
        for (const file of readdirSync(join(ROOT, 'test/fixtures/lidarr'))) {
            const body = readFileSync(join(ROOT, 'test/fixtures/lidarr', file), 'utf8');
            for (const [, url] of body.matchAll(COVER_FIELD)) {
                if (url !== ANONYMOUS_URL) offenders.push(`${file}: ${url}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
