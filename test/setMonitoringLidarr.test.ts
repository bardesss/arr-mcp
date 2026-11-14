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
import { registerUpdateMedia } from '../src/tools/updateMedia.ts';
import { instancesOf, namedInstances } from './helpers/instances.ts';

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

/** `name` makes the one Lidarr a named instance, as one entry of a list is. */
function harness(routes: Record<string, unknown> = DEFAULT_ROUTES, name?: string) {
    const fetcher = recordingFetch(routes);
    const config = name === undefined ? lidarrConfig : { ...lidarrConfig, name };
    const adapters: ServiceAdapter[] = [new LidarrAdapter(config, fetcher.impl)];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const permissions: Partial<Record<ServiceId, AnyServiceConfig>> = { lidarr: { ...config } as AnyServiceConfig };
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

            expect(preview.structuredContent.summary).toMatch(/Unmonitor .*House of Sugar.* by .*Alex G.* \(2019\) in lidarr/);
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

        it('names the instance in the summary, not only the service', async () => {
            const h = harness(DEFAULT_ROUTES, 'two');
            const preview = await h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false });

            expect(preview.structuredContent.summary).toMatch(/ in lidarr\/two\.$/);
            expect(preview.structuredContent.effects).toContainEqual(
                expect.stringMatching(/^Lidarr will stop searching for .*House of Sugar.*\. Files already on disk are untouched\.$/)
            );
        });

        it('refuses a season on an album, before a token is issued or a call is made', async () => {
            const h = harness();
            await expect(h.call({ service: 'lidarr', level: 'album', id: '7', monitored: false, season: 1 })).rejects.toThrow(
                /no seasons/
            );
            expect(h.sent).toEqual([]);
        });

        it('refuses to guess whether an id is an album or an artist, and names update_media for the artist', async () => {
            const h = harness();
            const err = await h.call({ service: 'lidarr', id: '7', monitored: false }).catch((e: unknown) => e);

            // A ServiceError here would read as "lidarr not found", and a regex
            // alone cannot tell the two apart: `ServiceError.message` embeds the
            // detail, so `toThrow(/lidarr needs/)` passes for both.
            expect(err).toBeInstanceOf(Error);
            expect(err).not.toBeInstanceOf(ServiceError);
            expect((err as Error).message).toMatch(/lidarr needs `level: "album"`/);
            expect((err as Error).message).toMatch(/update_media/);
            expect(h.sent).toEqual([]);
        });
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
});

/** The same Lidarr, with update_media registered. */
function updateTool(routes: Record<string, unknown> = DEFAULT_ROUTES) {
    const fetcher = recordingFetch(routes);
    const adapters: ServiceAdapter[] = [new LidarrAdapter(lidarrConfig, fetcher.impl)];
    const calls: Record<string, Call> = {};
    const server = {
        registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            calls[name] = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const permissions: Partial<Record<ServiceId, AnyServiceConfig>> = { lidarr: { ...lidarrConfig } as AnyServiceConfig };
    const context = {
        permissions: permissionSourceFrom(instancesOf(permissions)),
        confirm: new ConfirmTokens(),
        audit: WriteAudit.ephemeral(),
        library: { invalidate: vi.fn() } as never
    } as never;
    registerUpdateMedia(server as never, context, adapters);
    return {
        update: (a: Record<string, unknown>) => calls.update_media!(a),
        sent: fetcher.sent
    };
}

describe('update_media on every lidarr artist', () => {
    it('refuses a call that asks for no change', async () => {
        const h = updateTool();
        await expect(h.update({ service: 'lidarr' })).rejects.toThrow(/nothing to change/i);
    });

    it('previews every artist when no id is given, and names the policy it found', async () => {
        const h = updateTool();
        const preview = await h.update({ service: 'lidarr', monitor_new_items: 'none' });

        expect(preview.structuredContent.summary).toMatch(/Set new-album monitoring to "none" for all 2 artists/);
        expect(String(preview.structuredContent.effects)).toContain('new-album policy 1 all, 1 none; artists 1 monitored, 1 unmonitored');
        expect(String(preview.structuredContent.effects)).not.toContain('albums 1 monitored');
    });

    /**
     * Lidarr's editor answers a write naming nothing with a 200, so a mistyped
     * id would otherwise come back as a settled library. The refusal stays a
     * ServiceError: a missing artist is a fact about the service, not the call.
     */
    it('refuses an artist id Lidarr does not have', async () => {
        const h = updateTool();
        const err = await h.update({ service: 'lidarr', id: '999', monitor_new_items: 'none' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).kind).toBe('NotFound');
        expect((err as Error).message).toMatch(/no artist with id 999/);
        // One Lidarr: no per-instance caveat to give.
        expect((err as ServiceError).remedy).toMatch(/Take an id from acquisition\.id on a get_library artist row\.$/);
    });

    it('reports a no-op when the artist already matches', async () => {
        const h = updateTool();
        const preview = await h.update({ service: 'lidarr', id: '2', monitor_new_items: 'none' });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it('writes the artist editor once for every artist when no id is named', async () => {
        const h = updateTool();
        const args = { service: 'lidarr', monitor_new_items: 'none', monitored: false };
        const preview = await h.update(args);
        const applied = await h.update({ ...args, confirm: tokenOf(preview) });

        expect(applied.structuredContent.applied).toBe(true);
        expect(h.sent.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
            { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1, 2], monitored: false, monitorNewItems: 'none' } }
        ]);
    });

    /**
     * Checked against a live library, not assumed: an artist was found reading
     * `monitored: false` while an album under it stayed `monitored: true`.
     * Lidarr's wanted lists and automatic searches skip that album while the
     * artist is unmonitored, and want it again once the artist is monitored,
     * so the preview says both, and names the album level as the lasting way
     * out.
     */
    it('does not claim the artist flag replaces the album flag', async () => {
        const h = updateTool();
        const preview = await h.update({ service: 'lidarr', monitored: false });

        expect(String(preview.structuredContent.effects)).toContain('keep their own flags, but Lidarr leaves all of them out of its wanted lists');
        expect(String(preview.structuredContent.effects)).toContain('level "album"');
    });

    it('says monitoring the artist brings its monitored albums back', async () => {
        const h = updateTool();
        const preview = await h.update({ service: 'lidarr', monitored: true });

        expect(String(preview.structuredContent.effects)).toContain(
            "each album keeps its own, and the monitored ones come back into Lidarr's wanted lists"
        );
    });

    it('writes exactly the artist an id names', async () => {
        const h = updateTool();
        const args = { service: 'lidarr', id: '1', monitor_new_items: 'none' };
        const preview = await h.update(args);
        await h.update({ ...args, confirm: tokenOf(preview) });

        expect(h.sent.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
            { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1], monitorNewItems: 'none' } }
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
        const h = updateTool({ ...DEFAULT_ROUTES, '/api/v1/artist': artists });
        const preview = await h.update({ service: 'lidarr', monitor_new_items: 'none' });

        artists.push({ id: 3, artistName: 'Late Arrival', monitored: true, monitorNewItems: 'all' });
        const applied = await h.update({ service: 'lidarr', monitor_new_items: 'none', confirm: tokenOf(preview) });

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
        const h = updateTool(routes);

        const preview = await h.update({ service: 'lidarr', monitor_new_items: 'none' });
        const applied = await h.update({ service: 'lidarr', monitor_new_items: 'none', confirm: tokenOf(preview) });

        expect(applied.structuredContent.applied).toBe(true);
        expect(reads).toBe(2);
        expect(h.sent.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
            { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1, 2], monitorNewItems: 'none' } }
        ]);
    });

    it('refuses the settings that need one artist when no id is given', async () => {
        const h = updateTool();
        const err = await h.update({ service: 'lidarr', quality_profile: 'Lossless' }).catch((e: unknown) => e);
        expect((err as Error).message).toMatch(/`id`/);
        expect(h.sent).toEqual([]);
    });

    it('refuses a title instead of previewing every artist', () => {
        const h = updateTool();
        expect(() => h.update({ service: 'lidarr', title: 'Alex G', monitored: false })).toThrow(/Unknown argument\(s\): title/);
        expect(h.sent).toEqual([]);
    });

    it('refuses minimum_availability and series_type rather than dropping them', async () => {
        const h = updateTool();
        for (const extra of [{ minimum_availability: 'released' }, { series_type: 'anime' }]) {
            const noId = await h.update({ service: 'lidarr', monitored: false, ...extra }).catch((e: unknown) => e);
            const withId = await h.update({ service: 'lidarr', id: '1', monitor_new_items: 'none', ...extra }).catch((e: unknown) => e);
            expect((noId as Error).message).toMatch(/is a (Radarr|Sonarr) option/);
            expect((withId as Error).message).toMatch(/is a (Radarr|Sonarr) option/);
        }
        expect(h.sent).toEqual([]);
    });

    it('names set_monitoring for the album flag in the preview', async () => {
        const h = updateTool();
        const preview = await h.update({ service: 'lidarr', monitored: false });
        expect(String(preview.structuredContent.effects)).toContain('Use set_monitoring with level "album"');
    });
});

/**
 * Two Lidarrs, the way a lossless library sits beside a lossy one. A write names
 * one: the artist editor would otherwise settle a policy on a library nobody
 * meant, and the two hold different artists under the same ids.
 */
describe('update_media with two lidarrs', () => {
    const FLAC_ARTISTS = [{ id: 1, artistName: 'Artist One', monitored: true, monitorNewItems: 'all' }];
    const MP3_ARTISTS = [
        { id: 1, artistName: 'Artist Two', monitored: true, monitorNewItems: 'all' },
        { id: 2, artistName: 'Artist Three', monitored: false, monitorNewItems: 'none' }
    ];

    /** `count: 1` is a list holding one named entry, which is still one Lidarr. */
    function twoLidarrs(count: 1 | 2 = 2) {
        const routes = (artists: unknown) => ({
            '/api/v1/artist': artists,
            '/api/v1/artist/editor': fixture('artist-editor.json')
        });
        const flac = recordingFetch(routes(FLAC_ARTISTS));
        const mp3 = recordingFetch(routes(MP3_ARTISTS));
        const configs = [
            { ...lidarrConfig, name: 'flac', url: 'http://192.0.2.10:8686' },
            { ...lidarrConfig, name: 'mp3', url: 'http://192.0.2.11:8686' }
        ].slice(0, count);
        const impls = [flac.impl, mp3.impl];
        const adapters: ServiceAdapter[] = configs.map((c, i) => new LidarrAdapter(c as never, impls[i]!));

        const calls: Record<string, Call> = {};
        const server = {
            registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: Call) {
                calls[name] = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
            }
        };
        const context = {
            permissions: permissionSourceFrom(namedInstances('lidarr', configs as AnyServiceConfig[])),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as never
        } as never;
        registerUpdateMedia(server as never, context, adapters);

        return { update: (a: Record<string, unknown>) => calls.update_media!(a), flac: flac.sent, mp3: mp3.sent };
    }

    it('refuses to guess which Lidarr, and names both', async () => {
        const h = twoLidarrs();
        const err = await h.update({ service: 'lidarr', monitor_new_items: 'none' }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ServiceError);
        expect((err as Error).message).toMatch(/2 instances configured/);
        expect((err as ServiceError).remedy).toMatch(/"flac", "mp3"/);
        expect([...h.flac, ...h.mp3]).toEqual([]);
    });

    it('previews and writes only the named instance', async () => {
        const h = twoLidarrs();
        const preview = await h.update({ service: 'lidarr', instance: 'mp3', monitor_new_items: 'none' });

        expect(preview.structuredContent.target).toBe('lidarr/mp3:artists:all');
        expect(preview.structuredContent.summary).toMatch(/all 2 artists in lidarr\/mp3\./);

        await h.update({ service: 'lidarr', instance: 'mp3', monitor_new_items: 'none', confirm: tokenOf(preview) });

        expect(h.mp3.filter(s => s.path === '/api/v1/artist/editor')).toEqual([
            { path: '/api/v1/artist/editor', method: 'PUT', body: { artistIds: [1, 2], monitorNewItems: 'none' } }
        ]);
        expect(h.flac).toEqual([]);
    });

    it('blames the named instance for an artist id it does not hold, without telling it to omit id', async () => {
        const h = twoLidarrs();
        const err = await h
            .update({ service: 'lidarr', instance: 'flac', id: '2', monitored: false, monitor_new_items: 'none' })
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).service).toBe('lidarr/flac');
        expect((err as Error).message).toMatch(/no artist with id 2/);
        expect((err as ServiceError).remedy).toMatch(/acquisition\.service is lidarr\/flac\. Ids are per instance/);
        expect((err as ServiceError).remedy).not.toMatch(/omit/);
    });

    it('treats a list holding one entry as one Lidarr: no instance needed, no per-instance caveat', async () => {
        const h = twoLidarrs(1);
        const preview = await h.update({ service: 'lidarr', monitor_new_items: 'none' });
        expect(preview.structuredContent.summary).toMatch(/in lidarr\/flac\.$/);

        const err = await h.update({ service: 'lidarr', id: '2', monitor_new_items: 'none' }).catch((e: unknown) => e);
        expect((err as ServiceError).service).toBe('lidarr/flac');
        expect((err as ServiceError).remedy).toMatch(/Take an id from acquisition\.id on a get_library artist row\.$/);
    });
});
