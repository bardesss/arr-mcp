/**
 * Grimmory scrubbing for `capture-fixtures.ts`, split out so it can be unit
 * tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 *
 * A library is someone's reading history, so what names a book, an author, a
 * series, a library or a file on disk is replaced by a numbered stand-in, and
 * every other key keeps the shape the adapter reads. Catalogue ids, ISBNs,
 * ratings and counts become synthetic, since they resolve to the real book. A
 * book's number is its id, so the same book reads the same in the page, the
 * search and the detail.
 * Contact details and tokens are dropped outright.
 */
import { isRow, type Row } from './redact.ts';

/** Never kept: contact details and credentials. */
const DROPPED_KEYS = new Set(['email', 'accessToken', 'refreshToken', 'bookReviews', 'comicMetadata', 'audiobookMetadata']);

/** Who did it and from where, at any depth: an audit row names the person and their address. */
const STAND_INS: Record<string, string> = { username: 'example-user', ipAddress: '192.0.2.1', countryCode: 'ZZ' };

/** Free text the adapter never reads and a person wrote. */
const BLANKED_KEYS = new Set(['description', 'subtitle', 'publisher', 'comment', 'narrator']);

/** Every file size reads the same: the real number identifies the book. */
export const FILE_SIZE_KB = 2048;

/** A path keeps at most its first segment: `/books` names a mount, not a person's folders. */
const rootOf = (path: string): string => {
    const first = path.split('/').filter(part => part !== '')[0];
    return first === undefined ? '' : `/${first}`;
};

/** The file name a book gets: its stand-in title and the real extension. */
const fileNameFor = (title: string, name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot > 0 && !name.slice(dot).includes(' ') ? `${title}${name.slice(dot)}` : title;
};

type Names = Record<'authors' | 'series' | 'categories' | 'tags' | 'moods', Map<string, number>>;

/** Grimmory's own row ids, which are not catalogue ids. */
const STRUCTURAL_IDS = new Set(['id', 'bookId', 'libraryId', 'primaryFileId', 'libraryPathId', 'fileId']);

function numbered(map: Map<string, number>, value: string): number {
    const known = map.get(value);
    if (known !== undefined) return known;
    map.set(value, map.size + 1);
    return map.size;
}

function scrub(value: unknown, names: Names, bookNumber: number | undefined): unknown {
    if (Array.isArray(value)) return value.map(item => scrub(item, names, bookNumber));
    if (!isRow(value)) return value;
    const row: Row = value;

    // A book's own id inside its metadata is `bookId`; on a summary or detail it is `id`.
    const hasBook = 'title' in row || 'metadata' in row || 'primaryFile' in row || 'fileName' in row;
    const own = typeof row.bookId === 'number' ? row.bookId : hasBook && typeof row.id === 'number' ? row.id : bookNumber;
    const bookTitle = `Example Book ${own ?? 0}`;
    const isLibrary = Array.isArray(row.paths);

    const isAudit = typeof row.action === 'string' && 'entityType' in row;

    const out: Row = {};
    for (const [key, v] of Object.entries(row)) {
        if (DROPPED_KEYS.has(key)) continue;
        if (typeof v === 'string') {
            if (key in STAND_INS) out[key] = STAND_INS[key] ?? v;
            else if (key === 'description' && isAudit) out[key] = `Example audit entry ${String(row.id)}`;
            else if ((key === 'thumbnailUrl' || key === 'externalUrl') && v.startsWith('http')) out[key] = `https://example.invalid/${key}/${own ?? 0}`;
            else if (key === 'title') out[key] = bookTitle;
            else if (key === 'libraryName' || (key === 'name' && isLibrary)) out[key] = `Example Library ${typeof row.libraryId === 'number' ? row.libraryId : typeof row.id === 'number' ? row.id : 1}`;
            else if (key === 'fileName' || key === 'primaryFileName') out[key] = fileNameFor(bookTitle, v);
            else if (key === 'filePath') out[key] = fileNameFor(bookTitle, v.slice(v.lastIndexOf('/') + 1));
            else if (key === 'fileSubPath') out[key] = '';
            else if (key === 'path') out[key] = rootOf(v);
            else if (key === 'seriesName') out[key] = `Example Series ${numbered(names.series, v)}`;
            else if (key === 'publishedDate') out[key] = '2000-01-01';
            else if (key === 'isbn13') out[key] = `978${String(own ?? 0).padStart(10, '0')}`;
            else if (key === 'isbn10') out[key] = String(own ?? 0).padStart(10, '0');
            else if (key === 'asin') out[key] = `example-asin-${own ?? 0}`;
            // Catalogue ids (goodreadsId, googleId, ...) resolve to the real book; a row's own ids are numbers.
            else if (/Id$/.test(key) && !STRUCTURAL_IDS.has(key)) out[key] = `example-${key.slice(0, -2).toLowerCase()}-${own ?? 0}`;
            else if (BLANKED_KEYS.has(key)) out[key] = '';
            else out[key] = v;
        } else if (typeof v === 'number') {
            if (/Rating$/.test(key)) out[key] = 4;
            else if (/ReviewCount$/.test(key)) out[key] = 100;
            else if (key === 'pageCount') out[key] = 300;
            else if (key === 'seriesNumber') out[key] = 1;
            // An exact EPUB size narrows a download to a few candidates.
            else if (/^file.*Size(Kb)?$|SizeKb$/.test(key)) out[key] = FILE_SIZE_KB;
            else out[key] = v;
        } else if (key === 'authors' && Array.isArray(v)) {
            out[key] = v.map((a: unknown): unknown => (typeof a === 'string' ? `Example Author ${numbered(names.authors, a)}` : a));
        } else if ((key === 'categories' || key === 'tags' || key === 'moods') && Array.isArray(v)) {
            const label = { categories: 'Category', tags: 'Tag', moods: 'Mood' }[key];
            const map = names[key];
            out[key] = v.map((t: unknown): unknown => (typeof t === 'string' ? `Example ${label} ${numbered(map, t)}` : t));
        } else {
            out[key] = scrub(v, names, own);
        }
    }
    return out;
}

/** Any Grimmory response: pages, lists, a book and the small status bodies alike. */
export function anonymiseGrimmory(body: unknown): unknown {
    return scrub(body, { authors: new Map(), series: new Map(), categories: new Map(), tags: new Map(), moods: new Map() }, undefined);
}
