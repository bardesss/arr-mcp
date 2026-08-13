import type { MergedRatings } from '../core/resolver.ts';

export type RawRating = { value?: number; votes?: number };

/**
 * Design spec resolved this against a live Radarr: the shape is
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
 * during a live capture — which is what had been waiting for.
 *
 * Radarr: `{ tmdb: { votes, value, type }, imdb: {...}, … }` — per source.
 * Sonarr: `{ votes: 164018, value: 8.3 }` — one flat rating, no source key.
 *
 * Passing Sonarr's through `flattenRatings` treats `votes` and `value` as
 * *source names*, reporting a rating source called "votes" worth 164018. The
 * single rating is labelled `tvdb` because that is where Sonarr sources its
 * series metadata from.
 */
export function flattenSeriesRating(raw: RawRating | undefined): Record<string, number> | undefined {
    if (typeof raw?.value !== 'number' || raw.value <= 0) return undefined;
    return { tvdb: raw.value };
}

/**
 * The sources names. Anything else an *arr invents is dropped rather than
 * carried.
 *
 * `tvdb` is deliberately absent. Sonarr's rating is flat — `{ votes, value }`,
 * no source key — and is read via `flattenSeriesRating`, never through this
 * function; `Sonarr.listLibrary` builds `{ tvdb: raw.tvdb }` by hand instead of
 * calling `toMergedRatings`. Adding `tvdb` here would look like the fix that
 * lets Sonarr's mapping "simplify" to reuse this function, but Radarr's
 * per-source `Record<string, number>` and Sonarr's single flat value are not
 * the same shape — routing the latter through `KNOWN`'s allowlist would look
 * up a `tvdb` key that was never in the flattened record, and return
 * `undefined` for every series rating, silently.
 */
const KNOWN = ['imdb', 'tmdb', 'rottenTomatoes', 'trakt', 'metacritic'] as const;

/**
 * `flattenRatings` produces `Record<string, number>` because that is what
 * `MediaDetails` has carried. The merged record uses named
 * sources instead, so an unknown source name cannot survive into a filter that
 * would then match nothing.
 */
export function toMergedRatings(flat: Record<string, number> | undefined): MergedRatings | undefined {
    if (flat === undefined) return undefined;

    const out: MergedRatings = {};
    for (const key of KNOWN) {
        const value = flat[key];
        if (typeof value === 'number') out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
