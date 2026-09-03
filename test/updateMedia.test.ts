import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerUpdateMedia } from '../src/tools/updateMedia.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const tiered = (safe_write: boolean, destructive = false): AnyServiceConfig =>
    ({ ...keyed(7878), permissions: { safe_write, destructive } }) as AnyServiceConfig;

const PROFILES = [
    { id: 4, name: 'HD-1080p' },
    { id: 5, name: 'Ultra-HD' }
];
const FOLDERS = [
    { path: '/movies', freeSpace: 2_000_000_000_000 },
    { path: '/movies-4k', freeSpace: 500_000_000_000 }
];
const TAGS = [
    { id: 1, label: '4k' },
    { id: 2, label: 'kids' }
];

const MOVIE = {
    id: 15,
    title: 'Heat',
    year: 1995,
    monitored: true,
    qualityProfileId: 4,
    path: '/movies/Heat (1995)',
    rootFolderPath: '/movies',
    tags: [],
    minimumAvailability: 'released'
};

const SERIES = { id: 7, title: 'Taboo', year: 2017, monitored: true, qualityProfileId: 4, tags: [], seriesType: 'standard' };

function stack(resource: 'movie' | 'series' = 'movie', current: Record<string, unknown> = MOVIE) {
    const sent: { path: string; search: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    const id = current.id as number;

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({
            path: url.pathname,
            search: url.search,
            method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });

        if (url.pathname === '/api/v3/qualityprofile') return jsonResponse(PROFILES);
        if (url.pathname === '/api/v3/rootfolder') return jsonResponse(FOLDERS);
        if (url.pathname === '/api/v3/tag') return jsonResponse(TAGS);
        if (url.pathname === `/api/v3/${resource}/${id}`) {
            return jsonResponse(
                method === 'PUT' ? { ...current, ...(JSON.parse(String(init?.body)) as object) } : current
            );
        }
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: { adapters?: ServiceAdapter[]; sent?: unknown } = {}, impl?: typeof fetch) {
    const s = impl === undefined ? stack() : { impl, sent: [] as never[] };
    const adapters = opts.adapters ?? [new RadarrAdapter(keyed(7878), s.impl)];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const invalidate = vi.fn();
    registerUpdateMedia(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf({ radarr: tiered(true), sonarr: tiered(true) })),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a), invalidate };
}

/** Preview, then confirm with the token the preview handed back. */
async function apply(h: ReturnType<typeof harness>, args: Record<string, unknown>) {
    const first = await h.call(args);
    return h.call({ ...args, confirm: first.structuredContent.confirm_token });
}

describe('update_media previews', () => {
    it('names what it is changing from and to', async () => {
        const h = harness();
        const { structuredContent } = await h.call({
            service: 'radarr',
            id: '15',
            quality_profile: 'Ultra-HD',
            dry_run: true
        });

        expect(structuredContent.effects.join(' ')).toContain('HD-1080p');
        expect(structuredContent.effects.join(' ')).toContain('Ultra-HD');
        expect(structuredContent.summary).toContain('Heat');
    });

    it('spells out that a root folder change moves files on disk', async () => {
        const h = harness();
        const { structuredContent } = await h.call({
            service: 'radarr',
            id: '15',
            root_folder: '/movies-4k',
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toMatch(/moves the files/i);
        expect(structuredContent.effects.join(' ')).toContain('/movies-4k');
    });

    it('says the files will read as missing when move_files is false', async () => {
        const h = harness();
        const { structuredContent } = await h.call({
            service: 'radarr',
            id: '15',
            root_folder: '/movies-4k',
            move_files: false,
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toMatch(/missing/i);
    });

    it('is a no-op when the item is already set that way', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'radarr', id: '15', monitored: true });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    it('refuses when no field was named', async () => {
        const h = harness();
        await expect(h.call({ service: 'radarr', id: '15', dry_run: true })).rejects.toThrow(/nothing to change/i);
    });

    it('writes nothing while previewing', async () => {
        const s = stack();
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), s.impl)] });
        await h.call({ service: 'radarr', id: '15', quality_profile: 'Ultra-HD' });
        expect(s.sent.filter(x => x.method === 'PUT')).toHaveLength(0);
    });
});

describe('update_media applying', () => {
    it('puts the resolved profile back and invalidates the library', async () => {
        const s = stack();
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), s.impl)] });
        const result = await apply(h, { service: 'radarr', id: '15', quality_profile: 'Ultra-HD' });

        expect(result.structuredContent.applied).toBe(true);
        expect(s.sent.find(x => x.method === 'PUT')?.body).toMatchObject({ qualityProfileId: 5, title: 'Heat' });
        expect(h.invalidate).toHaveBeenCalledTimes(1);
    });

    it('turns Radarr monitoring off, which set_monitoring never could', async () => {
        const s = stack();
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), s.impl)] });
        await apply(h, { service: 'radarr', id: '15', monitored: false });
        expect(s.sent.find(x => x.method === 'PUT')?.body?.monitored).toBe(false);
    });

    it('posts the raw root folder path, never the fenced display form', async () => {
        const s = stack();
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), s.impl)] });
        await apply(h, { service: 'radarr', id: '15', root_folder: '/movies-4k' });

        const put = s.sent.find(x => x.method === 'PUT');
        expect(put?.body?.rootFolderPath).toBe('/movies-4k');
        expect(put?.search).toContain('moveFiles=true');
        expect(JSON.stringify(put?.body)).not.toContain('untrusted');
    });

    it('replaces the tag set rather than adding to it', async () => {
        const s = stack('movie', { ...MOVIE, tags: [2] });
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), s.impl)] });
        await apply(h, { service: 'radarr', id: '15', tags: ['4k'] });
        expect(s.sent.find(x => x.method === 'PUT')?.body?.tags).toEqual([1]);
    });

    it('clears the tags when given an empty list', async () => {
        const s = stack('movie', { ...MOVIE, tags: [1] });
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), s.impl)] });
        await apply(h, { service: 'radarr', id: '15', tags: [] });
        expect(s.sent.find(x => x.method === 'PUT')?.body?.tags).toEqual([]);
    });

    it('changes the series type on Sonarr', async () => {
        const s = stack('series', SERIES);
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)] });
        await apply(h, { service: 'sonarr', id: '7', series_type: 'anime' });
        expect(s.sent.find(x => x.method === 'PUT')?.body?.seriesType).toBe('anime');
    });
});

describe('update_media refusals', () => {
    it('refuses series_type on Radarr', async () => {
        const h = harness();
        await expect(
            h.call({ service: 'radarr', id: '15', series_type: 'anime', dry_run: true })
        ).rejects.toThrow(/sonarr option/i);
    });

    it('refuses minimum_availability on Sonarr, naming what to use instead', async () => {
        const s = stack('series', SERIES);
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)] });
        await expect(
            h.call({ service: 'sonarr', id: '7', minimum_availability: 'announced', dry_run: true })
        ).rejects.toThrow(/set_monitoring|episode/i);
    });

    it('refuses an unknown profile, listing the ones that exist', async () => {
        const h = harness();
        await expect(
            h.call({ service: 'radarr', id: '15', quality_profile: 'nope', dry_run: true })
        ).rejects.toThrow(/HD-1080p/);
    });

    it('refuses an ambiguous tag rather than picking one', async () => {
        const h = harness();
        await expect(h.call({ service: 'radarr', id: '15', tags: ['nope'], dry_run: true })).rejects.toThrow(/4k/);
    });

    it('refuses a service that cannot update media', async () => {
        const h = harness({
            adapters: [
                {
                    id: 'jellyfin',
                    type: 'jellyfin',
                    testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 }),
                    getVersion: async () => '10'
                } as unknown as ServiceAdapter
            ]
        });
        await expect(h.call({ service: 'jellyfin', id: '15', monitored: false, dry_run: true })).rejects.toThrow(
            /cannot update media/i
        );
    });
});
