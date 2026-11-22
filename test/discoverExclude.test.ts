import { describe, expect, it } from 'vitest';
import type { IdentityResolver } from '../src/core/identity.ts';
import type { PlayHistory, PlayRecord } from '../src/core/playHistory.ts';
import { LibraryIndex, type IndexInput } from '../src/core/resolver.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import type { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import type { MediaServerAdapter, ServiceUser } from '../src/services/types.ts';
import { buildDiscoverMedia } from '../src/tools/discoverMedia.ts';
import type { LibraryLoader, LibrarySnapshot } from '../src/tools/library.ts';
import type { MediaServers } from '../src/tools/mediaServers.ts';

type Row = { tconst: string; title: string; year?: number; genres: string[] };

/** The two dataset reads discover makes, over a fixed list in rank order. */
const dataset = (rows: Row[]): ImdbDataset =>
    ({
        discover: (q: { limit: number; offset?: number }) => rows.slice(q.offset ?? 0, (q.offset ?? 0) + q.limit),
        countDiscover: () => rows.length
    }) as unknown as ImdbDataset;

const films = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({ tconst: `tt${String(i + 1).padStart(7, '0')}`, title: `Film ${i + 1}`, year: 2000 + i, genres: ['Comedy'] }));

const snapshot = (rows: IndexInput[]): LibrarySnapshot => ({ index: LibraryIndex.build(rows), degraded: [], counts: {}, playbackFrom: 'plex' });

const loader = (snap: LibrarySnapshot): LibraryLoader => ({ load: async () => snap }) as unknown as LibraryLoader;

const USER: ServiceUser = { id: '1', name: 'owner' };

const mediaServers = (): MediaServers => ({
    primary: {
        adapter: { id: 'plex', type: 'plex' } as unknown as MediaServerAdapter,
        identity: { resolve: async () => USER } as unknown as IdentityResolver
    }
});

const store = (records: PlayRecord[] | (() => PlayRecord[])): PlayHistory =>
    ({
        read: (server: string, userId: string) => {
            expect([server, userId]).toEqual(['plex', '1']);
            return typeof records === 'function' ? records() : records;
        }
    }) as unknown as PlayHistory;

const film = (title: string, extra: Partial<PlayRecord> = {}): PlayRecord => ({
    entry: { kind: 'watched', user: 'owner', title } as PlayRecord['entry'],
    kind: 'movie',
    ...extra
});

const owned = (imdb: string, title: string): IndexInput => ({
    kind: 'movie',
    title,
    ids: { imdb },
    acquisition: { service: 'radarr', monitored: true, hasFile: true }
});

const titles = (items: { title: string }[]): string[] => items.map(i => unfenced(i.title));

describe('discover_media exclude', () => {
    it('leaves out owned and watched films, and refills to the limit from further down the list', async () => {
        const snap = snapshot([
            owned('tt0000001', 'Film 1'),
            { kind: 'movie', title: 'Film 3', ids: { imdb: 'tt0000003' }, playback: { user: 'owner', watched: true } }
        ]);
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 3, exclude: ['owned', 'watched'] }, dataset(films(10)), {
            library: loader(snap),
            mediaServers: mediaServers()
        });
        expect(titles(result.items)).toEqual(['Film 2', 'Film 4', 'Film 5']);
        expect(result.truncated).toBe(true);
        expect(result.note).toBe('Left out 1 already owned and 1 already watched. offset 5 continues.');
    });

    it('keeps a film owned but unwatched when only watched is excluded', async () => {
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 2, exclude: ['watched'] }, dataset(films(3)), {
            library: loader(snapshot([owned('tt0000001', 'Film 1')])),
            mediaServers: mediaServers()
        });
        expect(titles(result.items)).toEqual(['Film 1', 'Film 2']);
    });

    it('catches stored plays by id, and a deleted film by title and a year either side', async () => {
        const plays = store([
            film('Renamed since', { ids: { imdb: 'tt0000001' } }),
            film('film 3', { year: 2003 }),
            film('Film 5', { year: 1990 }),
            film('Film 6')
        ]);
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 6, exclude: ['watched'] }, dataset(films(6)), {
            library: loader(snapshot([])),
            mediaServers: mediaServers(),
            plays
        });
        // Film 3 (2002) is a year off; Film 5 is 1990 against 2004; Film 6 has no year to match on.
        expect(titles(result.items)).toEqual(['Film 2', 'Film 4', 'Film 5', 'Film 6']);
        expect(result.note).toBe('Left out 0 already owned and 2 already watched.');
    });

    it('matches a stored episode to its series by id or series title', async () => {
        const episode = (seriesTitle: string, ids?: PlayRecord['ids']): PlayRecord => ({
            entry: { kind: 'watched', user: 'owner', title: 'Pilot', seriesTitle } as PlayRecord['entry'],
            kind: 'episode',
            ...(ids === undefined ? {} : { ids })
        });
        const plays = store([episode('Anything', { imdb: 'tt0000002' }), episode('Film 3'), film('Film 4', { year: 2003 })]);
        const result = await buildDiscoverMedia(undefined, { kind: 'series', detail: 'standard', limit: 4, exclude: ['watched'] }, dataset(films(4)), {
            library: loader(snapshot([])),
            mediaServers: mediaServers(),
            plays
        });
        // A stored film never excludes a series of the same name.
        expect(titles(result.items)).toEqual(['Film 1', 'Film 4']);
    });

    it('returns the minimal shape asked for, though year was needed to match', async () => {
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'minimal', limit: 1, exclude: ['watched'] }, dataset(films(2)), {
            library: loader(snapshot([])),
            mediaServers: mediaServers(),
            plays: store([film('Film 1', { year: 2000 })])
        });
        expect(titles(result.items)).toEqual(['Film 2']);
        expect(result.items[0]).not.toHaveProperty('year');
    });

    it('degrades rather than fails when the play store cannot be read', async () => {
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 2, exclude: ['watched'] }, dataset(films(2)), {
            library: loader(snapshot([])),
            mediaServers: mediaServers(),
            plays: store(() => {
                throw new Error('database is locked');
            })
        });
        expect(result.returned).toBe(2);
        expect(result.degraded).toEqual(['plex']);
    });

    it('works from the library alone with no play store', async () => {
        const snap = snapshot([{ kind: 'movie', title: 'Film 1', ids: { imdb: 'tt0000001' }, playback: { user: 'owner', playCount: 2 } }]);
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 1, exclude: ['watched'] }, dataset(films(2)), {
            library: loader(snap),
            mediaServers: mediaServers()
        });
        expect(titles(result.items)).toEqual(['Film 2']);
        expect(result.degraded).toEqual([]);
    });

    it('is the unfiltered answer when exclude is empty', async () => {
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 2, exclude: [] }, dataset(films(3)));
        expect(titles(result.items)).toEqual(['Film 1', 'Film 2']);
        expect(result.note).toBeUndefined();
    });
});
