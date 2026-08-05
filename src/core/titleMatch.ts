/**
 * Title normalisation and ranking, shared by `search_media`, the resolver and
 * `diagnose`. Extracted from searchMedia when the third caller appeared: two
 * copies is a coincidence, three is a module.
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

    if (t === q) return RANK_EXACT;
    if (t.startsWith(q)) return RANK_PREFIX;
    if (t.includes(q)) return RANK_SUBSTRING;
    return RANK_NONE;
}
