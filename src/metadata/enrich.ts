import type { ImdbDataset } from './imdbDataset.ts';

/**
 * Filling IMDb ratings from the dataset (0.8 spec §4.1).
 *
 * Here rather than in `src/tools/` so nothing in the tool layer imports the
 * store: `LibraryLoader` takes one function, not a database.
 *
 * **Never overwrites.** A service is the authority on its own data; the
 * dataset fills gaps. An item with no IMDb id, or one the dataset does not
 * know, comes back untouched and is counted as unrated downstream — a miss
 * must never become a zero, which would rank an unknown title below one
 * genuinely rated 1.0.
 *
 * **One batched query per page**, not one per item: enriching a 900-film
 * library item by item is 900 statements for something SQLite answers in one.
 */

/**
 * Everything this can fill, described by the two fields it actually needs.
 *
 * Structural rather than a union of the three named types, because they
 * genuinely differ elsewhere: `MergedItem.ratings` is `MergedRatings`, while
 * `SearchHit.ratings` and `MediaDetails.ratings` are `Record<string, number>`,
 * and `IndexInput` is a `MergedItem` without `presence`. All four agree on the
 * only part that matters here — an optional imdb id and an optional imdb
 * rating — so one constraint covers them without asserting anything false
 * about any of them.
 */
type Rateable = {
    ids: { imdb?: string | undefined };
    ratings?: { imdb?: number | undefined } | undefined;
};

/**
 * Fill `ratings.imdb` wherever the dataset can and a service has not.
 *
 * For a series this is the only path that can populate it at all. Radarr
 * returns a per-source ratings map, but Sonarr returns one flat value that
 * `flattenSeriesRating` can only honestly record as `tvdb` — so before this,
 * `MergedRatings.imdb` was unreachable for half the library.
 *
 * Returns the array it was given, unchanged and by identity, when there is
 * nothing to do: no dataset, nothing joinable, or nothing found.
 */
export function enrichWithImdb<T extends Rateable>(items: T[], dataset: ImdbDataset | undefined): T[] {
    if (dataset === undefined) return items;

    const wanted: string[] = [];
    for (const item of items) {
        if (item.ids.imdb !== undefined && item.ratings?.imdb === undefined) wanted.push(item.ids.imdb);
    }
    if (wanted.length === 0) return items;

    const found = dataset.ratingsFor(wanted);
    if (found.size === 0) return items;

    return items.map(item => {
        if (item.ids.imdb === undefined || item.ratings?.imdb !== undefined) return item;

        const rating = found.get(item.ids.imdb);
        if (rating === undefined) return item;

        // Copied, never mutated: `LibraryIndex` holds the same objects in both
        // `all()` and its key map, and a caller that kept a reference must not
        // see it change under them.
        return { ...item, ratings: { ...item.ratings, imdb: rating } };
    });
}
