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

/**
 * **Sonarr's shape is not Radarr's**, resolved against a live Sonarr 4.0.19
 * during the Phase 2 capture run — which is what §21.2 had been waiting for.
 *
 * Radarr:  `{ tmdb: { votes, value, type }, imdb: {...}, … }` — per source.
 * Sonarr:  `{ votes: 164018, value: 8.3 }` — one flat rating, no source key.
 *
 * Passing Sonarr's through `flattenRatings` treats `votes` and `value` as
 * *source names*, reporting a rating source called "votes" worth 164018. The
 * single rating is labelled `tvdb` because that is where Sonarr sources series
 * metadata from — design spec §7 relies on the same fact when it excludes a
 * direct TVDB client as duplicated effort.
 */
export function flattenSeriesRating(raw: RawRating | undefined): Record<string, number> | undefined {
    if (typeof raw?.value !== 'number' || raw.value <= 0) return undefined;
    return { tvdb: raw.value };
}
