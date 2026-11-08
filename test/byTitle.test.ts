import { describe, expect, it } from 'vitest';
import type * as z from 'zod/v4';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { fenceText } from '../src/core/fence.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { itemByTitle, jellyfinIdByTitle, managedIdByTitle } from '../src/tools/byTitle.ts';
import { registerGetReleases } from '../src/tools/getReleases.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import { serving } from './helpers/serve.ts';

// A title in place of an id (#518's eval): one call instead of get_media_details first.

const film = (title: string, tmdb: number, id: string, year = 2026, extra: Partial<IndexInput> = {}): IndexInput => ({
    kind: 'movie',
    title: fenceText(title, { service: 'radarr', field: 'title' }),
    year,
    ids: { tmdb },
    acquisition: { service: 'radarr', id, monitored: true, hasFile: true },
    ...extra
});

const series = (title: string, tvdb: number, id: string): IndexInput => ({
    kind: 'series',
    title: fenceText(title, { service: 'sonarr', field: 'title' }),
    year: 2008,
    ids: { tvdb },
    acquisition: { service: 'sonarr', id, monitored: true, hasFile: true }
});

const loaderOf = (rows: IndexInput[]) => {
    const source = {
        id: 'radarr',
        testConnection: async () => ({ ok: true, service: 'radarr', latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        listLibrary: async () => rows,
        search: async () => []
    } as unknown as ServiceAdapter;
    return { adapters: [source], loader: new LibraryLoader([source], undefined) };
};

describe('a title in place of an id', () => {
    it('resolves to the managing service’s id', async () => {
        const { adapters, loader } = loaderOf([film('Arrival', 1, '340'), series('Breaking Bad', 2, '15')]);
        expect(await managedIdByTitle(adapters, loader, 'Breaking Bad', 'sonarr')).toBe('15');
    });

    it('refuses a tie and names every match with its id', async () => {
        const { adapters, loader } = loaderOf([film('Dune', 1, '1', 2021), film('Dune', 2, '2', 1984)]);
        const err = await itemByTitle(adapters, loader, 'Dune').catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/matches more than one title equally well/);
        expect((err as Error).message).toContain('(2021) — radarr id 1');
        expect((err as Error).message).toContain('(1984) — radarr id 2');
    });

    it('keeps titles fenced in a refusal', async () => {
        const { adapters, loader } = loaderOf([film('Dune', 1, '1', 2021), film('Dune', 2, '2', 1984)]);
        await expect(itemByTitle(adapters, loader, 'Dune')).rejects.toThrow('<<untrusted:radarr.title>>Dune<</>>');
    });

    it('refuses a title another service manages', async () => {
        const { adapters, loader } = loaderOf([film('Arrival', 1, '340')]);
        await expect(managedIdByTitle(adapters, loader, 'Arrival', 'sonarr')).rejects.toThrow(/is managed by radarr, not sonarr/);
    });

    it('carries the lookup answer on a miss', async () => {
        const { adapters, loader } = loaderOf([film('Arrival', 1, '340')]);
        await expect(managedIdByTitle(adapters, loader, 'The Matrix', 'radarr')).rejects.toThrow(/^Nothing in your library matches "The Matrix"\. No metadata lookup/);
    });

    it('reads the Jellyfin id from playback with one media server', async () => {
        const { adapters, loader } = loaderOf([film('Arrival', 1, '340', 2016, { playback: { user: 'Sam', itemId: 'jf-1', watched: false } })]);
        expect(await jellyfinIdByTitle(adapters, loader, 'Arrival')).toBe('jf-1');
    });

    it('reads the Jellyfin id from media_servers when Plex is primary', async () => {
        const rows = [
            film('Arrival', 1, '340', 2016, {
                playback: { user: 'Sam', itemId: 'plex-9', watched: false },
                media_servers: { plex: { present: true, itemId: 'plex-9' }, jellyfin: { present: true, itemId: 'jf-1' } }
            })
        ];
        const { adapters, loader } = loaderOf(rows);
        expect(await jellyfinIdByTitle(adapters, loader, 'Arrival')).toBe('jf-1');
    });

    it('says so when Jellyfin does not have it', async () => {
        const { adapters, loader } = loaderOf([film('Arrival', 1, '340')]);
        await expect(jellyfinIdByTitle(adapters, loader, 'Arrival')).rejects.toThrow(/is not in Jellyfin/);
    });
});

describe('get_releases by title', () => {
    const keyed: KeyedServiceConfig = { url: 'http://192.0.2.10:7878', api_key: 'k', timeout_ms: 10_000, permissions: { safe_write: false, destructive: false } };
    const releases = [{ guid: 'g', indexerId: 1, indexer: 'Idx', title: 'Arrival.2016.1080p', rejected: false, rejections: [] }];

    const tool = () => {
        const radarr = new RadarrAdapter(keyed, serving({ '/api/v3/release?movieId=340': releases }));
        const { loader } = loaderOf([film('Arrival', 1, '340')]);
        let handler: (args: Record<string, unknown>) => Promise<{ structuredContent: { items: unknown[] } }> = () => Promise.reject(new Error('unregistered'));
        const server = {
            registerTool(_n: string, cfg: { inputSchema: z.ZodObject }, h: (a: Record<string, unknown>) => Promise<{ structuredContent: { items: unknown[] } }>) {
                handler = args => h(cfg.inputSchema.parse(args) as Record<string, unknown>);
            }
        };
        registerGetReleases(server as never, [radarr], loader);
        return (args: Record<string, unknown>) => handler(args);
    };

    it('searches the item the title resolves to', async () => {
        const result = await tool()({ service: 'radarr', title: 'Arrival' });
        expect(result.structuredContent.items).toHaveLength(1);
    });

    it('refuses both an id and a title, and neither', async () => {
        await expect(tool()({ service: 'radarr', title: 'Arrival', id: '340' })).rejects.toThrow(/either `id` or `title`/);
        await expect(tool()({ service: 'radarr' })).rejects.toThrow(/either `id` or `title`/);
    });
});
