import { describe, expect, it } from 'vitest';
import { firstRatingKeyWithPart } from '../scripts/lib/plexCapture.ts';

const container = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

/**
 * The tester's TV section listed a `show` row first — `type: show`, no
 * `Media`/`Part`/`file` at all — with a file-bearing episode further down the
 * same page. A fixture built from the first row alone never exercises
 * `getMediaDetails`'s `Media[0].Part[0].file`/`.size` mapping. See G3.
 */
describe('firstRatingKeyWithPart', () => {
    it('picks the first row that carries a Media/Part over an earlier row that does not', () => {
        const body = container([
            { ratingKey: '211802', type: 'show' },
            { ratingKey: '211900', type: 'episode', Media: [{ Part: [{ file: '/media/tv/x.mkv', size: 123 }] }] }
        ]);
        expect(firstRatingKeyWithPart(body)).toBe('211900');
    });

    it('falls back to the first row when nothing carries a Part', () => {
        const body = container([{ ratingKey: '1', type: 'show' }, { ratingKey: '2', type: 'show' }]);
        expect(firstRatingKeyWithPart(body)).toBe('1');
    });

    it('treats an empty Part array the same as no Part at all', () => {
        const body = container([
            { ratingKey: '1', Media: [{ Part: [] }] },
            { ratingKey: '2', Media: [{ Part: [{ file: '/x.mkv' }] }] }
        ]);
        expect(firstRatingKeyWithPart(body)).toBe('2');
    });

    it('returns undefined when the fixture carries no rows at all', () => {
        expect(firstRatingKeyWithPart(container([]))).toBeUndefined();
    });

    it('returns undefined on a body with no MediaContainer.Metadata', () => {
        expect(firstRatingKeyWithPart({ MediaContainer: {} })).toBeUndefined();
    });
});
