import { describe, expect, it } from 'vitest';
import { epochToIso, externalIds, msToSeconds, unwrap } from '../src/services/plex.ts';

describe('MediaContainer envelope', () => {
    it('returns the rows under the named key', () => {
        expect(unwrap({ MediaContainer: { size: 1, Metadata: [{ ratingKey: '1' }] } }, 'Metadata'))
            .toEqual([{ ratingKey: '1' }]);
    });

    it('returns an empty list when the container holds nothing, rather than throwing', () => {
        expect(unwrap({ MediaContainer: { size: 0 } }, 'Metadata')).toEqual([]);
    });

    it('returns an empty list for a body that is not a MediaContainer at all', () => {
        expect(unwrap({}, 'Metadata')).toEqual([]);
        expect(unwrap(null, 'Metadata')).toEqual([]);
    });
});

describe('units', () => {
    // Plex counts milliseconds. Jellyfin counts 100ns ticks. Getting this wrong
    // yields a plausible, wrong percentComplete rather than an obvious break.
    it('converts milliseconds to whole seconds', () => {
        expect(msToSeconds(1_800_000)).toBe(1800);
        expect(msToSeconds(1499)).toBe(1);
    });

    it('passes undefined through rather than producing NaN', () => {
        expect(msToSeconds(undefined)).toBeUndefined();
    });

    it('converts unix epoch seconds to an ISO string, because PlaybackEntry.lastPlayed is consumed as one', () => {
        expect(epochToIso(1_787_000_000)).toBe(new Date(1_787_000_000_000).toISOString());
    });

    it('passes undefined through rather than returning 1970', () => {
        expect(epochToIso(undefined)).toBeUndefined();
    });

    it('treats a literal zero as absent rather than returning the epoch', () => {
        expect(epochToIso(0)).toBeUndefined();
    });
});

describe('external ids — the join with Radarr and Sonarr', () => {
    it('reads the modern Guid array', () => {
        expect(externalIds({ Guid: [{ id: 'imdb://tt0111161' }, { id: 'tmdb://278' }, { id: 'tvdb://12345' }] }))
            .toEqual({ imdb: 'tt0111161', tmdb: 278, tvdb: 12345 });
    });

    it('reads a legacy agent guid string', () => {
        expect(externalIds({ guid: 'com.plexapp.agents.imdb://tt0111161?lang=en' })).toEqual({ imdb: 'tt0111161' });
        expect(externalIds({ guid: 'com.plexapp.agents.themoviedb://278?lang=en' })).toEqual({ tmdb: 278 });
        expect(externalIds({ guid: 'com.plexapp.agents.thetvdb://12345/1/2?lang=en' })).toEqual({ tvdb: 12345 });
    });

    it('prefers the Guid array when both are present', () => {
        expect(externalIds({ guid: 'com.plexapp.agents.imdb://tt999?lang=en', Guid: [{ id: 'tmdb://278' }] }))
            .toEqual({ tmdb: 278 });
    });

    it('returns no ids rather than zero when there is nothing to read', () => {
        expect(externalIds({})).toEqual({});
        expect(externalIds({ guid: 'local://12345' })).toEqual({});
        expect(externalIds({ guid: 'plex://movie/5d7768ba' })).toEqual({});
    });

    // The trap jellyfin.ts numericId and seerr.ts yearOf both document:
    // Number('') is 0 and passes Number.isFinite, so an empty id joined against
    // every other item missing one.
    it('never produces a zero id from an empty value', () => {
        expect(externalIds({ Guid: [{ id: 'tmdb://' }] })).toEqual({});
    });

    it('rejects a non-numeric id rather than coercing it', () => {
        expect(externalIds({ Guid: [{ id: 'tmdb://abc' }] })).toEqual({});
    });

    // Reaches numericId with an empty string: the capture is non-empty ("/x") so the
    // regex matches, but the first path segment is empty. This is the input the
    // digit-only guard actually exists for.
    it('rejects an id whose first path segment is empty', () => {
        expect(externalIds({ Guid: [{ id: 'tmdb:///x' }] })).toEqual({});
    });
});
