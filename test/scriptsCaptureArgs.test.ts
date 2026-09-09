import { describe, expect, it } from 'vitest';
import { parseServiceFilter } from '../scripts/lib/captureArgs.ts';

/**
 * `npm run capture` rewrites every fixture for every service the config holds.
 * That is right for a maintainer refreshing the set, and wrong for a volunteer
 * capturing one service: they get a diff touching services they were never
 * asked about, carrying their own data, and have to know which files to throw
 * away. The filter is what makes "capture Plex for us" a safe thing to ask of
 * someone.
 */
describe('parseServiceFilter', () => {
    it('captures everything when no service is named, which is the maintainer refresh', () => {
        expect(parseServiceFilter([])).toBeUndefined();
    });

    it('narrows to one named service', () => {
        expect(parseServiceFilter(['plex'])).toEqual(['plex']);
    });

    it('accepts more than one', () => {
        expect(parseServiceFilter(['plex', 'jellyfin'])).toEqual(['plex', 'jellyfin']);
    });

    /**
     * A typo must not look like a successful run that captured nothing. The
     * script writes no file in that case, so a silent empty selection reads as
     * "my server returned nothing" rather than "you misspelled it".
     */
    it('refuses an unknown service rather than capturing nothing', () => {
        expect(() => parseServiceFilter(['plexx'])).toThrow(/plexx/);
    });

    it('names what is valid, so the message is actionable', () => {
        expect(() => parseServiceFilter(['plexx'])).toThrow(/plex/);
    });
});
