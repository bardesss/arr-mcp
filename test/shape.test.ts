import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, DetailSchema, LimitSchema, MAX_LIMIT, applyLimit } from '../src/core/shape.ts';

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
