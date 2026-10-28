import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerSetMonitoring } from '../src/tools/setMonitoring.ts';
import { instancesOf } from './helpers/instances.ts';

const lidarrConfig: KeyedServiceConfig = {
    url: 'http://192.0.2.10:8686',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
};

const ARTISTS = [
    { id: 1, artistName: 'Alex G', monitored: true, monitorNewItems: 'all' },
    { id: 2, artistName: 'Andy Shauf', monitored: false, monitorNewItems: 'none' }
];
const ALBUM = { id: 7, title: 'House of Sugar', releaseDate: '2019-09-13', monitored: true, artist: { artistName: 'Alex G' } };

function recordingFetch(routes: Record<string, unknown>) {
    const sent: { path: string; method: string; body: unknown }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({
            path: url.pathname,
            method: init?.method ?? 'GET',
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
        });
        const route = routes[url.pathname];
        if (route === undefined) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    return { impl, sent };
}

const DEFAULT_ROUTES = { '/api/v1/artist': ARTISTS, '/api/v1/album/7': ALBUM, '/api/v1/album/monitor': {}, '/api/v1/artist/editor': {} };

type Call = (args: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown> }>;

function harness(routes: Record<string, unknown> = DEFAULT_ROUTES) {
    const fetcher = recordingFetch(routes);
    const adapters: ServiceAdapter[] = [new LidarrAdapter(lidarrConfig, fetcher.impl)];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const permissions: Partial<Record<ServiceId, AnyServiceConfig>> = { lidarr: { ...lidarrConfig } as AnyServiceConfig };
    registerSetMonitoring(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(permissions)),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as never
        } as never,
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a), sent: fetcher.sent };
}

const tokenOf = (r: { structuredContent: Record<string, unknown> }) => r.structuredContent.confirm_token as string;

describe('set_monitoring on lidarr', () => {
    describe('album level', () => {
        it('previews one album and writes the album monitor endpoint', async () => {
            const h = harness();
            const preview = await h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false });

            expect(preview.structuredContent.summary).toMatch(/Unmonitor .*House of Sugar.* — .*Alex G.* \(2019\) in lidarr/);
            await h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false, confirm: tokenOf(preview) });

            expect(h.sent.filter(s => s.path === '/api/v1/album/monitor')).toEqual([
                { path: '/api/v1/album/monitor', method: 'PUT', body: { albumIds: [7], monitored: false } }
            ]);
        });

        it('reports a no-op when the album is already unmonitored', async () => {
            const h = harness({ ...DEFAULT_ROUTES, '/api/v1/album/7': { ...ALBUM, monitored: false } });
            const preview = await h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false });

            expect(preview.structuredContent.noop).toBe(true);
            expect(h.sent.filter(s => s.method === 'PUT')).toEqual([]);
        });

        it('refuses a season on an album', async () => {
            const h = harness();
            await expect(h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false, season: 1 })).rejects.toThrow(
                /no seasons/
            );
        });
    });

    describe('artist level', () => {
        it('refuses to guess whether an id is an album or an artist', async () => {
            const h = harness();
            await expect(h.call({ service: 'lidarr', id: '7', monitored: false })).rejects.toThrow(/lidarr needs `level`/);
        });

        it('refuses a call that asks for no change', async () => {
            const h = harness();
            await expect(h.call({ service: 'lidarr', level: 'artist' })).rejects.toThrow(/nothing to change/);
        });

        it('previews every artist and names the policy it found', async () => {
            const h = harness();
            const preview = await h.call({ service: 'lidarr', level: 'artist', monitor_new_items: 'none' });

            expect(preview.structuredContent.summary).toMatch(/Set new-album monitoring to "none" for all 2 artists/);
            expect(String(preview.structuredContent.effects)).toContain('new-album policy 1 all, 1 none; albums 1 monitored, 1 unmonitored');
        });

        /**
         * Lidarr's editor answers a write naming nothing with a 200, so a mistyped
         * id would otherwise come back as a settled library.
         */
        it('refuses an artist id Lidarr does not have', async () => {
            const h = harness();
            await expect(h.call({ service: 'lidarr', level: 'artist', artists: ['2', '999'], monitored: false })).rejects.toThrow(
                /no artist with id 999/
            );
        });

        it('reports a no-op when every targeted artist already matches', async () => {
            const h = harness();
            const preview = await h.call({ service: 'lidarr', level: 'artist', artists: ['2'], monitor_new_items: 'none' });

            expect(preview.structuredContent.noop).toBe(true);
        });

        /**
         * Checked against a live library, not assumed: an artist was found reading
         * `monitored: false` while an album under it stayed `monitored: true`. The
         * preview must not imply the artist flag empties a wanted list, or the
         * caller leaves believing nothing is being searched for.
         */
        it('does not claim the artist flag replaces the album flag', async () => {
            const h = harness();
            const preview = await h.call({ service: 'lidarr', level: 'artist', monitored: false });

            expect(String(preview.structuredContent.effects)).toContain('stay monitored');
            expect(String(preview.structuredContent.effects)).toContain('level "album"');
        });

        it('writes the artist editor once, for every artist when none are named', async () => {
            const h = harness();
            const preview = await h.call({ service: 'lidarr', level: 'artist', monitor_new_items: 'none', monitored: false });
            await h.call({
                service: 'lidarr',
                level: 'artist',
                monitor_new_items: 'none',
                monitored: false,
                confirm: tokenOf(preview)
            });

            expect(h.sent.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
                { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1, 2], monitored: false, monitorNewItems: 'none' } }
            ]);
        });

        it('refuses artist-only parameters on any other level', async () => {
            const h = harness();
            await expect(
                h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false, monitor_new_items: 'none' })
            ).rejects.toThrow(/need `level: "artist"`/);
        });
    });
});
