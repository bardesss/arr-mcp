import { McpServer } from '@modelcontextprotocol/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig, MultiUserServiceConfig } from '../src/config/schema.ts';
import {
    artworkFromImages,
    publicImageUrl,
    resizeTmdb,
    tmdbImageUrl,
    withoutDisplay
} from '../src/core/display.ts';
import { episodesOf } from '../src/services/arrDisplay.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SeerrAdapter } from '../src/services/seerr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import type { QueueItem, SearchHit, ServiceAdapter } from '../src/services/types.ts';
import { registerGetLibrary } from '../src/tools/getLibrary.ts';
import { registerGetMediaDetails } from '../src/tools/getMediaDetails.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import { registerSearchMedia } from '../src/tools/searchMedia.ts';
import { MAX_CARDS, cardStatus, cardsFromHits, externalLinks, type MediaCards } from '../src/ui/mediaCards.ts';
import { serving } from './helpers/serve.ts';

const fixture = (path: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', path), 'utf8'));

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const multiUser = (port: number): MultiUserServiceConfig => ({ ...keyed(port), allow_other_users: false });

type Images = { coverType: string; url: string; remoteUrl: string }[];
const radarrImages = (fixture('radarr/movie-detail.json') as { images: Images }).images;
const sonarrImages = (fixture('sonarr/series.json') as { images: Images }[])[0]!.images;

describe('image URLs', () => {
    it('keeps an HTTPS URL on TMDB or TheTVDB', () => {
        expect(publicImageUrl('https://image.tmdb.org/t/p/original/a.jpg')).toBe('https://image.tmdb.org/t/p/original/a.jpg');
        expect(publicImageUrl('https://artworks.thetvdb.com/banners/posters/1-1.jpg')).toBe(
            'https://artworks.thetvdb.com/banners/posters/1-1.jpg'
        );
    });

    it.each([
        ['an *arr path', '/MediaCover/340/poster.jpg?lastWrite=1'],
        ['an *arr address', 'http://192.0.2.10:7878/MediaCover/340/poster.jpg'],
        ['plain HTTP', 'http://image.tmdb.org/t/p/original/a.jpg'],
        ['another host', 'https://evil.example/t/p/original/a.jpg'],
        ['a lookalike host', 'https://image.tmdb.org.evil.example/a.jpg'],
        ['credentials', 'https://user:pass@image.tmdb.org/t/p/original/a.jpg'],
        ['a data URI', 'data:image/png;base64,AAAA'],
        ['nothing', undefined]
    ])('refuses %s', (_name, value) => {
        expect(publicImageUrl(value)).toBeUndefined();
    });

    it('sizes a TMDB image instead of loading the original', () => {
        expect(resizeTmdb('https://image.tmdb.org/t/p/original/qctz.jpg', 'w342')).toBe('https://image.tmdb.org/t/p/w342/qctz.jpg');
        expect(resizeTmdb('https://image.tmdb.org/t/p/w500/qctz.jpg', 'w780')).toBe('https://image.tmdb.org/t/p/w780/qctz.jpg');
        expect(resizeTmdb('https://artworks.thetvdb.com/banners/posters/1-1.jpg', 'w342')).toBe(
            'https://artworks.thetvdb.com/banners/posters/1-1.jpg'
        );
    });

    it('builds a TMDB URL from a poster_path, and from nothing else', () => {
        expect(tmdbImageUrl('/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg', 'w342')).toBe(
            'https://image.tmdb.org/t/p/w342/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg'
        );
        expect(tmdbImageUrl('/tlm8UkiQsitc8rSuIAscQDCnP8d.jpg', 'w780')).toBe(
            'https://image.tmdb.org/t/p/w780/tlm8UkiQsitc8rSuIAscQDCnP8d.jpg'
        );
        for (const bad of ['../../etc/passwd', 'https://evil.example/a.jpg', '/a/b.jpg', '/a.svg', '', null, undefined]) {
            expect(tmdbImageUrl(bad, 'w342')).toBeUndefined();
        }
    });

    it("reads Radarr's recorded images by remoteUrl, poster at w342 and fanart at w780", () => {
        expect(artworkFromImages(radarrImages)).toEqual({
            poster: 'https://image.tmdb.org/t/p/w342/qctzZ0LmG88k2DGqNMFTUW2wXo2.jpg',
            backdrop: 'https://image.tmdb.org/t/p/w780/hFtJz4TvoiJJcw2ZOMdhK22aU9P.jpg'
        });
    });

    it("reads Sonarr's recorded images from TheTVDB unchanged", () => {
        expect(artworkFromImages(sonarrImages)).toEqual({
            poster: 'https://artworks.thetvdb.com/banners/posters/292157-1.jpg',
            backdrop: 'https://artworks.thetvdb.com/banners/fanart/original/292157-2.jpg'
        });
    });

    it('never falls back to the *arr-local url when remoteUrl is missing', () => {
        expect(artworkFromImages([{ coverType: 'poster', url: '/MediaCover/1/poster.jpg' }])).toEqual({});
        expect(artworkFromImages(null)).toEqual({});
    });
});

describe('status mapping', () => {
    it.each([
        ['absent', { type: 'movie', inLibrary: false, monitored: true, hasFile: true }],
        ['downloading', { type: 'movie', inLibrary: true, monitored: true, hasFile: false, downloading: true }],
        ['downloaded', { type: 'movie', inLibrary: true, monitored: true, hasFile: true }],
        ['downloaded', { type: 'movie', inLibrary: true, monitored: false, hasFile: true }],
        ['monitored', { type: 'movie', inLibrary: true, monitored: true, hasFile: false }],
        ['unmonitored', { type: 'movie', inLibrary: true, monitored: false, hasFile: false }],
        ['downloaded', { type: 'series', inLibrary: true, monitored: true, episodes: { onDisk: 8, aired: 8 } }],
        ['monitored', { type: 'series', inLibrary: true, monitored: true, hasFile: true, episodes: { onDisk: 3, aired: 8 } }],
        ['downloaded', { type: 'series', inLibrary: true, monitored: false, hasFile: true, episodes: { onDisk: 3, aired: 8 } }],
        ['monitored', { type: 'series', inLibrary: true, monitored: true, episodes: { onDisk: 0, aired: 0 } }],
        ['unmonitored', { type: 'series', inLibrary: true, monitored: false, episodes: { onDisk: 0, aired: 0 } }],
        ['monitored', { type: 'series', inLibrary: true, monitored: true, hasFile: true }],
        ['downloading', { type: 'series', inLibrary: true, monitored: true, downloading: true, episodes: { onDisk: 8, aired: 8 } }]
    ] as const)('%s for %j', (expected, facts) => {
        expect(cardStatus(facts)).toBe(expected);
    });
});

describe('external links', () => {
    it('links TMDB by kind, and IMDb only for a real tt id', () => {
        expect(externalLinks('movie', { tmdb: 603, imdb: 'tt0133093' })).toEqual({
            tmdb: 'https://www.themoviedb.org/movie/603',
            imdb: 'https://www.imdb.com/title/tt0133093/'
        });
        expect(externalLinks('series', { tmdb: 1396 })).toEqual({ tmdb: 'https://www.themoviedb.org/tv/1396' });
        expect(externalLinks('movie', { tmdb: 0, imdb: 'javascript:alert(1)' })).toBeUndefined();
    });
});

describe('the adapters carry card fields, and only on display', () => {
    it("Radarr's details have the poster, backdrop, runtime and synopsis", async () => {
        const radarr = new RadarrAdapter(keyed(7878), serving({ '/api/v3/movie/340': fixture('radarr/movie-detail.json') }));
        const details = await radarr.getMediaDetails('340');
        expect(details.display?.poster).toBe('https://image.tmdb.org/t/p/w342/qctzZ0LmG88k2DGqNMFTUW2wXo2.jpg');
        expect(details.display?.backdrop).toBe('https://image.tmdb.org/t/p/w780/hFtJz4TvoiJJcw2ZOMdhK22aU9P.jpg');
        // Blade's recorded runtime is 0, which is Radarr's "unknown".
        expect(details.display?.runtimeMinutes).toBeUndefined();
        expect(JSON.stringify(details)).not.toContain('MediaCover');
    });

    it("Radarr's lookup says which hits it already manages", async () => {
        const radarr = new RadarrAdapter(keyed(7878), serving({ '/api/v3/movie/lookup': fixture('radarr/movie-lookup.json') }));
        const hits = await radarr.search('matrix', 'discover');
        expect(hits[0]?.display).toMatchObject({ poster: 'https://image.tmdb.org/t/p/w342/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg', inLibrary: false });
        expect(JSON.stringify(hits)).not.toContain('MediaCoverProxy');
    });

    it("Sonarr's library record has episode progress and seasons", async () => {
        const sonarr = new SonarrAdapter(keyed(8989), serving({ '/api/v3/series': fixture('sonarr/series.json') }));
        const [taboo] = await sonarr.listLibrary();
        expect(taboo?.display).toMatchObject({
            poster: 'https://artworks.thetvdb.com/banners/posters/292157-1.jpg',
            seasonCount: 1,
            episodes: { onDisk: 8, aired: 8 }
        });
    });

    it("Seerr's hits build TMDB URLs from posterPath and backdropPath", async () => {
        const seerr = new SeerrAdapter(multiUser(5055), serving({ '/api/v1/search': fixture('seerr/search.json') }));
        const [matrix] = await seerr.search('matrix', 'discover');
        expect(matrix?.display).toMatchObject({
            poster: 'https://image.tmdb.org/t/p/w342/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg',
            backdrop: 'https://image.tmdb.org/t/p/w780/tlm8UkiQsitc8rSuIAscQDCnP8d.jpg'
        });
    });

    it('withoutDisplay drops the field and nothing else', () => {
        const hit = { service: 'radarr', kind: 'movie', display: { poster: 'x' }, title: 't' };
        expect(withoutDisplay(hit)).toEqual({ service: 'radarr', kind: 'movie', title: 't' });
    });
});

const hit = (over: Partial<SearchHit>): SearchHit => ({
    service: 'radarr',
    source: 'discover',
    kind: 'movie',
    id: '603',
    title: 'The Matrix',
    year: 1999,
    ids: { tmdb: 603 },
    ...over
});

const queueOf = (id: string, rows: Partial<QueueItem>[]): ServiceAdapter =>
    ({ id, type: id, getQueue: async () => rows.map((r, i) => ({ service: id, id: String(i), title: 'x', status: 'downloading', ...r })) }) as unknown as ServiceAdapter;

describe('cards from search hits', () => {
    it('folds a title Radarr and Seerr both answered into one card, the managed one first', async () => {
        const cards = await cardsFromHits(
            [
                hit({ service: 'seerr', display: { poster: 'https://image.tmdb.org/t/p/w342/s.jpg' } }),
                hit({ id: '12', hasFile: true, monitored: true, display: { inLibrary: true } })
            ],
            []
        );
        expect(cards.items).toHaveLength(1);
        expect(cards.items[0]).toMatchObject({ status: 'downloaded', ref: { service: 'radarr', id: '12' }, poster: 'https://image.tmdb.org/t/p/w342/s.jpg' });
    });

    it('reads the queue for downloading, and survives a queue that will not answer', async () => {
        const ok = await cardsFromHits([hit({ id: '12', source: 'library', monitored: true, hasFile: false })], [queueOf('radarr', [{ mediaId: '12' }])]);
        expect(ok.items[0]?.status).toBe('downloading');

        const broken = { id: 'radarr', type: 'radarr', getQueue: async () => Promise.reject(new Error('down')) } as unknown as ServiceAdapter;
        const degraded = await cardsFromHits([hit({ id: '12', source: 'library', monitored: true, hasFile: false })], [broken]);
        expect(degraded.items[0]?.status).toBe('monitored');
    });

    it('leaves out releases and artists, and caps the grid', async () => {
        const many = Array.from({ length: MAX_CARDS + 5 }, (_, i) => hit({ id: String(i), title: `Film ${i}`, ids: { tmdb: 1000 + i } }));
        const cards = await cardsFromHits([...many, hit({ kind: 'release', source: 'indexers', title: 'x' }), hit({ kind: 'artist', title: 'y' })], []);
        expect(cards.items).toHaveLength(MAX_CARDS);
        expect(cards.total).toBe(MAX_CARDS + 5);
        expect(cards.items.every(c => c.status === 'absent')).toBe(true);
    });
});

type Handler = (
    args: Record<string, unknown>,
    extra: Record<string, unknown>
) => Promise<{
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
}>;

/** Where the cards ride: the result's `_meta`, never `structuredContent`. */
const cardsOf = (result: Awaited<ReturnType<Handler>>): MediaCards | undefined => {
    expect(result.structuredContent).not.toHaveProperty('cards');
    return result._meta?.['arr-mcp/cards'] as MediaCards | undefined;
};

const toolsOf = (register: (s: McpServer) => void): Record<string, { handler: Handler }> => {
    const server = new McpServer({ name: 'test', version: '0' });
    register(server);
    return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
};

const radarrLibrary = () =>
    new RadarrAdapter(
        keyed(7878),
        serving({
            '/api/v3/movie': fixture('radarr/movie.json'),
            '/api/v3/movie/lookup': fixture('radarr/movie-lookup.json'),
            '/api/v3/movie/340': fixture('radarr/movie-detail.json')
        })
    );

describe('the card tools', () => {
    it('search_media adds cards, and its items and text carry no artwork', async () => {
        const adapters = [radarrLibrary()];
        const result = await toolsOf(s => registerSearchMedia(s, adapters)).search_media!.handler(
            { query: 'Ghostbusters', source: 'library', detail: 'full', limit: 50, offset: 0 },
            {}
        );
        const structured = result.structuredContent!;
        const cards = cardsOf(result);
        expect(cards?.view).toBe('grid');
        expect(cards?.items[0]).toMatchObject({ type: 'movie', status: 'downloaded', ref: { service: 'radarr' } });
        expect(cards?.items[0]?.poster).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/w342\//);
        expect((structured['items'] as Record<string, unknown>[]).some(i => 'display' in i)).toBe(false);
        expect(result.content[0]?.text).not.toContain('image.tmdb.org');
        expect(result.content[0]?.text).toMatch(/^\d+ of \d+ library result\(s\) for "Ghostbusters"\./);
    });

    it('search_media discover adds cards for what is not in the library', async () => {
        const result = await toolsOf(s => registerSearchMedia(s, [radarrLibrary()])).search_media!.handler(
            { query: 'matrix', source: 'discover', detail: 'standard', limit: 50, offset: 0 },
            {}
        );
        const items = cardsOf(result)?.items ?? [];
        expect(items.length).toBeGreaterThan(1);
        expect(items.every(c => c.status === 'absent')).toBe(true);
        expect(items.find(c => c.ids.tmdb === 603)).toMatchObject({ title: '<<untrusted:radarr.title>>The Matrix<</>>', year: 1999 });
    });

    it('get_library caps its grid at twenty and keeps its items as they were', async () => {
        const adapters = [radarrLibrary()];
        const loader = new LibraryLoader(adapters, undefined);
        const result = await toolsOf(s => registerGetLibrary(s, loader, undefined, adapters)).get_library!.handler(
            { detail: 'minimal', limit: 50 },
            {}
        );
        const structured = result.structuredContent!;
        const cards = cardsOf(result);
        expect(cards?.items).toHaveLength(MAX_CARDS);
        expect(cards?.total).toBe(50);
        // `minimal` drops `acquisition`; the card still knows the status from the index.
        expect(cards?.items.some(c => c.status === 'downloaded')).toBe(true);
        expect(Object.keys((structured['items'] as Record<string, unknown>[])[0]!).sort()).toEqual(['ids', 'kind', 'presence', 'title', 'year']);
    });

    it('get_media_details by title answers with one detail card', async () => {
        const adapters = [radarrLibrary()];
        const loader = new LibraryLoader(adapters, undefined);
        const result = await toolsOf(s => registerGetMediaDetails(s, adapters, loader)).get_media_details!.handler(
            { query: 'Ghostbusters: Frozen Empire', detail: 'standard', limit: 50 },
            {}
        );
        const card = cardsOf(result);
        expect(card?.view).toBe('detail');
        expect(card?.items[0]).toMatchObject({
            type: 'movie',
            year: 2024,
            status: 'downloaded',
            runtimeMinutes: 115,
            links: { tmdb: 'https://www.themoviedb.org/movie/967847', imdb: 'https://www.imdb.com/title/tt21235248/' }
        });
        expect(card?.items[0]?.backdrop).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/w780\//);
        expect(card?.items[0]?.overview).toMatch(/^<<untrusted:radarr\.overview>>/);
    });

    it('get_media_details by id strips display from the raw view and still builds the card', async () => {
        const adapters = [radarrLibrary()];
        const result = await toolsOf(s => registerGetMediaDetails(s, adapters, new LibraryLoader(adapters, undefined))).get_media_details!.handler(
            { service: 'radarr', id: '340', detail: 'standard', limit: 50 },
            {}
        );
        expect(result.structuredContent).not.toHaveProperty('display');
        expect(cardsOf(result)?.items[0]).toMatchObject({ status: 'monitored', ref: { service: 'radarr', id: '340' } });
        expect(result.content[0]?.text).toBe('movie from radarr.');
    });
});

/** A request on the 2026-07-28 era carries the client's capabilities in its `_meta` envelope. */
const declaring = (extensions: Record<string, unknown>) => ({
    mcpReq: { envelope: { 'io.modelcontextprotocol/clientCapabilities': { extensions } } }
});

describe('cards only for a client that can render them', () => {
    const counting = () => {
        const adapter = radarrLibrary();
        let reads = 0;
        const real = adapter.getQueue.bind(adapter);
        adapter.getQueue = async () => {
            reads++;
            return real().catch(() => []);
        };
        return { adapter, reads: () => reads };
    };
    const search = { query: 'Ghostbusters', source: 'library', detail: 'standard', limit: 50, offset: 0 };

    it('builds none, and reads no queue, for a client that declares no MCP Apps support', async () => {
        const { adapter, reads } = counting();
        const result = await toolsOf(s => registerSearchMedia(s, [adapter])).search_media!.handler(search, declaring({}));
        expect(result._meta).toBeUndefined();
        expect(reads()).toBe(0);
        expect((result.structuredContent?.['items'] as unknown[]).length).toBeGreaterThan(0);
    });

    it('builds them for a client that declares the UI extension', async () => {
        const { adapter, reads } = counting();
        const result = await toolsOf(s => registerSearchMedia(s, [adapter])).search_media!.handler(
            search,
            declaring({ 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } })
        );
        expect(cardsOf(result)?.items.length).toBeGreaterThan(0);
        expect(reads()).toBe(1);
    });

    it('builds them when the client declared nothing the server can read (stateless HTTP)', async () => {
        const result = await toolsOf(s => registerSearchMedia(s, [radarrLibrary()])).search_media!.handler(search, {});
        expect(cardsOf(result)?.items.length).toBeGreaterThan(0);
    });

    it('builds none, and advertises no view, with tools.media_cards off', async () => {
        const { adapter, reads } = counting();
        const server = new McpServer({ name: 'test', version: '0' });
        registerSearchMedia(server, [adapter], undefined, false);
        const tool = (server as unknown as { _registeredTools: Record<string, { handler: Handler; _meta?: unknown }> })._registeredTools.search_media!;
        expect(tool._meta).toBeUndefined();
        const result = await tool.handler(search, {});
        expect(result._meta).toBeUndefined();
        expect(reads()).toBe(0);
    });
});

describe('episode progress', () => {
    it('counts each season up to what it wants, so an unmonitored season on disk cannot read "12 / 10"', () => {
        expect(
            episodesOf({
                statistics: { episodeFileCount: 12, episodeCount: 10 },
                seasons: [
                    { statistics: { episodeFileCount: 4, episodeCount: 0 } },
                    { statistics: { episodeFileCount: 7, episodeCount: 8 } },
                    { statistics: { episodeFileCount: 1, episodeCount: 2 } }
                ]
            })
        ).toEqual({ onDisk: 8, aired: 10 });
    });

    it('caps the series totals when there are no seasons', () => {
        expect(episodesOf({ statistics: { episodeFileCount: 12, episodeCount: 10 } })).toEqual({ onDisk: 10, aired: 10 });
        expect(episodesOf({})).toBeUndefined();
    });
});
