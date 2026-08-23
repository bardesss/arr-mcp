import { instancesOf } from './helpers/instances.ts';
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
    it('posts SeriesSearch with a bare seriesId, not an array when no target is given', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': { id: 99, name: 'SeriesSearch' } });
        const handle = await new SonarrAdapter(keyed(8989), impl).triggerSearch('7');

        expect(sent.find(s => s.method === 'POST')?.body).toEqual({ name: 'SeriesSearch', seriesId: 7 });
        expect(handle.service).toBe('sonarr');
        expect(handle.commandId).toBe(99);
    });

    // These two payloads are spec-derived, not verified against a live
    // Sonarr: posting one runs a real search on the user's stack, and Sonarr
    // accepts a command matching nothing and reports success — a probe
    // cannot tell a right field name from a wrong one.
    it('posts SeasonSearch with the series id and season number for a season target', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': { id: 100, name: 'SeasonSearch' } });
        const handle = await new SonarrAdapter(keyed(8989), impl).triggerSearch('7', { season: 2 });

        expect(sent.find(s => s.method === 'POST')?.body).toEqual({
            name: 'SeasonSearch',
            seriesId: 7,
            seasonNumber: 2
        });
        expect(handle.commandId).toBe(100);
    });

    it('posts EpisodeSearch with numeric episode ids for an episode target', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': { id: 101, name: 'EpisodeSearch' } });
        await new SonarrAdapter(keyed(8989), impl).triggerSearch('7', { episodes: ['901', '902'] });

        const body = sent.find(s => s.method === 'POST')?.body as { episodeIds: unknown[] };
        expect(body).toEqual({ name: 'EpisodeSearch', episodeIds: [901, 902] });
        expect(body.episodeIds.every(v => typeof v === 'number')).toBe(true);
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
            permissions: permissionSourceFrom(instancesOf(opts.permissions ?? { radarr: permissive(true), sonarr: permissive(true) })),
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
            type: 'jellyfin' as ServiceId,
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

// --- season and episode scope ---------------------------------------------

const SERIES_WITH_SEASONS = {
    id: 7,
    title: 'Alien: Earth',
    year: 2025,
    monitored: true,
    seasons: [
        { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8 } },
        { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 2 } }
    ]
};

const EPISODES_S2 = [
    { id: 901, seriesId: 7, seasonNumber: 2, episodeNumber: 1, title: 'Ep1', hasFile: true, monitored: true },
    { id: 902, seriesId: 7, seasonNumber: 2, episodeNumber: 2, title: 'Ep2', hasFile: true, monitored: true }
];

describe('trigger_search scope', () => {
    it('applies a whole-series search when neither season nor episodes is given', async () => {
        const sonarrFetch = recordingFetch({
            '/api/v3/series/7': SERIES_WITH_SEASONS,
            '/api/v3/command': { id: 200, name: 'SeriesSearch' }
        });
        const h = harness({
            adapters: [new SonarrAdapter(keyed(8989), sonarrFetch.impl)],
            permissions: { sonarr: permissive(true) }
        });

        const first = await h.call({ service: 'sonarr', id: '7' });
        await h.call({ service: 'sonarr', id: '7', confirm: first.structuredContent.confirm_token });

        expect(sonarrFetch.sent.find(s => s.method === 'POST')?.body).toEqual({ name: 'SeriesSearch', seriesId: 7 });
    });

    it('applies a SeasonSearch once confirmed', async () => {
        const sonarrFetch = recordingFetch({
            '/api/v3/series/7': SERIES_WITH_SEASONS,
            '/api/v3/command': { id: 201, name: 'SeasonSearch' }
        });
        const h = harness({
            adapters: [new SonarrAdapter(keyed(8989), sonarrFetch.impl)],
            permissions: { sonarr: permissive(true) }
        });

        const first = await h.call({ service: 'sonarr', id: '7', season: 2 });
        expect(first.structuredContent.summary).toContain('season 2');
        await h.call({ service: 'sonarr', id: '7', season: 2, confirm: first.structuredContent.confirm_token });

        expect(sonarrFetch.sent.find(s => s.method === 'POST')?.body).toEqual({
            name: 'SeasonSearch',
            seriesId: 7,
            seasonNumber: 2
        });
    });

    it('applies an EpisodeSearch once confirmed', async () => {
        const sonarrFetch = recordingFetch({
            '/api/v3/series/7': SERIES_WITH_SEASONS,
            '/api/v3/episode': EPISODES_S2,
            '/api/v3/command': { id: 202, name: 'EpisodeSearch' }
        });
        const h = harness({
            adapters: [new SonarrAdapter(keyed(8989), sonarrFetch.impl)],
            permissions: { sonarr: permissive(true) }
        });

        const first = await h.call({ service: 'sonarr', id: '7', episodes: ['901', '902'] });
        await h.call({ service: 'sonarr', id: '7', episodes: ['901', '902'], confirm: first.structuredContent.confirm_token });

        expect(sonarrFetch.sent.find(s => s.method === 'POST')?.body).toEqual({
            name: 'EpisodeSearch',
            episodeIds: [901, 902]
        });
    });

    it('refuses season and episodes together instead of picking one', async () => {
        const sonarrFetch = recordingFetch({ '/api/v3/series/7': SERIES_WITH_SEASONS });
        const h = harness({
            adapters: [new SonarrAdapter(keyed(8989), sonarrFetch.impl)],
            permissions: { sonarr: permissive(true) }
        });

        await expect(h.call({ service: 'sonarr', id: '7', season: 2, episodes: ['901'] })).rejects.toThrow(/send one/);
        expect(sonarrFetch.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    // Sonarr accepts a command matching nothing and reports success, so an
    // unvalidated write here is a search that silently searches for nothing.
    it('refuses a season the series does not have, naming the ones it does', async () => {
        const sonarrFetch = recordingFetch({ '/api/v3/series/7': SERIES_WITH_SEASONS });
        const h = harness({
            adapters: [new SonarrAdapter(keyed(8989), sonarrFetch.impl)],
            permissions: { sonarr: permissive(true) }
        });

        await expect(h.call({ service: 'sonarr', id: '7', season: 9 })).rejects.toThrow(/1, 2/);
        expect(sonarrFetch.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('refuses an episode id it could not find', async () => {
        const sonarrFetch = recordingFetch({
            '/api/v3/series/7': SERIES_WITH_SEASONS,
            '/api/v3/episode': EPISODES_S2
        });
        const h = harness({
            adapters: [new SonarrAdapter(keyed(8989), sonarrFetch.impl)],
            permissions: { sonarr: permissive(true) }
        });

        await expect(h.call({ service: 'sonarr', id: '7', episodes: ['901', '999'] })).rejects.toThrow(/999/);
        expect(sonarrFetch.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('refuses season on radarr, which has no seasons', async () => {
        const h = harness({ permissions: { radarr: permissive(true) } });
        await expect(h.call({ service: 'radarr', id: '5', season: 1 })).rejects.toThrow(/no seasons/);
    });

    it('refuses episodes on radarr, which has no seasons', async () => {
        const h = harness({ permissions: { radarr: permissive(true) } });
        await expect(h.call({ service: 'radarr', id: '5', episodes: ['1'] })).rejects.toThrow(/no seasons/);
    });

    // The token is bound to `args`, so a token issued for one scope must not
    // authorise a write with a different one — a season-2 token replayed
    // against a whole-series call is the scope-conflation failure this task
    // exists to prevent, now caught by the confirm handshake instead of Sonarr.
    it('does not let a token issued for one season apply to a whole-series search', async () => {
        const sonarrFetch = recordingFetch({
            '/api/v3/series/7': SERIES_WITH_SEASONS,
            '/api/v3/command': { id: 203, name: 'SeriesSearch' }
        });
        const h = harness({
            adapters: [new SonarrAdapter(keyed(8989), sonarrFetch.impl)],
            permissions: { sonarr: permissive(true) }
        });

        const seasonPreview = await h.call({ service: 'sonarr', id: '7', season: 2 });
        const token = seasonPreview.structuredContent.confirm_token;
        expect(token).toBeTypeOf('string');

        const wholeSeriesAttempt = await h.call({ service: 'sonarr', id: '7', confirm: token });
        expect(wholeSeriesAttempt.structuredContent.applied).toBe(false);
        expect(wholeSeriesAttempt.structuredContent.confirm_error).toBeDefined();
        expect(sonarrFetch.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });
});
