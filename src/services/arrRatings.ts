export type RawRating = { value?: number; votes?: number };

/**
 * Design spec §21.2 resolved this against a live Radarr: the shape is
 * `{ <source>: { votes, value, type } }` with five sources — tmdb, trakt,
 * imdb, metacritic, rottenTomatoes — and **partial coverage**. Only 73% of
 * films carry an IMDb rating.
 *
 * Flattened to `source → value`. A missing source is absent rather than zero,
 * because zero reads as "rated 0.0" to a model, and a source present with
 * value 0 means "not rated" rather than "rated nothing".
 */
export function flattenRatings(raw: Record<string, RawRating> | undefined): Record<string, number> | undefined {
    if (raw === undefined) return undefined;

    const out: Record<string, number> = {};
    for (const [source, rating] of Object.entries(raw)) {
        if (typeof rating?.value === 'number' && rating.value > 0) out[source] = rating.value;
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
