import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import { parseEpisodes, parseRatings, parseTitles } from '../src/metadata/ingest.ts';

/**
 * Parsing IMDb's dumps, against hand-written fixtures in the real format —
 * tab separated, `\N` for absent, a header row on top.
 */

const lines = (name: string): string[] =>
    readFileSync(join(import.meta.dirname, 'fixtures/imdb', name), 'utf8')
        .split('\n')
        .filter(line => line !== '');

const titles = () => [...parseTitles(lines('title.basics.tsv'))];

let db: ImdbDataset;
afterEach(() => db?.close());

describe('parsing the dumps', () => {
    /** Detected by position, not by matching the literal string `tconst` —
     *  which would silently ingest the header the day IMDb capitalises it. */
    it('skips the header row rather than ingesting it as a title', () => {
        expect(titles().map(t => t.tconst)).not.toContain('tconst');
    });

    /**
     * `\N` is IMDb's null marker in every column of every file. Storing it as
     * written is how a library ends up holding a film released in the year
     * "\N", and the string is truthy, so nothing downstream would catch it.
     */
    it('reads \\N as absent, never as a value', () => {
        const shawshank = titles().find(t => t.tconst === 'tt0111161');
        expect(shawshank?.runtime).toBeUndefined();
        expect(shawshank?.year).toBe(1994);

        const short = titles().find(t => t.tconst === 'tt9999998');
        expect(short?.genres).toBeUndefined();
    });

    it('keeps exactly the columns the schema stores', () => {
        expect(titles().find(t => t.tconst === 'tt0068646')).toEqual({
            tconst: 'tt0068646',
            kind: 'movie',
            title: 'The Godfather',
            year: 1972,
            runtime: 175,
            genres: 'Crime,Drama'
        });
    });

    /** A row with no title cannot be shown, matched or ranked. Dropping it is
     *  better than carrying a nameless entry into the library join. */
    it('drops a row missing a field the schema requires', () => {
        expect(titles().map(t => t.tconst)).not.toContain('tt9999997');
    });

    it('reads ratings as numbers, not strings', () => {
        expect([...parseRatings(lines('title.ratings.tsv'))][0]).toEqual({
            tconst: 'tt0903747',
            average: 9.5,
            votes: 2_200_000
        });
    });

    it('reads an episode with no season or number as absent', () => {
        const loose = [...parseEpisodes(lines('title.episode.tsv'))].find(e => e.tconst === 'tt2301451');
        expect(loose).toEqual({ tconst: 'tt2301451', parent: 'tt0903747' });
    });

    it('yields nothing for a file that is only a header', () => {
        expect([...parseTitles(['tconst\ttitleType\tprimaryTitle'])]).toEqual([]);
    });

    /** Generators, not arrays: title.basics is on the order of 10^7 rows and
     *  this runs on a NAS. Materialising it costs a multiple of its own size. */
    it('is lazy, so a whole dump never lands in memory at once', () => {
        const parsed = parseTitles(lines('title.basics.tsv'));
        expect(typeof (parsed as { next?: unknown }).next).toBe('function');
    });
});

describe('loading a parsed dump', () => {
    it('is queryable end to end', () => {
        db = ImdbDataset.ephemeral();
        db.replaceAll({
            titles: parseTitles(lines('title.basics.tsv')),
            ratings: parseRatings(lines('title.ratings.tsv'))
        });

        expect(db.ratingsFor(['tt0903747']).get('tt0903747')).toBe(9.5);
        expect(db.status().titles).toBe(4);
        expect(db.discover({ kind: 'movie', genre: 'Crime', limit: 10 }).map(h => h.title)).toEqual([
            'The Godfather'
        ]);
    });
});
