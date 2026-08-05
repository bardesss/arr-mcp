import { describe, expect, it } from 'vitest';
import { LibraryIndex, type IndexInput } from '../src/core/resolver.ts';

const arr = (over: Partial<IndexInput> = {}): IndexInput => ({
    kind: 'movie',
    title: 'Some Film',
    year: 2026,
    ids: { tmdb: 550 },
    acquisition: { service: 'radarr', monitored: true, hasFile: true },
    ...over
});

const jelly = (over: Partial<IndexInput> = {}): IndexInput => ({
    kind: 'movie',
    title: 'Some Film',
    year: 2026,
    ids: { tmdb: 550 },
    playback: { user: 'Bartus', watched: true },
    ...over
});

describe('LibraryIndex merging', () => {
    it('merges an *arr and a Jellyfin record sharing a tmdb id', () => {
        const index = LibraryIndex.build([arr(), jelly()]);

        expect(index.size()).toBe(1);
        const item = index.find({ tmdb: 550 });
        expect(item?.acquisition?.service).toBe('radarr');
        expect(item?.playback?.watched).toBe(true);
        expect(item?.presence).toBe('both');
    });

    it('merges series on tvdb', () => {
        const index = LibraryIndex.build([
            arr({ kind: 'series', ids: { tvdb: 292157 }, acquisition: { service: 'sonarr', monitored: true, hasFile: true } }),
            jelly({ kind: 'series', ids: { tvdb: 292157 } })
        ]);

        expect(index.size()).toBe(1);
        expect(index.find({ tvdb: 292157 })?.presence).toBe('both');
    });

    it('merges on imdb when that is the only shared id', () => {
        // Radarr knows tmdb and imdb; Jellyfin knows only imdb.
        const index = LibraryIndex.build([
            arr({ ids: { tmdb: 550, imdb: 'tt0137523' } }),
            jelly({ ids: { imdb: 'tt0137523' } })
        ]);

        expect(index.size()).toBe(1);
        expect(index.find({ tmdb: 550 })?.presence).toBe('both');
        expect(index.find({ imdb: 'tt0137523' })?.presence).toBe('both');
    });

    it('keeps records with no shared id separate', () => {
        // No evidence they are the same item. Merging on title similarity is
        // how a remake gets fused with its original.
        const index = LibraryIndex.build([arr({ ids: { tmdb: 550 } }), jelly({ ids: { tmdb: 999 } })]);
        expect(index.size()).toBe(2);
    });

    it('does not merge a film with a series that shares an id number', () => {
        // tmdb 550 and tvdb 550 are unrelated namespaces.
        const index = LibraryIndex.build([
            arr({ kind: 'movie', ids: { tmdb: 550 } }),
            arr({ kind: 'series', ids: { tvdb: 550 } })
        ]);
        expect(index.size()).toBe(2);
    });

    it('finds a merged item by any of its ids', () => {
        const index = LibraryIndex.build([arr({ ids: { tmdb: 550, imdb: 'tt0137523' } }), jelly({ ids: { imdb: 'tt0137523' } })]);

        expect(index.find({ tmdb: 550 })).toBeDefined();
        expect(index.find({ imdb: 'tt0137523' })).toBeDefined();
        expect(index.find({ tmdb: 111 })).toBeUndefined();
    });

    it('returns undefined for an empty id set rather than an arbitrary item', () => {
        const index = LibraryIndex.build([arr()]);
        expect(index.find({})).toBeUndefined();
    });
});

describe('LibraryIndex presence', () => {
    it('classifies an *arr-only item', () => {
        expect(LibraryIndex.build([arr()]).find({ tmdb: 550 })?.presence).toBe('arr_only');
    });

    it('classifies a Jellyfin-only item', () => {
        expect(LibraryIndex.build([jelly()]).find({ tmdb: 550 })?.presence).toBe('jellyfin_only');
    });

    it('classifies a merged item as both', () => {
        expect(LibraryIndex.build([arr(), jelly()]).find({ tmdb: 550 })?.presence).toBe('both');
    });

    it('is what makes a broken import visible', () => {
        // arr_only *with a file* is the signature §8 calls out: the *arr
        // believes the file is on disk and Jellyfin cannot see it.
        const item = LibraryIndex.build([arr({ acquisition: { service: 'radarr', monitored: true, hasFile: true } })]).find({ tmdb: 550 });

        expect(item?.presence).toBe('arr_only');
        expect(item?.acquisition?.hasFile).toBe(true);
    });
});

describe('LibraryIndex merge details', () => {
    it('prefers the *arr title, which is the managed one', () => {
        const index = LibraryIndex.build([
            arr({ title: 'Some Film' }),
            jelly({ title: 'Some Film (Director&apos;s Cut)' })
        ]);
        expect(index.find({ tmdb: 550 })?.title).toBe('Some Film');
    });

    it('takes a year from whichever record has one', () => {
        // `exactOptionalPropertyTypes` distinguishes "absent" from "present but
        // undefined", so blanking out the default's year needs a real `delete`
        // (an absent key) rather than `{ year: undefined }` (which the type
        // system rejects as an explicit-undefined value for a `number` field).
        const arrWithoutYear = arr();
        delete (arrWithoutYear as { year?: number }).year;

        const index = LibraryIndex.build([arrWithoutYear, jelly({ year: 2026 })]);
        expect(index.find({ tmdb: 550 })?.year).toBe(2026);
    });

    it('unions ids across both halves', () => {
        const index = LibraryIndex.build([arr({ ids: { tmdb: 550 } }), jelly({ ids: { tmdb: 550, imdb: 'tt0137523' } })]);
        expect(index.find({ tmdb: 550 })?.ids).toEqual({ tmdb: 550, imdb: 'tt0137523' });
    });

    it('keeps ratings from the record that has them', () => {
        const index = LibraryIndex.build([arr({ ratings: { imdb: 8.8 } }), jelly()]);
        expect(index.find({ tmdb: 550 })?.ratings).toEqual({ imdb: 8.8 });
    });

    it('takes genres from whichever record has them, since get_library filters on them', () => {
        const index = LibraryIndex.build([arr({ genres: ['Science Fiction'] }), jelly()]);
        expect(index.find({ tmdb: 550 })?.genres).toEqual(['Science Fiction']);
    });
});

describe('LibraryIndex search', () => {
    const index = LibraryIndex.build([
        arr({ title: 'The Matrix', ids: { tmdb: 1 } }),
        arr({ title: 'Matrix Reloaded', ids: { tmdb: 2 } }),
        arr({ title: 'Enter the Matrix', ids: { tmdb: 3 } }),
        arr({ title: 'Blade Runner', ids: { tmdb: 4 } })
    ]);

    it('ranks exact above prefix above substring', () => {
        expect(index.search('matrix').map(i => i.title)).toEqual([
            'The Matrix',
            'Matrix Reloaded',
            'Enter the Matrix'
        ]);
    });

    it('excludes non-matches rather than ranking them last', () => {
        expect(index.search('matrix').some(i => i.title === 'Blade Runner')).toBe(false);
    });

    it('returns an empty list for a query matching nothing', () => {
        expect(index.search('zzzz')).toEqual([]);
    });

    it('matches through a leading article the caller omitted', () => {
        expect(index.search('the matrix')[0]?.title).toBe('The Matrix');
    });
});

describe('LibraryIndex.all', () => {
    it('returns every merged item once', () => {
        const index = LibraryIndex.build([arr(), jelly(), arr({ ids: { tmdb: 999 } })]);
        expect(index.all()).toHaveLength(2);
    });

    it('handles an empty input', () => {
        const index = LibraryIndex.build([]);
        expect(index.all()).toEqual([]);
        expect(index.size()).toBe(0);
    });
});
