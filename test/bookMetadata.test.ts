import { describe, expect, it } from 'vitest';
import { bestCandidate, describeBookChange, diffBookFields, FIX_FIELDS, normaliseIsbn } from '../src/tools/bookMetadata.ts';

describe('normaliseIsbn', () => {
    it('keeps digits only from a hyphenated or spaced ISBN-13', () => {
        expect(normaliseIsbn('978-0-14-044913-6')).toBe('9780140449136');
        expect(normaliseIsbn('978 0 14 044913 6')).toBe('9780140449136');
    });

    it('keeps the X check digit of an ISBN-10', () => {
        expect(normaliseIsbn('0-14-044913-X')).toBe('014044913X');
        expect(normaliseIsbn('0-14-044913-x')).toBe('014044913X');
    });

    it('is undefined for anything not 10 or 13 long', () => {
        expect(normaliseIsbn('12')).toBeUndefined();
        expect(normaliseIsbn('97801404491361')).toBeUndefined();
        expect(normaliseIsbn('X140449136')).toBeUndefined();
    });
});

describe('FIX_FIELDS', () => {
    it('is every book field but categories', () => {
        expect(FIX_FIELDS).not.toContain('categories');
        expect(FIX_FIELDS).toContain('title');
        expect(FIX_FIELDS).toContain('openlibraryId');
        expect(FIX_FIELDS).toHaveLength(16);
    });
});

describe('bestCandidate', () => {
    const book = { title: 'The Odyssey', authors: ['Homer'], isbn13: '9780140449136' };

    it('prefers an ISBN match over a title match', () => {
        const byTitle = { provider: 'Google', fields: { title: 'Odyssey', authors: ['Homer'] } };
        const byIsbn = { provider: 'Hardcover', fields: { title: 'Another Title', isbn13: '978-0-14-044913-6' } };
        expect(bestCandidate([byTitle, byIsbn], book, { isbn: '9780140449136' })).toBe(byIsbn);
    });

    it('matches a candidate on its ISBN-10 too', () => {
        const ten = { provider: 'OpenLibrary', fields: { isbn10: '0-14-044913-X' } };
        expect(bestCandidate([ten], {}, { isbn: '014044913X' })).toBe(ten);
    });

    it('takes a title and first-author match when no ISBN matches', () => {
        const other = { provider: 'Google', fields: { title: 'Iliad', authors: ['Homer'], isbn13: '9780000000001' } };
        const title = { provider: 'GoodReads', fields: { title: 'the odyssey!', authors: ['homer'], isbn13: '9780000000002' } };
        expect(bestCandidate([other, title], book, { isbn: '9780140449136' })).toBe(title);
    });

    it('never takes a title match by another author, or with no author', () => {
        const otherAuthor = { provider: 'Google', fields: { title: 'The Odyssey', authors: ['Someone Else'] } };
        const noAuthor = { provider: 'GoodReads', fields: { title: 'The Odyssey' } };
        expect(bestCandidate([otherAuthor, noAuthor], book, {})).toBeUndefined();
        expect(bestCandidate([otherAuthor], book, { isbn: '9780140449136' })).toBeUndefined();
    });

    it('takes no title match for a book with no author', () => {
        const title = { provider: 'Google', fields: { title: 'The Odyssey', authors: ['Homer'] } };
        expect(bestCandidate([title], { title: 'The Odyssey' }, {})).toBeUndefined();
    });

    it('returns undefined when nothing qualifies', () => {
        const author = { provider: 'Google', fields: { title: 'Iliad', authors: ['Homer'] } };
        expect(bestCandidate([author], book, { isbn: '9780140449136' })).toBeUndefined();
        expect(bestCandidate([], book, {})).toBeUndefined();
    });

    it('scores a first-author match above a title match alone', () => {
        const title = { provider: 'Google', fields: { title: 'The Odyssey', authors: ['Someone Else'] } };
        const both = { provider: 'GoodReads', fields: { title: 'The Odyssey', authors: ['homer'] } };
        expect(bestCandidate([title, both], book, {})).toBe(both);
    });

    it('keeps stream order on a tie', () => {
        const first = { provider: 'Hardcover', fields: { title: 'The Odyssey', authors: ['Homer'] } };
        const second = { provider: 'Google', fields: { title: 'The Odyssey', authors: ['Homer'] } };
        expect(bestCandidate([first, second], book, {})).toBe(first);
    });

    it('normalises a typed ISBN before comparing it', () => {
        const byIsbn = { provider: 'Hardcover', fields: { isbn13: '9780140449136' } };
        expect(bestCandidate([byIsbn], {}, { isbn: '978-0-14-044913-6' })).toBe(byIsbn);
    });
});

describe('diffBookFields', () => {
    it('leaves unchanged and absent values out', () => {
        const { changes, keptLocked } = diffBookFields(
            { title: 'A', publisher: 'P', pageCount: 300 },
            { title: 'A', pageCount: 320 },
            [],
            FIX_FIELDS
        );
        expect(changes).toEqual({ pageCount: 320 });
        expect(keptLocked).toEqual([]);
    });

    it('puts a differing locked field in keptLocked and never in changes', () => {
        const { changes, keptLocked } = diffBookFields({ seriesName: 'Old', title: 'A' }, { seriesName: 'New', title: 'B' }, ['seriesName'], FIX_FIELDS);
        expect(changes).toEqual({ title: 'B' });
        expect(keptLocked).toEqual(['seriesName']);
    });

    it('does not name a locked field that would not change', () => {
        const { keptLocked } = diffBookFields({ seriesName: 'Same' }, { seriesName: 'Same' }, ['seriesName'], FIX_FIELDS);
        expect(keptLocked).toEqual([]);
    });

    it('compares arrays by value and order', () => {
        expect(diffBookFields({ authors: ['A', 'B'] }, { authors: ['A', 'B'] }, [], FIX_FIELDS).changes).toEqual({});
        expect(diffBookFields({ authors: ['A', 'B'] }, { authors: ['B', 'A'] }, [], FIX_FIELDS).changes).toEqual({ authors: ['B', 'A'] });
    });

    it('only looks at the fields it is given', () => {
        expect(diffBookFields({}, { title: 'A', categories: ['X'] }, [], FIX_FIELDS).changes).toEqual({ title: 'A' });
    });
});

describe('describeBookChange', () => {
    it('fences every string value', () => {
        const line = describeBookChange('title', 'A', 'B');
        expect(line).toContain('<<untrusted:grimmory.title>>A');
        expect(line).toContain('<<untrusted:grimmory.title>>B');
    });

    it('fences each author and shows a number and an empty value plainly', () => {
        expect(describeBookChange('authors', undefined, ['X', 'Y'])).toContain('<<untrusted:grimmory.authors>>Y');
        const pages = describeBookChange('pageCount', undefined, 320);
        expect(pages).toContain('320');
        expect(pages).not.toContain('untrusted');
    });
});
