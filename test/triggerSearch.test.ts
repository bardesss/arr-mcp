import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerTriggerSearch } from '../src/tools/triggerSearch.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const permissive = (safe_write: boolean, destructive = false): AnyServiceConfig =>
    ({ ...keyed(7878), permissions: { safe_write, destructive } }) as AnyServiceConfig;

/** Records what was actually sent, which is the whole point for a write. */
function recordingFetch(routes: Record<string, unknown>) {
    const sent: { url: string; method: string; body: unknown }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({
            url: url.pathname,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        });
        if (url.pathname in routes) return jsonResponse(routes[url.pathname]);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

const MOVIE = { id: 5, title: 'Alien', year: 1979, monitored: true, hasFile: true };
const SERIES = { id: 7, title: 'Alien: Earth', year: 2025, monitored: true, statistics: { episodeFileCount: 3 } };
const COMMAND = { id: 4321, name: 'MoviesSearch', status: 'queued' };

describe('RadarrAdapter.triggerSearch', () => {
    it('posts MoviesSearch with the id in an array, as Radarr requires', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': COMMAND });
        const handle = await new RadarrAdapter(keyed(7878), impl).triggerSearch('5');

        const post = sent.find(s => s.method === 'POST');
        expect(post?.url).toBe('/api/v3/command');
        expect(post?.body).toEqual({ name: 'MoviesSearch', movieIds: [5] });
        expect(handle).toEqual({ service: 'radarr', commandId: 4321, name: 'MoviesSearch', status: 'queued' });
    });

    // A string in `movieIds` is accepted by Radarr and matches nothing, so a
    // search that never ran would report success.
    it('sends the id as a number, not a string', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': COMMAND });
        await new RadarrAdapter(keyed(7878), impl).triggerSearch('5');

        const body = sent.find(s => s.method === 'POST')?.body as { movieIds: unknown[] };
        expect(body.movieIds[0]).toBeTypeOf('number');
    });

    it('refuses a non-numeric id rather than posting a search for NaN', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': COMMAND });
        await expect(new RadarrAdapter(keyed(7878), impl).triggerSearch('Alien')).rejects.toThrow(ServiceError);
        expect(sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });
});

describe('SonarrAdapter.triggerSearch', () => {
    // Upstream's own asymmetry: a bare id here, an array in Radarr. Passing
    // Radarr's shape is accepted and searches nothing.
    it('posts SeriesSearch with a bare seriesId, not an array', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': { id: 99, name: 'SeriesSearch' } });
        const handle = await new SonarrAdapter(keyed(8989), impl).triggerSearch('7');

        expect(sent.find(s => s.method === 'POST')?.body).toEqual({ name: 'SeriesSearch', seriesId: 7 });
        expect(handle.service).toBe('sonarr');
        expect(handle.commandId).toBe(99);
    });
});

// --- the tool ------------------------------------------------------------

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: { permissions?: Partial<Record<ServiceId, AnyServiceConfig>>; adapters?: ServiceAdapter[] } = {}) {
    const radarrFetch = recordingFetch({ '/api/v3/movie/5': MOVIE, '/api/v3/command': COMMAND });
    const sonarrFetch = recordingFetch({
        '/api/v3/series/7': SERIES,
        '/api/v3/command': { id: 99, name: 'SeriesSearch' }
    });

    const adapters = opts.adapters ?? [
        new RadarrAdapter(keyed(7878), radarrFetch.impl),
        new SonarrAdapter(keyed(8989), sonarrFetch.impl)
    ];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_name: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const invalidate = vi.fn();
    registerTriggerSearch(
        server as never,
        {
            permissions: permissionSourceFrom(opts.permissions ?? { radarr: permissive(true), sonarr: permissive(true) }),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (args: Record<string, unknown>) => call(args), radarrFetch, sonarrFetch, invalidate };
}

describe('trigger_search', () => {
    it('previews with the real title, not the bare id', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'radarr', id: '5', dry_run: true });

        expect(structuredContent.summary).toContain('Alien');
        expect(structuredContent.summary).toContain('1979');
        expect(structuredContent.target).toBe('radarr:5');
    });

    it('changes nothing on a dry run', async () => {
        const h = harness();
        await h.call({ service: 'radarr', id: '5', dry_run: true });
        expect(h.radarrFetch.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('does not search on the first call, then does on the confirmed one', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', id: '5' });
        expect(h.radarrFetch.sent.filter(s => s.method === 'POST')).toHaveLength(0);

        const second = await h.call({ service: 'radarr', id: '5', confirm: first.structuredContent.confirm_token });
        expect(second.structuredContent.applied).toBe(true);
        expect(h.radarrFetch.sent.filter(s => s.method === 'POST')).toHaveLength(1);
    });

    it('warns that an upgrade may replace an existing file', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'radarr', id: '5', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('upgrade');
    });

    it('says so when the item is not monitored, rather than letting it look like a no-op', async () => {
        const unmonitored = recordingFetch({ '/api/v3/movie/5': { ...MOVIE, monitored: false } });
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), unmonitored.impl)] });

        const { structuredContent } = await h.call({ service: 'radarr', id: '5', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('not monitored');
    });

    // The reason the harness resolves `service` from the arguments: a fixed id
    // would have checked Sonarr writes against Radarr's permissions block.
    it('checks the permission of the service named in the arguments', async () => {
        const h = harness({ permissions: { radarr: permissive(true), sonarr: permissive(false) } });

        const allowed = await h.call({ service: 'radarr', id: '5' });
        expect(allowed.structuredContent.confirm_token).toBeTypeOf('string');

        await expect(h.call({ service: 'sonarr', id: '7' })).rejects.toThrow(
            /services\.sonarr\.permissions\.safe_write: true/
        );
    });

    it('is a safe-tier write, so safe_write alone is enough', async () => {
        const h = harness({ permissions: { radarr: permissive(true, false) } });
        const first = await h.call({ service: 'radarr', id: '5' });
        expect(first.structuredContent.tier).toBe('safe');
        expect(first.structuredContent.confirm_token).toBeTypeOf('string');
    });

    it('refuses a configured service that has no search to trigger', async () => {
        // Present in the adapter list, so this exercises the capability check
        // rather than falling through to "not configured" — two different
        // refusals with two different remedies.
        const jellyfin = {
            id: 'jellyfin' as ServiceId,
            testConnection: () => Promise.reject(new Error('unused')),
            getVersion: () => Promise.resolve('10.8.0')
        } as unknown as ServiceAdapter;

        const h = harness({ adapters: [jellyfin], permissions: { jellyfin: permissive(true) } });
        await expect(h.call({ service: 'jellyfin', id: '5', dry_run: true })).rejects.toThrow(/cannot be told to search/);
    });

    it('refuses an unconfigured service by name', async () => {
        const h = harness({ adapters: [] });
        await expect(h.call({ service: 'radarr', id: '5', dry_run: true })).rejects.toThrow(/not configured/);
    });

    // The read before the write: a bad id fails legibly at plan time rather
    // than as a confusing 404 from a command endpoint.
    it('fails naming the item when the id does not exist', async () => {
        const empty = recordingFetch({});
        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), empty.impl)] });

        await expect(h.call({ service: 'radarr', id: '9999', dry_run: true })).rejects.toThrow(ServiceError);
        expect(empty.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('reports the queued command rather than claiming a release was found', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', id: '5' });
        const second = await h.call({ service: 'radarr', id: '5', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.result).toMatchObject({ commandId: 4321, name: 'MoviesSearch' });
        expect(second.content[0]?.text).not.toContain('found');
    });
});
