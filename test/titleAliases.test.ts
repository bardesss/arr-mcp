import { describe, expect, it } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
import { LibraryIndex, type IndexInput } from '../src/core/resolver.ts';
import { aliasesOf, rankTitle, RANK_EXACT, unfenced } from '../src/core/titleMatch.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { resolveMediaDetails } from '../src/tools/getMediaDetails.ts';
import { LibraryLoader } from '../src/tools/library.ts';

// #517: a Radarr with French metadata displays "Le Transport" for the film
// Jellyfin calls "Runner". Asking for "Runner" found Cyberpunk: Edgerunners.

const radarrFilm = (title: string, tmdb: number, id: string, aliases: string[] = []): IndexInput => ({
    kind: 'movie',
    title: fenceText(title, { service: 'radarr', field: 'title' }),
    year: 2026,
    ids: { tmdb },
    acquisition: { service: 'radarr', id, monitored: true, hasFile: true },
    ...(aliases.length === 0 ? {} : { aliases })
});

const sonarrSeries = (title: string, tvdb: number, id: string, year = 2022): IndexInput => ({
    kind: 'series',
    title: fenceText(title, { service: 'sonarr', field: 'title' }),
    year,
    ids: { tvdb },
    acquisition: { service: 'sonarr', id, monitored: true, hasFile: true }
});

const jellyfinFilm = (title: string, tmdb: number): IndexInput => ({
    kind: 'movie',
    title: fenceText(title, { service: 'jellyfin', field: 'Name' }),
    year: 2026,
    ids: { tmdb },
    playback: { user: 'Bartus', watched: false }
});

const library = (): IndexInput[] => [
    radarrFilm('Le Transport', 1377237, '240'),
    radarrFilm('Tout sauf toi', 1072790, '295', ['Anyone but You']),
    sonarrSeries('Cyberpunk: Edgerunners', 384541, '217'),
    jellyfinFilm('Runner', 1377237)
];

const title = (item: { title: string } | undefined): string => unfenced(item?.title ?? '');

describe('title aliases in the library index (#517)', () => {
    it('keeps the media server title that lost the merge as a name to match', () => {
        const index = LibraryIndex.build(library());
        const [first] = index.search('Runner');
        expect(title(first)).toBe('Le Transport');
        expect(first?.acquisition?.id).toBe('240');
    });

    it('matches a Radarr alternate title', () => {
        const index = LibraryIndex.build(library());
        expect(index.search('Anyone But You')[0]?.acquisition?.id).toBe('295');
    });

    it('still finds the series by its own title', () => {
        const index = LibraryIndex.build(library());
        expect(index.search('Edgerunners')[0]?.acquisition?.id).toBe('217');
    });

    it('ranks an exact alias above a substring match on a displayed title', () => {
        const hits = LibraryIndex.build(library()).searchRanked('Runner');
        expect(hits.map(h => h.item.acquisition?.id)).toEqual(['240', '217']);
        expect(hits[0]?.rank).toBe(RANK_EXACT);
    });

    it('prefers a displayed title over an alias at the same rank', () => {
        const index = LibraryIndex.build([
            radarrFilm('Alpha', 1, '1', ['Heat']),
            radarrFilm('Heat', 2, '2')
        ]);
        expect(index.search('Heat').map(i => i.acquisition?.id)).toEqual(['2', '1']);
    });

    it('never puts aliases on the returned rows', () => {
        const index = LibraryIndex.build(library());
        for (const item of index.all()) expect(item).not.toHaveProperty('aliases');
    });

    it('carries aliases across a fuse of two groups', () => {
        const index = LibraryIndex.build([
            { ...radarrFilm('Le Transport', 10, '240'), ids: { tmdb: 10 } },
            { ...jellyfinFilm('Runner', 10), ids: { imdb: 'tt1' } },
            { ...jellyfinFilm('Runner', 10), title: fenceText('Runner 2', { service: 'jellyfin', field: 'Name' }), ids: { tmdb: 10, imdb: 'tt1' } }
        ]);
        expect(index.all()).toHaveLength(1);
        expect(index.search('Runner')[0]?.acquisition?.id).toBe('240');
    });
});

describe('title matching ignores accents (#517)', () => {
    it('treats an accented title as the same title', () => {
        expect(rankTitle('Pokémon', 'pokemon')).toBe(RANK_EXACT);
        expect(rankTitle('Amelie', 'Amélie')).toBe(RANK_EXACT);
    });

    it('drops blanks and repeats of the title from aliases', () => {
        expect(aliasesOf('Runner', ['runner', null, '', 'Le Transport', 'le transport!'])).toEqual(['Le Transport']);
    });
});

describe('get_media_details by title (#517)', () => {
    const loaderFor = (rows: IndexInput[]) =>
        new LibraryLoader(
            [
                {
                    id: 'radarr',
                    testConnection: async () => ({ ok: true, service: 'radarr', latency_ms: 1 }),
                    getVersion: async () => '1.0.0',
                    listLibrary: async () => rows
                } as unknown as ServiceAdapter
            ],
            undefined
        );
    const opts = { detail: 'standard' as const, limit: 50 };

    it('resolves "Runner" to the film, with no ambiguity', async () => {
        const result = await resolveMediaDetails([], loaderFor(library()), { ...opts, query: 'Runner' });
        expect(result).toMatchObject({ kind: 'movie', acquisition: { id: '240' } });
        expect(result).not.toHaveProperty('ambiguous');
    });

    it('resolves an alternate title', async () => {
        const result = await resolveMediaDetails([], loaderFor(library()), { ...opts, query: 'Anyone But You' });
        expect(result).toMatchObject({ acquisition: { id: '295' } });
    });

    it('flags a tie and lists the others', async () => {
        const rows = [radarrFilm('Dune', 1, '1'), { ...radarrFilm('Dune', 2, '2'), year: 1984 }];
        const result = await resolveMediaDetails([], loaderFor(rows), { ...opts, query: 'Dune' });
        expect(result).toMatchObject({ ambiguous: true });
        expect(result).toHaveProperty('candidates');
        const candidates = (result as { candidates: { acquisition?: { id?: string } }[] }).candidates;
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.acquisition?.id).not.toBe((result as { acquisition?: { id?: string } }).acquisition?.id);
    });

    it('flags two substring matches with no exact one', async () => {
        const rows = [radarrFilm('Blade Runner', 1, '1'), sonarrSeries('Cyberpunk: Edgerunners', 2, '2')];
        const result = await resolveMediaDetails([], loaderFor(rows), { ...opts, query: 'Runner' });
        expect(result).toMatchObject({ ambiguous: true });
    });
});
