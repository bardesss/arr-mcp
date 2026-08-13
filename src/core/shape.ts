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
 * How many to skip — the other half of `limit`, and the parameter #103 guessed
 * at because a library past `MAX_LIMIT` could not be read in full without it.
 *
 * Unbounded above, unlike `limit`: `limit` caps how much context one answer can
 * spend, which is a real cost, while a large `offset` only means a caller is
 * deep into a list and costs nothing to serve. Capping it would put items past
 * the cap permanently out of reach, which is the bug this parameter exists to
 * fix.
 */
export const OffsetSchema = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
        'How many items to skip before the window `limit` returns — page two of 50 is `offset: 50`. `total` always counts the whole list, so `offset + returned < total` is how you know there is another page. Pair it with `sort` for a stable walk: without one the order is whatever the services returned, and an item can move between pages.'
    );

/**
 * What a read tool tells a client about itself.
 *
 * Without this, all 22 tools are the same kind of thing to a client that
 * decides what to auto-approve, or what to badge, from annotations —
 * `delete_media` and `get_queue` alike. Each description says which it is, but
 * prose is only readable by the model, and the client makes that call before
 * the model is asked.
 *
 * `destructiveHint` is deliberately absent rather than false: the spec defines
 * it as meaningful only when `readOnlyHint` is false, so setting it here would
 * be answering a question nobody asked. `openWorldHint` is likewise left at its
 * default of true, which is already right — every one of these reads reaches a
 * service over the network.
 */
export const READ_ONLY = { readOnlyHint: true } as const;

/**
 * Every tool's arguments, refusing the ones it does not have.
 *
 * A plain `z.object` **strips** unknown keys, which is the quietest possible
 * failure: the call succeeds, the invented argument is gone, and the result
 * looks exactly like one where it had been honoured. #103 is what that costs —
 * an agent sent `offset` and `source` to `get_library`, got a clean 200, and
 * concluded from the unchanged results that this server's pagination and
 * filtering were broken. Neither parameter has ever existed. It never found
 * `limit`, which was the parameter it actually wanted, because nothing in the
 * exchange ever suggested it was looking in the wrong place.
 *
 * So the error names both halves: what was refused, and what this tool does
 * accept. The first alone leaves a model exactly as stuck as silence did — the
 * list is what lets it correct itself in one turn rather than guess again.
 *
 * `undocumented` keeps a key working while leaving it out of that list. Two
 * parameters were frozen at 1.0 under an older spelling and are deliberately
 * described nowhere (see `preferred`); advertising them in an error would teach
 * the old name to every caller who made a typo, which is the one thing keeping
 * them undocumented was for.
 */
export function toolInput<T extends z.ZodRawShape>(
    shape: T,
    opts: { undocumented?: readonly (keyof T & string)[] } = {}
) {
    const hidden = new Set<string>(opts.undocumented ?? []);
    const accepted = Object.keys(shape)
        .filter(k => !hidden.has(k))
        .sort()
        .join(', ');

    return z.strictObject(shape, {
        error: issue =>
            issue.code === 'unrecognized_keys'
                ? `Unknown argument(s): ${issue.keys.join(', ')}. They were refused rather than ignored, because a dropped argument is indistinguishable from one that worked. This tool accepts: ${accepted}.`
                : undefined
    });
}

/**
 * The truncation envelope, declared so a client can read it *before* it calls.
 *
 * #103 reported `total` as missing from `structuredContent`. It was never
 * missing — but no tool declared an `outputSchema`, and a client that gates
 * `structuredContent` on a declared schema surfaces nothing without one, which
 * from the far side is indistinguishable from the field not existing. The
 * reporter fell back to parsing "50 of 243 item(s)" out of the summary
 * sentence, which is prose written for a reader and not a contract.
 *
 * **Loose, and deliberately.** The SDK validates `structuredContent` against
 * this and fails the whole call on a mismatch, so a schema that tried to
 * enumerate every tool's fields would turn a documentation gap into an outage
 * the first time one of them returned something unforeseen. Everything shared
 * is named; `items` and per-tool extras (`ratingCoverage`, `providers`,
 * `recentRejections`) ride through unconstrained. `projectCallToolResult` does
 * not strip to the schema, so nothing is lost by leaving them undeclared.
 *
 * `items` stays `unknown` for the same reason: what an item *is* differs per
 * tool and is described in that tool's own description, where a model reads it.
 */
export const TruncationSchema = z.looseObject({
    items: z.array(z.unknown()).describe('The window of results. What an item carries depends on the tool and on `detail`.'),
    total: z
        .number()
        .int()
        .describe('How many matched in total — the whole list, never the window. Compare against `returned` before reporting a count to anyone.'),
    returned: z.number().int().describe('How many are in `items`.'),
    offset: z.number().int().describe('How many were skipped. `offset + returned < total` means there is another page.'),
    truncated: z
        .boolean()
        .describe('True when this is not the whole list — including on the last page of a paged walk, where the rest is behind you rather than ahead.')
});

/**
 * A whole tool's answer: the truncation envelope plus who failed to answer.
 *
 * Separate from `TruncationSchema` because `stack_health` nests two truncated
 * lists inside one answer and reports `degraded` once, at the top, for both.
 * Requiring it on the inner lists asserted something no tool produces — and,
 * being an output schema, that did not read as a wrong description: it failed
 * the call outright. Which is how the split came to exist.
 */
export const PagedOutputSchema = TruncationSchema.extend({
    degraded: z
        .array(z.string())
        .describe('Services that could not be reached. Their contribution is missing from `items`, so a short list may be an outage rather than an answer.'),
    counts: z.record(z.string(), z.number()).optional().describe('How many results each service contributed.')
});

/**
 * The truncation contract from Silent truncation is how a
 * model confidently reports that a 900-film library contains 50 films, so
 * every read tool routes its list through here and serialises all five fields.
 *
 * `limit` is clamped defensively even though LimitSchema also caps it — a
 * future internal caller that bypasses the schema must not be able to request
 * 5000 items, and must not be able to request zero and get a silently empty
 * list back.
 *
 * `offset` is clamped only at zero, and not at the top: a window past the end
 * is an empty page, which is the honest answer to "give me items 900–950 of
 * 243". A negative one starts at the beginning rather than reaching `slice`,
 * where it would count backwards from the end and hand back the last few items
 * as though they were the first.
 *
 * `truncated` keeps the meaning it had before an offset existed — *this is not
 * the whole list* — rather than becoming "there is more after this window".
 * Under the second reading the last page of a paged walk reports `false` with
 * everything the caller never saw sitting in front of it, which is the same
 * false completeness the field was added to prevent. "Is there another page" is
 * `offset + returned < total`, and every term is in the response.
 */
export function applyLimit<T>(
    items: readonly T[],
    limit: number,
    offset = 0
): { items: T[]; total: number; returned: number; offset: number; truncated: boolean } {
    const effective = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
    const start = Math.max(Math.trunc(offset), 0);
    const sliced = items.slice(start, start + effective);
    return {
        items: sliced,
        total: items.length,
        returned: sliced.length,
        offset: start,
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
