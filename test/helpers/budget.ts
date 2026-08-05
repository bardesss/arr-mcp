import { expect } from 'vitest';

/**
 * Design spec §17 asks for a token budget per tool response, so §12's shaping
 * discipline is mechanical rather than aspirational.
 *
 * Every tokenizer is a proxy here — each client model tokenizes differently —
 * so this uses serialized bytes with a documented ratio rather than a
 * multi-megabyte dependency that looks precise and is not. What matters is
 * that the number is stable and that a shaping regression makes it jump.
 */
export const BYTES_PER_TOKEN = 4;

export function estimateTokens(payload: unknown): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8') / BYTES_PER_TOKEN);
}

export function expectWithinBudget(payload: unknown, maxTokens: number): void {
    const actual = estimateTokens(payload);
    expect(
        actual,
        `serialized response is ~${actual} tokens, over the ${maxTokens} budget. ` +
            'Shape the response rather than raising the budget.'
    ).toBeLessThanOrEqual(maxTokens);
}
