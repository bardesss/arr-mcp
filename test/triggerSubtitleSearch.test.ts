import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { BazarrAdapter } from '../src/services/bazarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerTriggerSubtitleSearch } from '../src/tools/triggerSubtitleSearch.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const permissive = (safe_write: boolean, destructive = false): AnyServiceConfig =>
    ({ ...keyed(6767), permissions: { safe_write, destructive } }) as AnyServiceConfig;

const MOVIES = {
    data: [
        {
            radarrId: 1445,
            title: 'Good Boy',
            missing_subtitles: [
                { name: 'Dutch', code2: 'nl', forced: false, hi: false },
                { name: 'English', code2: 'en', forced: false, hi: false }
            ]
        }
    ]
};

const EPISODES = {
    data: [
        {
            sonarrEpisodeId: 5169,
            sonarrSeriesId: 67,
            seriesTitle: 'Rick and Morty',
            episodeTitle: 'Mortyplicity',
            episode_number: '5x2',
            missing_subtitles: [{ name: 'Dutch', code2: 'nl', forced: false, hi: false }]
        }
    ]
};

function recordingFetch(routes: Record<string, unknown> = { '/api/movies/wanted': MOVIES, '/api/episodes/wanted': EPISODES }) {
    const sent: { path: string; method: string; query: Record<string, string> }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({
            path: url.pathname,
            method: init?.method ?? 'GET',
            query: Object.fromEntries(url.searchParams)
        });
        if (init?.method === 'PATCH') return new Response(null, { status: 204 });
        if (url.pathname in routes) return jsonResponse(routes[url.pathname]);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent, patches: () => sent.filter(s => s.method === 'PATCH') };
}

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: { permissions?: Partial<Record<ServiceId, AnyServiceConfig>>; adapters?: ServiceAdapter[]; routes?: Record<string, unknown> } = {}) {
    const bazarrFetch = recordingFetch(opts.routes);
    const adapters = opts.adapters ?? [new BazarrAdapter(keyed(6767), bazarrFetch.impl)];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_name: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    registerTriggerSubtitleSearch(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(opts.permissions ?? { bazarr: permissive(true) })),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (args: Record<string, unknown>) => call(args), bazarrFetch };
}

const movie = { service: 'bazarr', kind: 'movie', id: '1445', language: 'nl' };
const episode = { service: 'bazarr', kind: 'episode', id: '5169', language: 'nl' };

describe('trigger_subtitle_search', () => {
    it('previews with the real title and the language, not the bare id', async () => {
        const { structuredContent } = await harness().call({ ...movie, dry_run: true });
        expect(structuredContent.summary).toContain('Good Boy');
        expect(structuredContent.summary).toContain('Dutch');
        expect(structuredContent.target).toBe('bazarr:movie:1445:nl');
    });

    it('names the episode by its position, not just the series', async () => {
        const { structuredContent } = await harness().call({ ...episode, dry_run: true });
        expect(structuredContent.summary).toContain('Rick and Morty');
        expect(structuredContent.summary).toContain('5x2');
    });

    it('changes nothing on a dry run', async () => {
        const h = harness();
        await h.call({ ...movie, dry_run: true });
        expect(h.bazarrFetch.patches()).toHaveLength(0);
    });

    it('does not search on the first call, then does on the confirmed one', async () => {
        const h = harness();
        const first = await h.call(movie);
        expect(h.bazarrFetch.patches()).toHaveLength(0);

        const second = await h.call({ ...movie, confirm: first.structuredContent.confirm_token });
        expect(second.structuredContent.applied).toBe(true);
        expect(h.bazarrFetch.patches()).toHaveLength(1);
        expect(h.bazarrFetch.patches()[0]?.query).toMatchObject({ radarrid: '1445', language: 'nl' });
    });

    // The model passes the episode id it saw from get_subtitles; the series id
    // is resolved here rather than being one more thing to get right.
    it('resolves the series id itself for an episode', async () => {
        const h = harness();
        const first = await h.call(episode);
        await h.call({ ...episode, confirm: first.structuredContent.confirm_token });

        expect(h.bazarrFetch.patches()[0]?.query).toMatchObject({ seriesid: '67', episodeid: '5169' });
    });

    it('is a no-op when that language is not actually missing', async () => {
        const { structuredContent } = await harness().call({ ...movie, language: 'fr', dry_run: true });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    it('fails naming the item when Bazarr does not know the id', async () => {
        const h = harness();
        await expect(h.call({ ...movie, id: '9999', dry_run: true })).rejects.toThrow(/9999/);
        expect(h.bazarrFetch.patches()).toHaveLength(0);
    });

    it('is a safe-tier write, so safe_write alone is enough', async () => {
        const first = await harness({ permissions: { bazarr: permissive(true, false) } }).call(movie);
        expect(first.structuredContent.tier).toBe('safe');
        expect(first.structuredContent.confirm_token).toBeTypeOf('string');
    });

    it('refuses when safe_write is off for bazarr', async () => {
        const h = harness({ permissions: { bazarr: permissive(false) } });
        await expect(h.call(movie)).rejects.toThrow(/services\.bazarr\.permissions\.safe_write: true/);
    });

    it('refuses a configured service that cannot search for subtitles', async () => {
        const radarr = {
            id: 'radarr' as ServiceId,
            type: 'radarr' as ServiceId,
            testConnection: () => Promise.reject(new Error('unused')),
            getVersion: () => Promise.resolve('4.0.0')
        } as unknown as ServiceAdapter;

        const h = harness({ adapters: [radarr], permissions: { radarr: permissive(true) } });
        await expect(h.call({ ...movie, service: 'radarr', dry_run: true })).rejects.toThrow(/subtitle/i);
    });

    it('refuses an unconfigured service by name', async () => {
        const h = harness({ adapters: [] });
        await expect(h.call({ ...movie, dry_run: true })).rejects.toThrow(/not configured/);
    });

    it('reports that the search was queued rather than that a subtitle arrived', async () => {
        const h = harness();
        const first = await h.call(movie);
        const second = await h.call({ ...movie, confirm: first.structuredContent.confirm_token });
        expect(second.content[0]?.text.toLowerCase()).not.toContain('downloaded');
    });
});
