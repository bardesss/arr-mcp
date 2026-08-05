import { describe, expect, it } from 'vitest';
import { repeat } from './helpers/bigFixture.ts';
import { BYTES_PER_TOKEN, estimateTokens, expectWithinBudget } from './helpers/budget.ts';

describe('estimateTokens', () => {
    it('estimates from serialized byte length', () => {
        expect(estimateTokens({ a: 'bc' })).toBe(Math.ceil('{"a":"bc"}'.length / BYTES_PER_TOKEN));
    });

    it('counts multi-byte characters by their encoded size, not their code points', () => {
        // A model pays for bytes, not for how short the string looks.
        expect(estimateTokens({ t: '日本語' })).toBeGreaterThan(estimateTokens({ t: 'abc' }));
    });
});

describe('expectWithinBudget', () => {
    it('passes a payload under budget', () => {
        expect(() => expectWithinBudget({ a: 1 }, 100)).not.toThrow();
    });

    it('fails a payload over budget and reports both numbers', () => {
        expect(() => expectWithinBudget({ a: 'x'.repeat(10_000) }, 100)).toThrow(/over the 100 budget/);
    });
});

describe('repeat', () => {
    it('produces independent copies, so a mutation in one does not alter the rest', () => {
        const items = repeat({ nested: { n: 1 } }, 3);
        items[0]!.nested.n = 99;
        expect(items[1]!.nested.n).toBe(1);
    });

    it('produces the requested count', () => {
        expect(repeat({ a: 1 }, 500)).toHaveLength(500);
    });
});
