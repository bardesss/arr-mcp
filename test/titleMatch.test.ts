import { describe, expect, it } from 'vitest';
import { RANK_EXACT, RANK_NONE, RANK_PREFIX, RANK_SUBSTRING, normaliseTitle, rankTitle, unfenced } from '../src/core/titleMatch.ts';

describe('unfenced', () => {
    it('strips the boundary so fenced titles compare like plain ones', () => {
        expect(unfenced('<<untrusted:radarr.title>>Some Film<</untrusted>>')).toBe('Some Film');
    });

    it('leaves an unfenced value alone', () => {
        expect(unfenced('Some Film')).toBe('Some Film');
    });
});

describe('normaliseTitle', () => {
    it('lowercases and strips punctuation', () => {
        expect(normaliseTitle('Spider-Man: Brand New Day!')).toBe('spiderman brand new day');
    });

    it('strips a leading article, because people omit it when asking', () => {
        expect(normaliseTitle('The Matrix')).toBe('matrix');
        expect(normaliseTitle('A Quiet Place')).toBe('quiet place');
        expect(normaliseTitle('An Education')).toBe('education');
    });

    it('does not strip an article that is not leading', () => {
        expect(normaliseTitle('Raising the Bar')).toBe('raising the bar');
    });

    it('collapses runs of whitespace', () => {
        expect(normaliseTitle('  Blade   Runner  ')).toBe('blade runner');
    });
});

describe('rankTitle', () => {
    it('ranks an exact match above everything', () => {
        expect(rankTitle('The Matrix', 'matrix')).toBe(RANK_EXACT);
    });

    it('ranks a prefix above a substring', () => {
        expect(rankTitle('Matrix Reloaded', 'matrix')).toBe(RANK_PREFIX);
        expect(rankTitle('Enter the Matrix', 'matrix')).toBe(RANK_SUBSTRING);
    });

    it('reports no match rather than pretending', () => {
        expect(rankTitle('Blade Runner', 'matrix')).toBe(RANK_NONE);
    });

    it('compares through a fence', () => {
        expect(rankTitle('<<untrusted:radarr.title>>The Matrix<</untrusted>>', 'matrix')).toBe(RANK_EXACT);
    });

    it('orders correctly when sorted', () => {
        const titles = ['Enter the Matrix', 'The Matrix', 'Matrix Reloaded'];
        titles.sort((a, b) => rankTitle(a, 'matrix') - rankTitle(b, 'matrix'));
        expect(titles).toEqual(['The Matrix', 'Matrix Reloaded', 'Enter the Matrix']);
    });
});
