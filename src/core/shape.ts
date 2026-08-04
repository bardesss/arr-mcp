import * as z from 'zod/v4';

export const DETAIL_LEVELS = ['minimal', 'standard', 'full'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export const DetailSchema = z
    .enum(DETAIL_LEVELS)
    .default('standard')
    .describe('How much per-item detail to return. Defaults to standard.');

export const LimitSchema = z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Maximum items to return. Defaults to ${DEFAULT_LIMIT}, hard maximum ${MAX_LIMIT}.`);

/**
 * The truncation contract from design spec §12. Silent truncation is how a
 * model confidently reports that a 900-film library contains 50 films, so
 * every read tool routes its list through here and serialises all four fields.
 *
 * `limit` is clamped defensively even though LimitSchema also caps it — a
 * future internal caller that bypasses the schema must not be able to request
 * 5000 items, and must not be able to request zero and get a silently empty
 * list back.
 */
export function applyLimit<T>(
    items: readonly T[],
    limit: number
): { items: T[]; total: number; returned: number; truncated: boolean } {
    const effective = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
    const sliced = items.slice(0, effective);
    return {
        items: sliced,
        total: items.length,
        returned: sliced.length,
        truncated: sliced.length < items.length
    };
}
