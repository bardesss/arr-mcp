import { describe, expect, it } from 'vitest';
import type { IdentityResolver } from '../src/core/identity.ts';
import { LibraryIndex, type IndexInput } from '../src/core/resolver.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildGetLibrary } from '../src/tools/getLibrary.ts';
import { buildGetMediaDetails } from '../src/tools/getMediaDetails.ts';
import { LibraryLoader } from '../src/tools/library.ts';

/**
 * The two things the review asked for, end to end rather than at the adapter:
 * one row per artist in `get_library`, and the albums under an artist in
 * `get_media_details`. The adapter tests prove the mapping; these prove the
 * tools a caller actually reaches.
 */

const MBID = '056e4f3e-d505-4dad-8ec1-d04f521cbb56';
const OTHER_MBID = 'aa997ea0-2936-40bd-884d-3af8a0e064dc';

const lidarrArtist = (over: Partial<IndexInput> = {}): IndexInput => ({
    kind: 'artist',
    title: 'Daft Punk',
    albumCount: 4,
    ids: { mbid: MBID },
    acquisition: { service: 'lidarr', id: '4', monitored: true, hasFile: true, addedAt: '2026-10-27T04:14:06Z' },
    ...over
});

/** A media server that answers both halves: films and the music read. */
const mediaServer = (music: IndexInput[]): ServiceAdapter =>
    ({
        id: 'jellyfin',
        type: 'jellyfin',
        testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 }),
        getVersion: async () => '10.11.11',
        listUserLibrary: async () => [],
        listUserMusic: async () => music
    }) as unknown as ServiceAdapter;

const lidarr = (rows: IndexInput[]): ServiceAdapter =>
    ({
        id: 'lidarr',
        type: 'lidarr',
        testConnection: async () => ({ ok: true, service: 'lidarr', latency_ms: 1 }),
        getVersion: async () => '2.1.3',
        listLibrary: async () => rows
    }) as unknown as ServiceAdapter;

const identity: IdentityResolver = {
    resolve: async () => ({ id: 'u1', name: 'Someone' }),
    hasDefaultUser: true
} as unknown as IdentityResolver;

const loader = (rows: IndexInput[], music: IndexInput[]) =>
    new LibraryLoader([lidarr(rows), mediaServer(music)], identity);

const serverArtist = (mbid: string): IndexInput => ({
    kind: 'artist',
    title: 'Daft Punk',
    ids: { mbid },
    playback: { user: 'Someone', itemId: 'j-artist-1' }
});

describe('music through get_library', () => {
    it('lists one row per artist, not one per album', async () => {
        const rows = [lidarrArtist(), lidarrArtist({ title: 'Justice', ids: { mbid: OTHER_MBID } })];

        const result = await buildGetLibrary(loader(rows, []), { detail: 'standard', limit: 50 });

        expect(result.items.map(i => i.kind)).toEqual(['artist', 'artist']);
        expect(result.items.map(i => i.title).sort()).toEqual(['Daft Punk', 'Justice']);
    });

    /**
     * The value the review asked for: an artist matched to a media server on the
     * MusicBrainz artist id is `both`, not the `unknown` every music row held
     * before there was a music read.
     */
    it('reports both when the server holds the same artist', async () => {
        const result = await buildGetLibrary(loader([lidarrArtist()], [serverArtist(MBID)]), {
            detail: 'standard',
            limit: 50
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.presence).toBe('both');
        expect(result.items[0]?.playback?.itemId).toBe('j-artist-1');
    });

    it('reports arr_only when the server holds artists but not this one', async () => {
        const result = await buildGetLibrary(loader([lidarrArtist()], [serverArtist(OTHER_MBID)]), {
            detail: 'standard',
            limit: 50
        });

        expect(result.items.map(i => [i.title, i.presence])).toEqual([
            ['Daft Punk', 'arr_only'],
            ['Daft Punk', 'jellyfin_only']
        ]);
    });

    /**
     * A tag mismatch is the failure a user actually hits. The two rows stay
     * apart rather than joining on a title, which is the behaviour the review
     * asked to have documented.
     */
    it('keeps two rows when the MusicBrainz ids differ', async () => {
        const index = LibraryIndex.build([lidarrArtist(), serverArtist(OTHER_MBID)], { musicGathered: true });

        expect(index.size()).toBe(2);
        expect(index.find({ mbid: MBID })?.presence).toBe('arr_only');
        expect(index.find({ mbid: OTHER_MBID })?.presence).toBe('jellyfin_only');
    });
});

describe('music through get_media_details', () => {
    const ALBUM = {
        id: 17,
        title: 'Discovery',
        foreignAlbumId: '48117b90-a16e-34ca-a514-19c702df1158',
        releaseDate: '2001-02-26T00:00:00Z',
        albumType: 'Album',
        monitored: true,
        statistics: { trackFileCount: 14 }
    };
    const detailAdapter = (): ServiceAdapter =>
        ({
            id: 'lidarr',
            type: 'lidarr',
            testConnection: async () => ({ ok: true, service: 'lidarr', latency_ms: 1 }),
            getVersion: async () => '2.1.3',
            listLibrary: async () => [lidarrArtist()],
            getMediaDetails: async (_id: string, opts: { includeEpisodes: boolean; episodeLimit: number }) => ({
                service: 'lidarr',
                kind: 'artist' as const,
                id: '4',
                title: 'Daft Punk',
                ids: { mbid: MBID },
                albumCount: 4,
                ...(opts.includeEpisodes
                    ? {
                          albums: [
                              {
                                  id: String(ALBUM.id),
                                  title: ALBUM.title,
                                  year: 2001,
                                  albumType: ALBUM.albumType,
                                  monitored: true,
                                  hasFile: true,
                                  mbid: ALBUM.foreignAlbumId
                              }
                          ].slice(0, opts.episodeLimit)
                      }
                    : {})
            })
        }) as unknown as ServiceAdapter;

    /** The album id is the whole reason this read exists: it is what a
     *  `level: "album"` write takes, and no library row carries one. */
    it('returns the artist with its albums at detail: full', async () => {
        const details = await buildGetMediaDetails([detailAdapter()], {
            service: 'lidarr',
            id: '4',
            detail: 'full',
            limit: 50
        });

        expect(details).toMatchObject({ kind: 'artist', title: 'Daft Punk', albumCount: 4 });
        expect(details.albums).toEqual([
            {
                id: '17',
                title: 'Discovery',
                year: 2001,
                albumType: 'Album',
                monitored: true,
                hasFile: true,
                mbid: '48117b90-a16e-34ca-a514-19c702df1158'
            }
        ]);
    });

    it('omits the albums below detail: full, as episodes are omitted', async () => {
        const details = await buildGetMediaDetails([detailAdapter()], {
            service: 'lidarr',
            id: '4',
            detail: 'standard',
            limit: 50
        });

        expect(details.albums).toBeUndefined();
        expect(details.title).toBe('Daft Punk');
    });
});
