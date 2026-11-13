/**
 * Services write times in different shapes: `...Z`, `...000Z`, a seven-digit
 * fraction with `+00:00`, or another offset. As strings those sort by how they
 * are written, not when they happened, so rows from several services are put
 * in order by instant and adapters hand over `toISOString()` where they can.
 */

/** Milliseconds since the epoch; a time that does not parse sorts as the oldest. */
export const instantOf = (at: string | undefined): number => {
    const t = Date.parse(at ?? '');
    return Number.isFinite(t) ? t : 0;
};

/** For `sort`: the newest `at` first. */
export const newestFirst = (a: { at: string }, b: { at: string }): number => instantOf(b.at) - instantOf(a.at);

/** The same instant as `toISOString()`, or `undefined` when it is not a time. */
export const isoInstant = (at: string | undefined): string | undefined => {
    const t = Date.parse(at ?? '');
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};
