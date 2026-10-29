import { describe, expect, it } from 'vitest';
import { MEDIA_ID_FIELD, mediaIdOf, mediaIdsParam, protocolName } from '../src/services/arrRecord.ts';

/**
 * The row helpers the queue, history and blocklist share. Each read used to
 * pick its media id its own way; one table now decides it for all three.
 */

describe('mediaIdOf', () => {
    const row = { movieId: 1, seriesId: 2, artistId: 3 };

    it('reads the field for the kind and no other', () => {
        expect([mediaIdOf(row, 'movie'), mediaIdOf(row, 'series'), mediaIdOf(row, 'artist')]).toEqual([1, 2, 3]);
        // A Radarr row read as a Lidarr one has no artist, rather than taking
        // the movie's id for one.
        expect(mediaIdOf({ movieId: 1 }, 'artist')).toBeUndefined();
    });

    it('reads a serialised null as no id', () => {
        // The generated spec types these as `number | null`.
        expect(mediaIdOf({ artistId: null }, 'artist')).toBeUndefined();
        expect(mediaIdOf({}, 'movie')).toBeUndefined();
    });

    it('keeps an id of 0, which is an id', () => {
        expect(mediaIdOf({ seriesId: 0 }, 'series')).toBe(0);
    });
});

describe('mediaIdsParam', () => {
    it('is the field plus `s`, the filter history takes', () => {
        expect(['movie', 'series', 'artist'].map(k => mediaIdsParam(k as keyof typeof MEDIA_ID_FIELD))).toEqual([
            'movieIds',
            'seriesIds',
            'artistIds'
        ]);
    });
});

describe('protocolName', () => {
    it('maps Lidarr 3.1.6 class names back and passes anything else through', () => {
        expect(protocolName('UsenetDownloadProtocol')).toBe('usenet');
        expect(protocolName('TorrentDownloadProtocol')).toBe('torrent');
        expect(protocolName('usenet')).toBe('usenet');
        expect(protocolName('somethingElse')).toBe('somethingElse');
    });
});
