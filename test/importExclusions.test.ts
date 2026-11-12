import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerBlocklistMedia } from '../src/tools/blocklistMedia.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * *arr import exclusions on blocklist_media. The row shapes are the ones the
 * live Radarr 6.4 (`tmdbId, movieTitle, movieYear, id`) and Sonarr 4.0
 * (`tvdbId, title, id`) answered, and Lidarr's spec (`foreignId, artistName`).
 */

const keyed = (port: number, safe_write = true): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write, destructive: false }
});

const MBID = 'f27ec8db-af05-4f36-916e-3d57f91ecf5e';

type Sent = { method: string; path: string; search: string; body: unknown };

/** An *arr whose exclusion list is `rows`, and that answers the lookups add_media uses. */
function fakeArr(root: string, listPath: string, rows: Record<string, unknown>[], lookups: Record<string, unknown[]>) {
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (url.pathname === `${root}/${listPath}` && method === 'GET') return jsonResponse(rows);
        if (url.pathname === `${root}/${listPath}` && method === 'POST') return jsonResponse({ id: 99, ...(JSON.parse(String(init?.body)) as object) }, 201);
        if (url.pathname.startsWith(`${root}/${listPath}/`) && method === 'DELETE') return new Response('', { status: 200 });
        const lookup = lookups[`${url.pathname}${url.search}`];
        if (lookup !== undefined) return jsonResponse(lookup);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return { impl, sent };
}

const radarr = (rows: Record<string, unknown>[] = []) =>
    fakeArr('/api/v3', 'exclusions', rows, { '/api/v3/movie/lookup?term=tmdb:348': [{ title: 'Alien', year: 1979, tmdbId: 348 }] });
const sonarr = (rows: Record<string, unknown>[] = []) =>
    fakeArr('/api/v3', 'importlistexclusion', rows, { '/api/v3/series/lookup?term=tvdb:121361': [{ title: 'Game of Thrones', year: 2011, tvdbId: 121361 }] });
const lidarr = (rows: Record<string, unknown>[] = []) =>
    fakeArr('/api/v1', 'importlistexclusion', rows, { [`/api/v1/artist/lookup?term=lidarr:${MBID}`]: [{ artistName: 'Radiohead', foreignArtistId: MBID }] });

type Call = (args: Record<string, unknown>) => Promise<{ structuredContent: WriteToolResult; content: { text: string }[] }>;

function harness(adapters: ServiceAdapter[], permissions: Partial<Record<ServiceId, AnyServiceConfig>>) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    registerBlocklistMedia(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(permissions)),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );
    const confirmed = async (args: Record<string, unknown>) => {
        const first = await call(args);
        return call({ ...args, confirm: first.structuredContent.confirm_token });
    };
    return { call, confirmed };
}

describe('the *arr adapters', () => {
    it('Radarr finds by TMDB id, posts title and year, and deletes by row id', async () => {
        const r = radarr([{ id: 7, tmdbId: 348, movieTitle: 'Alien', movieYear: 1979 }]);
        const adapter = new RadarrAdapter(keyed(7878), r.impl);
        expect(await adapter.findImportExclusion('348')).toEqual({ id: 7 });
        expect(await adapter.findImportExclusion('349')).toBeUndefined();

        await adapter.addImportExclusion('603', { title: 'The Matrix', year: 1999 });
        expect(r.sent.find(s => s.method === 'POST')).toMatchObject({ path: '/api/v3/exclusions', body: { tmdbId: 603, movieTitle: 'The Matrix', movieYear: 1999 } });

        await adapter.removeImportExclusion(7);
        expect(r.sent.find(s => s.method === 'DELETE')?.path).toBe('/api/v3/exclusions/7');
    });

    it('Sonarr keys on the TVDB id and has no year', async () => {
        const s = sonarr();
        await new SonarrAdapter(keyed(8989), s.impl).addImportExclusion('121361', { title: 'Game of Thrones', year: 2011 });
        expect(s.sent.find(x => x.method === 'POST')).toMatchObject({
            path: '/api/v3/importlistexclusion',
            body: { tvdbId: 121361, title: 'Game of Thrones' }
        });
        expect(s.sent.find(x => x.method === 'POST')?.body).not.toHaveProperty('year');
    });

    it('Lidarr matches the MusicBrainz id in any case, on its own API root', async () => {
        const l = lidarr([{ id: 3, foreignId: MBID.toUpperCase(), artistName: 'Radiohead' }]);
        const adapter = new LidarrAdapter(keyed(8686), l.impl);
        expect(await adapter.findImportExclusion(MBID)).toEqual({ id: 3 });
        await adapter.addImportExclusion(MBID.toUpperCase(), { title: 'Radiohead' });
        expect(l.sent.find(x => x.method === 'POST')).toMatchObject({ path: '/api/v1/importlistexclusion', body: { foreignId: MBID, artistName: 'Radiohead' } });
    });
});

describe('blocklist_media on an *arr', () => {
    it('previews a Radarr exclusion as safe, naming the film and what it does not stop', async () => {
        const r = radarr();
        const h = harness([new RadarrAdapter(keyed(7878), r.impl)], { radarr: keyed(7878) });
        const { structuredContent } = await h.call({ service: 'radarr', action: 'add', id: 348 });
        expect(structuredContent.tier).toBe('safe');
        expect(structuredContent.target).toBe('radarr:tmdb:348');
        expect(structuredContent.summary).toMatch(/^Exclude .*Alien.* \(1979\) from radarr's import lists\.$/);
        expect(structuredContent.effects.join(' ')).toContain('A Seerr request or a manual add still can');
        expect(r.sent.filter(s => s.method !== 'GET')).toHaveLength(0);
    });

    it('adds once confirmed, with the title the lookup found', async () => {
        const r = radarr();
        const h = harness([new RadarrAdapter(keyed(7878), r.impl)], { radarr: keyed(7878) });
        const done = await h.confirmed({ service: 'radarr', action: 'add', id: '348' });
        expect(done.structuredContent.applied).toBe(true);
        expect(r.sent.find(s => s.method === 'POST')?.body).toEqual({ tmdbId: 348, movieTitle: 'Alien', movieYear: 1979 });
    });

    it('is a no-op when the title is already excluded, and when removing one that is not', async () => {
        const h = harness([new RadarrAdapter(keyed(7878), radarr([{ id: 7, tmdbId: 348 }]).impl)], { radarr: keyed(7878) });
        expect((await h.call({ service: 'radarr', action: 'add', id: 348 })).structuredContent.noop).toBe(true);

        const empty = harness([new RadarrAdapter(keyed(7878), radarr().impl)], { radarr: keyed(7878) });
        expect((await empty.call({ service: 'radarr', action: 'remove', id: 348 })).structuredContent.noop).toBe(true);
    });

    it('removes by the row it found, as a safe write', async () => {
        const s = sonarr([{ id: 41, tvdbId: 121361, title: 'Game of Thrones' }]);
        const h = harness([new SonarrAdapter(keyed(8989), s.impl)], { sonarr: keyed(8989) });
        const done = await h.confirmed({ service: 'sonarr', action: 'remove', id: 121361 });
        expect(done.structuredContent.tier).toBe('safe');
        expect(done.structuredContent.applied).toBe(true);
        expect(s.sent.find(x => x.method === 'DELETE')?.path).toBe('/api/v3/importlistexclusion/41');
    });

    it("says Lidarr drops the exclusion when an album is added", async () => {
        const h = harness([new LidarrAdapter(keyed(8686), lidarr().impl)], { lidarr: keyed(8686) });
        const { structuredContent } = await h.call({ service: 'lidarr', action: 'add', id: MBID });
        expect(structuredContent.effects.join(' ')).toContain("when one of the artist's albums is added");
    });

    it("is gated by the *arr's own permissions", async () => {
        const r = radarr();
        const h = harness([new RadarrAdapter(keyed(7878, false), r.impl)], { radarr: keyed(7878, false) });
        await expect(h.call({ service: 'radarr', action: 'add', id: 348 })).rejects.toThrow(/services\.radarr\.permissions\.safe_write/);
    });

    it('refuses a kind the *arr does not hold', async () => {
        const h = harness([new RadarrAdapter(keyed(7878), radarr().impl)], { radarr: keyed(7878) });
        await expect(h.call({ service: 'radarr', action: 'add', id: 348, kind: 'series' })).rejects.toThrow(/no series exclusions/);
    });

    it('refuses Whisparr until a capture shows which id its exclusions hold', async () => {
        const h = harness([new WhisparrAdapter(keyed(6969), radarr().impl)], { whisparr: keyed(6969) });
        await expect(h.call({ service: 'whisparr', action: 'add', id: 1 })).rejects.toThrow(/has no blocklist or import exclusions/);
    });
});

describe('blocklist_media tmdb_id on an *arr', () => {
    it('is refused: the id goes in id', () => {
        const r = radarr();
        const h = harness([new RadarrAdapter(keyed(7878), r.impl)], { radarr: keyed(7878) });
        expect(() => h.call({ service: 'radarr', action: 'add', tmdb_id: 348 })).toThrow(/tmdb_id/);
        expect(r.sent).toHaveLength(0);
    });
});
