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
 * The truncation contract from Silent truncation is how a
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

/**
 * The documented name's value, honouring an older spelling that still works.
 *
 * 1.0 froze the tool surface, and two names were inconsistent when it was
 * frozen: `discover_media` asked for `media_type` in a vocabulary it did not
 * answer in, and `get_library` called a Jellyfin user `watched_by` where two
 * other tools call it `user`. Both old spellings keep working forever and stop
 * being documented — removing one would break a saved prompt silently, which is
 * exactly the failure freezing the surface exists to prevent.
 *
 * Disagreeing values are refused rather than resolved. Preferring one silently
 * would make the answer depend on a precedence rule nobody wrote down, and the
 * caller would never learn which half of their request was dropped.
 *
 * Shared rather than written twice, because two hand-rolled copies is how the
 * two ends up behaving differently before anyone notices.
 */
export function preferred<T>(opts: {
    name: string;
    value: T | undefined;
    alias: string;
    aliasValue: T | undefined;
    /** Maps the alias's vocabulary onto the documented one, where they differ —
     *  `media_type: 'tv'` means the same as `kind: 'series'`. */
    translate?: (value: T) => T;
}): T | undefined {
    const translate = opts.translate ?? ((value: T) => value);
    const fromAlias = opts.aliasValue === undefined ? undefined : translate(opts.aliasValue);

    if (opts.value !== undefined && fromAlias !== undefined && opts.value !== fromAlias) {
        throw new Error(
            `\`${opts.name}\` and \`${opts.alias}\` were both given and contradict each other. They are the same setting — \`${opts.alias}\` is the older spelling, kept working but no longer documented. Send one.`
        );
    }

    return opts.value ?? fromAlias;
}
