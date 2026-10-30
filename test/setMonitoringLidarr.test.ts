import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
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

/**
 * The two write responses are live captures from Lidarr 2.1.3.3927, kept as raw
 * bodies the way the read fixtures are. They come from a throwaway instance with
 * one artist, so their ids are not the ids these tests write: a response is what
 * Lidarr answered, and the assertion on the request body is what proves the call.
 */
const fixture = (file: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/lidarr', file), 'utf8'));

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
        return new Response(JSON.stringify(route), {
            status: CAPTURED_STATUS[url.pathname] ?? 200,
            headers: { 'content-type': 'application/json' }
        });
    }) as unknown as typeof fetch;

    return { impl, sent };
}

/** The two write captures answered `202 Accepted`, so the fake keeps that. A
 *  200 here would hide a real install's status line behind a friendlier one. */
const CAPTURED_STATUS: Record<string, number> = {
    '/api/v1/album/monitor': 202,
    '/api/v1/artist/editor': 202
};

const DEFAULT_ROUTES = {
    '/api/v1/artist': ARTISTS,
    '/api/v1/album/7': ALBUM,
    '/api/v1/album/monitor': fixture('album-monitor.json'),
    '/api/v1/artist/editor': fixture('artist-editor.json')
};

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
            const applied = await h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false, confirm: tokenOf(preview) });

            expect(applied.structuredContent.applied).toBe(true);
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

        it('refuses a season on an album, before a token is issued or a call is made', async () => {
            const h = harness();
            await expect(h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false, season: 1 })).rejects.toThrow(
                /no seasons/
            );
            expect(h.sent).toEqual([]);
        });
    });

    describe('artist level', () => {
        it('refuses to guess whether an id is an album or an artist', async () => {
            const h = harness();
            const err = await h.call({ service: 'lidarr', id: '7', monitored: false }).catch((e: unknown) => e);

            // A ServiceError here would read as "lidarr not found", and a regex
            // alone cannot tell the two apart: `ServiceError.message` embeds the
            // detail, so `toThrow(/lidarr needs/)` passes for both.
            expect(err).toBeInstanceOf(Error);
            expect(err).not.toBeInstanceOf(ServiceError);
            expect((err as Error).message).toMatch(/lidarr needs `level`/);
        });

        it('refuses a call that asks for no change', async () => {
            const h = harness();
            await expect(h.call({ service: 'lidarr', level: 'artist' })).rejects.toThrow(/nothing to change/);
        });

        it('previews every artist and names the policy it found', async () => {
            const h = harness();
            const preview = await h.call({ service: 'lidarr', level: 'artist', monitor_new_items: 'none' });

            expect(preview.structuredContent.summary).toMatch(/Set new-album monitoring to "none" for all 2 artists/);
            expect(String(preview.structuredContent.effects)).toContain('new-album policy 1 all, 1 none; artists 1 monitored, 1 unmonitored');
            expect(String(preview.structuredContent.effects)).not.toContain('albums 1 monitored');
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
            const applied = await h.call({
                service: 'lidarr',
                level: 'artist',
                monitor_new_items: 'none',
                monitored: false,
                confirm: tokenOf(preview)
            });

            expect(applied.structuredContent.applied).toBe(true);
            expect(h.sent.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
                { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1, 2], monitored: false, monitorNewItems: 'none' } }
            ]);
        });

        /**
         * The apply writes the set the preview named, not the word "all".
         * Re-reading the artist list on apply resolved "all" a second time, so
         * an artist added between the two calls was written without ever being
         * shown, and the caller confirmed a number that no longer matched.
         */
        it('refuses to apply when an artist joined after the preview', async () => {
            const artists = [...ARTISTS];
            const h = harness({ ...DEFAULT_ROUTES, '/api/v1/artist': artists });
            const preview = await h.call({ service: 'lidarr', level: 'artist', monitor_new_items: 'none' });

            artists.push({ id: 3, artistName: 'Late Arrival', monitored: true, monitorNewItems: 'all' });
            const applied = await h.call({
                service: 'lidarr',
                level: 'artist',
                monitor_new_items: 'none',
                confirm: tokenOf(preview)
            });

            expect(applied.structuredContent.applied).toBe(false);
            expect(String(applied.structuredContent.confirm_error)).toContain('different arguments');
            expect(h.sent.filter(s => s.method === 'PUT')).toEqual([]);
        });

        /**
         * The defence itself, not the token check. `plan` runs again on the
         * confirm call, so the token already refuses a library that changed
         * between the two calls. This asserts the second half: `apply` writes
         * the ids the plan carried, so a library that grows after that second
         * read cannot widen the write. Read three is what a re-read would take.
         */
        it('writes the previewed ids when the library grows before the write lands', async () => {
            const LATE = { id: 3, artistName: 'Late Arrival', monitored: true, monitorNewItems: 'all' };
            let reads = 0;
            const routes: Record<string, unknown> = { ...DEFAULT_ROUTES };
            Object.defineProperty(routes, '/api/v1/artist', {
                get: () => {
                    reads += 1;
                    return reads >= 3 ? [...ARTISTS, LATE] : ARTISTS;
                }
            });
            const h = harness(routes);

            const preview = await h.call({ service: 'lidarr', level: 'artist', monitor_new_items: 'none' });
            const applied = await h.call({
                service: 'lidarr',
                level: 'artist',
                monitor_new_items: 'none',
                confirm: tokenOf(preview)
            });

            expect(applied.structuredContent.applied).toBe(true);
            expect(reads).toBe(2);
            expect(h.sent.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
                { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1, 2], monitorNewItems: 'none' } }
            ]);
        });

        /**
         * Why the two captures are here at all. Lidarr answers the monitor write
         * with the updated rows, and nothing in the adapter parses that body
         * (`put(..., true)` discards it), so the fixture cannot be checked by a
         * passing test alone. It is the artifact a person can read to see what
         * Lidarr said the change did, which is what makes the write "checked
         * against a real Lidarr" rather than checked against a `{}`.
         */
        it('keeps captures that echo the change that was requested', () => {
            const album = fixture('album-monitor.json') as { monitored?: boolean }[];
            const artist = fixture('artist-editor.json') as { monitored?: boolean; monitorNewItems?: string }[];

            expect(album[0]?.monitored).toBe(true);
            expect(artist[0]).toMatchObject({ monitored: true, monitorNewItems: 'none' });
        });

        it('writes exactly the artists the preview named', async () => {
            const h = harness();
            const preview = await h.call({ service: 'lidarr', level: 'artist', artists: ['1'], monitor_new_items: 'none' });
            await h.call({
                service: 'lidarr',
                level: 'artist',
                artists: ['1'],
                monitor_new_items: 'none',
                confirm: tokenOf(preview)
            });

            expect(h.sent.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
                { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1], monitorNewItems: 'none' } }
            ]);
        });

        it('refuses artist-only parameters on any other level', async () => {
            const h = harness();
            const err = await h
                .call({ service: 'lidarr', level: 'album', id: '7', monitored: false, monitor_new_items: 'none' })
                .catch((e: unknown) => e);

            expect(err).toBeInstanceOf(Error);
            expect(err).not.toBeInstanceOf(ServiceError);
            expect((err as Error).message).toMatch(/need `level: "artist"`/);
        });
    });
});
