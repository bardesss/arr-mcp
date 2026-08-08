import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, DetailSchema, LimitSchema, MAX_LIMIT, applyLimit, preferred } from '../src/core/shape.ts';

describe('applyLimit', () => {
    it('reports truncation honestly when the list is longer than the limit', () => {
        const out = applyLimit(
            Array.from({ length: 900 }, (_, i) => i),
            50
        );
        expect(out.returned).toBe(50);
        expect(out.total).toBe(900);
        expect(out.truncated).toBe(true);
    });

    it('reports truncated: false when everything fits', () => {
        const out = applyLimit([1, 2, 3], 50);
        expect(out).toEqual({ items: [1, 2, 3], total: 3, returned: 3, truncated: false });
    });

    it('caps at MAX_LIMIT regardless of what was requested', () => {
        const out = applyLimit(
            Array.from({ length: 2000 }, (_, i) => i),
            9999
        );
        expect(out.returned).toBe(MAX_LIMIT);
        expect(out.truncated).toBe(true);
    });

    it('handles an empty list without claiming truncation', () => {
        expect(applyLimit([], 50)).toEqual({ items: [], total: 0, returned: 0, truncated: false });
    });

    it('clamps a nonsensical limit to at least one item rather than returning nothing', () => {
        const out = applyLimit([1, 2, 3], 0);
        expect(out.returned).toBe(1);
        expect(out.total).toBe(3);
        expect(out.truncated).toBe(true);
    });

    it('returns exactly the boundary case without claiming truncation', () => {
        const out = applyLimit([1, 2, 3], 3);
        expect(out.truncated).toBe(false);
        expect(out.returned).toBe(3);
    });

    it('does not mutate the input array', () => {
        const input = [1, 2, 3, 4];
        applyLimit(input, 2);
        expect(input).toEqual([1, 2, 3, 4]);
    });
});

describe('schemas', () => {
    it('defaults detail to standard', () => {
        expect(DetailSchema.parse(undefined)).toBe('standard');
    });

    it('accepts all three detail levels', () => {
        expect(DetailSchema.parse('minimal')).toBe('minimal');
        expect(DetailSchema.parse('standard')).toBe('standard');
        expect(DetailSchema.parse('full')).toBe('full');
    });

    it('rejects an unknown detail level', () => {
        expect(DetailSchema.safeParse('verbose').success).toBe(false);
    });

    it('defaults limit to 50', () => {
        expect(LimitSchema.parse(undefined)).toBe(DEFAULT_LIMIT);
    });

    it('rejects a limit above the hard maximum at the schema boundary', () => {
        expect(LimitSchema.safeParse(501).success).toBe(false);
    });

    it('accepts the hard maximum itself', () => {
        expect(LimitSchema.parse(MAX_LIMIT)).toBe(MAX_LIMIT);
    });

    it('rejects a non-positive limit', () => {
        expect(LimitSchema.safeParse(0).success).toBe(false);
    });

    it('rejects a fractional limit', () => {
        expect(LimitSchema.safeParse(1.5).success).toBe(false);
    });
});

/**
 * 1.0 froze the tool surface with two names inconsistent: `discover_media`
 * asked for `media_type` in a vocabulary it did not answer in, and
 * `get_library` called a Jellyfin user `watched_by` where two other tools call
 * it `user`. Both keep working forever — removing a spelling breaks a saved
 * prompt silently, which is the failure the freeze exists to prevent.
 */
describe('honouring an older spelling', () => {
    const of = (value?: string, aliasValue?: string) =>
        preferred({ name: 'kind', value, alias: 'media_type', aliasValue });

    it('takes the documented name when only it was given', () => {
        expect(of('series', undefined)).toBe('series');
    });

    it('takes the old spelling when only it was given', () => {
        expect(of(undefined, 'series')).toBe('series');
    });

    it('is undefined when neither was given', () => {
        expect(of(undefined, undefined)).toBeUndefined();
    });

    it('accepts both when they agree, since nothing is ambiguous', () => {
        expect(of('series', 'series')).toBe('series');
    });

    /**
     * Refused rather than resolved. Silently preferring one would make the
     * answer depend on a precedence rule nobody wrote down, and the caller
     * would never learn which half of their request was dropped.
     */
    it('refuses a request that contradicts itself, naming both spellings', () => {
        expect(() => of('movie', 'series')).toThrow(/kind/);
        expect(() => of('movie', 'series')).toThrow(/media_type/);
    });

    /** The alias may speak a different vocabulary — `tv` where the documented
     *  name says `series` — so agreement is judged after translating. */
    it('translates the old vocabulary before comparing', () => {
        const tv = (value?: string, aliasValue?: string) =>
            preferred({
                name: 'kind',
                value,
                alias: 'media_type',
                aliasValue,
                translate: v => (v === 'tv' ? 'series' : v)
            });

        expect(tv(undefined, 'tv')).toBe('series');
        expect(tv('series', 'tv')).toBe('series');
        expect(() => tv('movie', 'tv')).toThrow();
    });
});
