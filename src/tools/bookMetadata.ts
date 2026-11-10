import { fenceText } from '../core/fence.ts';
import { normaliseTitle } from '../core/titleMatch.ts';
import type { BookCandidate, BookField, BookFields, BookSearch } from '../services/types.ts';

/**
 * Pure helpers for a book's metadata, shared by `fix_metadata` and
 * `update_media`: which candidate a lookup should take, what would change, and
 * how a change reads in a preview.
 */

/** Every `BookFields` key, in the order a preview lists them. */
const BOOK_FIELDS: readonly BookField[] = [
    'title',
    'subtitle',
    'authors',
    'publisher',
    'publishedDate',
    'seriesName',
    'seriesNumber',
    'isbn13',
    'isbn10',
    'asin',
    'language',
    'pageCount',
    'categories',
    'goodreadsId',
    'googleId',
    'hardcoverId',
    'openlibraryId'
];

/**
 * The fields `fix_metadata` replaces. Categories are left out: providers
 * disagree on them freely, and a repair that swaps one provider's genre list
 * for another's is churn rather than a fix.
 */
export const FIX_FIELDS: readonly BookField[] = BOOK_FIELDS.filter(f => f !== 'categories');

/** An ISBN as digits (and a final `X` on an ISBN-10), or undefined when it is not 10 or 13 long. */
export function normaliseIsbn(raw: string): string | undefined {
    const s = raw.toUpperCase().replace(/[^0-9X]/g, '');
    return /^(\d{13}|\d{9}[\dX])$/.test(s) ? s : undefined;
}

const sameText = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && normaliseTitle(a) !== '' && normaliseTitle(a) === normaliseTitle(b);

const tieOrder = (a: BookCandidate, b: BookCandidate): number =>
    (a.provider ?? '').localeCompare(b.provider ?? '', 'en') || (a.fields.title ?? '').localeCompare(b.fields.title ?? '', 'en');

/**
 * The candidate a lookup should take, or undefined when none is the book.
 *
 * A candidate qualifies on its ISBN (13 or 10) equalling the searched one, or
 * on both its title and its first author equalling the book's. A title alone
 * never qualifies: another author's book of the same name would replace this
 * one's identifiers. Among qualifiers an ISBN match scores 4, a title match 2
 * and a first-author match 1. A tie goes to the provider name, then the
 * candidate title, so the pick does not depend on the order the provider
 * streams arrive in.
 */
export function bestCandidate(candidates: readonly BookCandidate[], book: BookFields, search: BookSearch): BookCandidate | undefined {
    const isbn = search.isbn === undefined ? undefined : normaliseIsbn(search.isbn);
    let best: BookCandidate | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
        const { fields } = candidate;
        const isbnMatch =
            isbn !== undefined && [fields.isbn13, fields.isbn10].some(v => v !== undefined && normaliseIsbn(v) === isbn);
        const titleMatch = sameText(fields.title, book.title);
        const authorMatch = sameText(fields.authors?.[0], book.authors?.[0]);
        if (!isbnMatch && !(titleMatch && authorMatch)) continue;
        const score = (isbnMatch ? 4 : 0) + (titleMatch ? 2 : 0) + (authorMatch ? 1 : 0);
        if (score > bestScore || (score === bestScore && best !== undefined && tieOrder(candidate, best) < 0)) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

const equal = (a: unknown, b: unknown): boolean =>
    Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;

/**
 * What writing `wanted` over `current` would change, limited to `only`. An
 * absent wanted value is no change. A differing locked field never enters
 * `changes`; it is named in `keptLocked` instead.
 */
export function diffBookFields(
    current: BookFields,
    wanted: BookFields,
    locked: readonly BookField[],
    only: readonly BookField[]
): { changes: BookFields; keptLocked: BookField[] } {
    const changes: Record<string, unknown> = {};
    const keptLocked: BookField[] = [];
    for (const field of only) {
        const to = wanted[field];
        if (to === undefined || equal(current[field], to)) continue;
        if (locked.includes(field)) keptLocked.push(field);
        else changes[field] = to;
    }
    return { changes, keptLocked };
}

const shown = (field: BookField, value: unknown): string => {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return '(empty)';
    if (Array.isArray(value)) return value.map(v => fenceText(String(v), { service: 'grimmory', field })).join(', ');
    if (typeof value === 'string') return fenceText(value, { service: 'grimmory', field });
    return String(value);
};

/** One preview line, `field: from → to`, every string value fenced. */
export function describeBookChange(field: BookField, from: unknown, to: unknown): string {
    return `${field}: ${shown(field, from)} → ${shown(field, to)}`;
}
