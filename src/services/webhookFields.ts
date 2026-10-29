/**
 * Values read from a webhook body, shared by the parsers. A body is only as
 * trusted as whoever holds the secret, and the senders disagree on types: the
 * Jellyfin Webhook plugin sends every value as a string, Plex sends a number
 * as a number.
 */

/** A string, or a number as one, trimmed; `undefined` when empty or anything else. */
export const text = (v: unknown): string | undefined => {
    if (typeof v === 'number') return String(v);
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
};

/** A whole number, sent as a number or as digits. */
export const whole = (v: unknown): number | undefined => {
    const t = text(v);
    return t !== undefined && /^\d+$/.test(t) ? Number(t) : undefined;
};

/** An imdb id: `tt` and digits. */
export const IMDB_ID = /^tt\d+$/;
