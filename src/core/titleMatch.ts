/**
 * Title normalisation and ranking, shared by `search_media`, the resolver and
 * `diagnose`. Extracted from searchMedia when the third caller appeared: two
 * copies is a coincidence, three is a module.
 *
 * Ranking contract: four tiers, lower is better — RANK_EXACT, RANK_PREFIX,
 * RANK_SUBSTRING, RANK_NONE. A title that does not contain the query at all
 * is a strictly worse match than one that does, so it gets its own bottom
 * tier instead of sharing RANK_SUBSTRING by default. That distinction is not
 * theoretical: `search_media`'s library sources pre-filter to substring
 * matches before this ever sees them, but its discover and indexer sources
 * (Radarr/Sonarr `/lookup`, Prowlarr's indexer search) return whatever the
 * far end sent back, unfiltered — RANK_NONE is the tier that keeps an
 * unrelated result from outranking a real one there. Both sides of the
 * comparison go through `normaliseTitle`, so a leading article on either the
 * title or the query is stripped before ranking: "matrix" against "The
 * Matrix" and "the matrix" against "Matrix" both land on RANK_EXACT.
 */

/** Fenced titles carry a boundary prefix; comparison strips it first. */
export const unfenced = (value: string): string =>
    value.replace(/^<<untrusted:[^>]*>>/, '').replace(/<<\/untrusted>>$/, '');

const LEADING_ARTICLE = /^(the|a|an)\s+/;

/**
 * Lowercase, punctuation removed, leading article dropped. The article matters:
 * people ask for "matrix" and the library holds "The Matrix".
 */
export const normaliseTitle = (value: string): string =>
    unfenced(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(LEADING_ARTICLE, '');

export const RANK_EXACT = 0;
export const RANK_PREFIX = 1;
export const RANK_SUBSTRING = 2;
export const RANK_NONE = 3;

/** Lower is better, so results sort naturally by relevance. */
export function rankTitle(title: string, query: string): number {
    const t = normaliseTitle(title);
    const q = normaliseTitle(query);

    // An empty query — whether the caller sent '' or something that
    // normalises down to it, like '???' — matches nothing. Without this,
    // `t === q` and `t.startsWith(q)` are both true for every title (the
    // empty string is a prefix of everything), so an empty query would rank
    // as an exact match against a title that is itself empty, and as a
    // prefix match against every other title in the library.
    if (q === '') return RANK_NONE;

    if (t === q) return RANK_EXACT;
    if (t.startsWith(q)) return RANK_PREFIX;
    if (t.includes(q)) return RANK_SUBSTRING;
    return RANK_NONE;
}
