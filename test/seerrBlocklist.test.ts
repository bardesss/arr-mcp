import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, MultiUserServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SeerrAdapter } from '../src/services/seerr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerBlocklistMedia } from '../src/tools/blocklistMedia.ts';
import { registerDeleteMedia } from '../src/tools/deleteMedia.ts';
import { buildGetMediaDetails } from '../src/tools/getMediaDetails.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Seerr's blocklist (#602). The request shapes are Seerr's own route, not its
 * published spec: `POST /blocklist` needs `mediaType` and `user`, which the
 * spec's `Blocklist` schema leaves out (`server/routes/blocklist.ts`).
 */

const keyed = (port: number, safe_write = false, destructive = true): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write, destructive }
});

const seerrConfig = (safe_write: boolean, destructive: boolean): MultiUserServiceConfig => ({
    url: 'http://192.0.2.10:5055',
    api_key: 'k',
    timeout_ms: 10_000,
    allow_other_users: false,
    permissions: { safe_write, destructive }
});

type Sent = { method: string; path: string; search: string; body: unknown };

/** A Seerr whose blocklist is the given set of `movie:603` keys, and that records every call. */
function fakeSeerr(opts: { listed?: string[]; postStatus?: number; deleteStatus?: number } = {}) {
    const listed = new Set(opts.listed ?? []);
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });

        const row = /^\/api\/v1\/blocklist\/(\d+)$/.exec(url.pathname);
        if (row !== null) {
            const key = `${url.searchParams.get('mediaType')}:${row[1]}`;
            if (method === 'DELETE') {
                if (opts.deleteStatus !== undefined) return jsonResponse({ message: 'nope' }, opts.deleteStatus);
                listed.delete(key);
                return new Response(null, { status: 204 });
            }
            return listed.has(key) ? jsonResponse({ id: 1, tmdbId: Number(row[1]) }) : jsonResponse({ message: 'not found' }, 404);
        }
        if (url.pathname === '/api/v1/blocklist' && method === 'POST') {
            if (opts.postStatus !== undefined) return jsonResponse({ message: 'refused' }, opts.postStatus);
            const body = JSON.parse(String(init?.body)) as { tmdbId: number; mediaType: string };
            listed.add(`${body.mediaType}:${body.tmdbId}`);
            return new Response(null, { status: 201 });
        }
        if (url.pathname === '/api/v1/auth/me') return jsonResponse({ id: 1, displayName: 'Admin' });
        if (url.pathname === '/api/v1/movie/348') return jsonResponse({ title: 'Alien', releaseDate: '1979-05-25' });
        if (url.pathname === '/api/v1/tv/1399') return jsonResponse({ name: 'Game of Thrones', firstAirDate: '2011-04-17' });
        if (url.pathname.endsWith('/ratingscombined') || url.pathname.endsWith('/ratings')) return jsonResponse({});
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return { impl, sent, listed };
}

const MOVIE = { id: 412, title: 'Alien', year: 1979, tmdbId: 348, monitored: true, hasFile: true, movieFile: { size: 25_900_000_000 } };

function fakeArr(routes: Record<string, unknown>) {
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({ method, path: url.pathname, search: url.search, body: undefined });
        if (method === 'DELETE') return new Response('', { status: 200 });
        if (url.pathname in routes) return jsonResponse(routes[url.pathname]);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return { impl, sent };
}

type Call = (args: Record<string, unknown>) => Promise<{ structuredContent: WriteToolResult; content: { text: string }[] }>;

function harness(
    register: typeof registerDeleteMedia,
    opts: { adapters: ServiceAdapter[]; permissions: Partial<Record<ServiceId, AnyServiceConfig>> }
) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    register(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(opts.permissions)),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        opts.adapters
    );
    /** Preview, then confirm with the token the preview issued. */
    const confirmed = async (args: Record<string, unknown>) => {
        const first = await call(args);
        return call({ ...args, confirm: first.structuredContent.confirm_token });
    };
    return { call, confirmed };
}

describe('the Seerr adapter blocklist', () => {
    it('reads a 404 as not blocklisted and a row as blocklisted', async () => {
        const seerr = fakeSeerr({ listed: ['movie:348'] });
        const adapter = new SeerrAdapter(seerrConfig(false, false), seerr.impl);
        expect(await adapter.isBlocklisted(348, 'movie')).toBe(true);
        expect(await adapter.isBlocklisted(348, 'tv')).toBe(false);
        expect(seerr.sent[0]).toMatchObject({ path: '/api/v1/blocklist/348', search: '?mediaType=movie' });
    });

    it('credits the entry to the API key user and sends mediaType, which Seerr requires', async () => {
        const seerr = fakeSeerr();
        const outcome = await new SeerrAdapter(seerrConfig(false, false), seerr.impl).addToBlocklist({ tmdbId: 348, mediaType: 'movie', title: 'Alien' });
        expect(outcome).toBe('added');
        expect(seerr.sent.find(s => s.method === 'POST')?.body).toEqual({ tmdbId: 348, mediaType: 'movie', title: 'Alien', user: 1 });
    });

    it.each([409, 412])('reads a %i as already blocklisted only once it has checked', async status => {
        const seerr = fakeSeerr({ listed: ['movie:348'], postStatus: status });
        expect(await new SeerrAdapter(seerrConfig(false, false), seerr.impl).addToBlocklist({ tmdbId: 348, mediaType: 'movie' })).toBe('already');

        const refused = fakeSeerr({ postStatus: status });
        await expect(new SeerrAdapter(seerrConfig(false, false), refused.impl).addToBlocklist({ tmdbId: 348, mediaType: 'movie' })).rejects.toThrow(
            new RegExp(`HTTP ${status}`)
        );
    });

    it('removes by TMDB id and media type', async () => {
        const seerr = fakeSeerr({ listed: ['tv:1399'] });
        await new SeerrAdapter(seerrConfig(false, false), seerr.impl).removeFromBlocklist(1399, 'tv');
        expect(seerr.sent[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/blocklist/1399', search: '?mediaType=tv' });
    });
});

describe('blocklist_media', () => {
    const setup = (seerr: ReturnType<typeof fakeSeerr>, safe_write = true, destructive = false) =>
        harness(registerBlocklistMedia as typeof registerDeleteMedia, {
            adapters: [new SeerrAdapter(seerrConfig(safe_write, destructive), seerr.impl)],
            permissions: { seerr: seerrConfig(safe_write, destructive) }
        });

    it('previews an add as a safe write naming the title, and sends nothing', async () => {
        const seerr = fakeSeerr();
        const { structuredContent } = await setup(seerr).call({ action: 'add', id: 348, kind: 'movie' });
        expect(structuredContent.tier).toBe('safe');
        expect(structuredContent.summary).toMatch(/^Blocklist .*Alien.* \(1979\) in Seerr\.$/);
        expect(seerr.sent.filter(s => s.method !== 'GET')).toHaveLength(0);
    });

    it('adds once confirmed', async () => {
        const seerr = fakeSeerr();
        const { structuredContent } = await setup(seerr).confirmed({ action: 'add', id: 1399, kind: 'series' });
        expect(structuredContent.applied).toBe(true);
        expect(seerr.sent.find(s => s.method === 'POST')?.body).toMatchObject({ tmdbId: 1399, mediaType: 'tv', title: 'Game of Thrones' });
    });

    it('is a no-op for a title already on the blocklist', async () => {
        const { structuredContent } = await setup(fakeSeerr({ listed: ['movie:348'] })).call({ action: 'add', id: 348, kind: 'movie' });
        expect(structuredContent.noop).toBe(true);
    });

    it('refuses a remove on safe_write alone, because Seerr deletes the requests and issues with it', async () => {
        const seerr = fakeSeerr({ listed: ['movie:348'] });
        await expect(setup(seerr).call({ action: 'remove', id: 348, kind: 'movie' })).rejects.toThrow(/destructive/);
        expect(seerr.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
    });

    it('says what a remove costs, and removes once confirmed', async () => {
        const seerr = fakeSeerr({ listed: ['movie:348'] });
        const h = setup(seerr, false, true);
        const preview = await h.call({ action: 'remove', id: 348, kind: 'movie' });
        expect(preview.structuredContent.tier).toBe('destructive');
        expect(preview.structuredContent.effects.join(' ')).toContain('every request and issue');

        const done = await h.confirmed({ action: 'remove', id: 348, kind: 'movie' });
        expect(done.structuredContent.applied).toBe(true);
        expect(seerr.listed.has('movie:348')).toBe(false);
    });

    it('fails on a TMDB id Seerr does not know rather than blocklisting it blind', async () => {
        await expect(setup(fakeSeerr()).call({ action: 'add', id: 999, kind: 'movie' })).rejects.toThrow(/404/);
    });
});

describe('delete_media with seerr_blocklist', () => {
    const setup = (seerr: ReturnType<typeof fakeSeerr>, seerrPermissions = seerrConfig(true, false)) => {
        const radarr = fakeArr({ '/api/v3/movie/412': MOVIE });
        const h = harness(registerDeleteMedia, {
            adapters: [new RadarrAdapter(keyed(7878), radarr.impl), new SeerrAdapter(seerrPermissions, seerr.impl), new WhisparrAdapter(keyed(6969), fakeArr({}).impl)],
            permissions: { radarr: keyed(7878), whisparr: keyed(6969), seerr: seerrPermissions }
        });
        return { ...h, radarr };
    };

    it('lists the blocklist in the preview and touches neither service', async () => {
        const seerr = fakeSeerr();
        const h = setup(seerr);
        const { structuredContent } = await h.call({ service: 'radarr', id: '412', seerr_blocklist: true });
        expect(structuredContent.effects.at(-1)).toContain('Blocklists it in Seerr');
        expect(h.radarr.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
        expect(seerr.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('deletes from Radarr, then blocklists in Seerr', async () => {
        const seerr = fakeSeerr();
        const h = setup(seerr);
        const { structuredContent } = await h.confirmed({ service: 'radarr', id: '412', seerr_blocklist: true });
        expect(structuredContent.applied).toBe(true);
        expect(h.radarr.sent.some(s => s.method === 'DELETE')).toBe(true);
        expect(seerr.sent.find(s => s.method === 'POST')?.body).toMatchObject({ tmdbId: 348, mediaType: 'movie', title: 'Alien' });
    });

    it('needs Seerr writes to be on as well, and deletes nothing when they are not', async () => {
        const seerr = fakeSeerr();
        const h = setup(seerr, seerrConfig(false, false));
        await expect(h.call({ service: 'radarr', id: '412', seerr_blocklist: true })).rejects.toThrow(/services\.seerr\.permissions/);
        expect(h.radarr.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
    });

    it('reports the delete as applied when only the blocklist fails, and names the retry', async () => {
        const seerr = fakeSeerr({ postStatus: 500 });
        const h = setup(seerr);
        const { structuredContent, content } = await h.confirmed({ service: 'radarr', id: '412', seerr_blocklist: true });
        expect(structuredContent.applied).toBe(true);
        expect(content[0]?.text).toContain('Seerr did not blocklist it');
        expect(content[0]?.text).toContain('blocklist_media with action: "add", id: 348, kind: "movie"');
    });

    it('leaves a title already on the blocklist alone', async () => {
        const seerr = fakeSeerr({ listed: ['movie:348'] });
        const h = setup(seerr);
        const preview = await h.call({ service: 'radarr', id: '412', seerr_blocklist: true });
        expect(preview.structuredContent.effects.at(-1)).toContain('Already blocklisted');
        await h.confirmed({ service: 'radarr', id: '412', seerr_blocklist: true });
        expect(seerr.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('is refused for a service Seerr does not request for', async () => {
        await expect(setup(fakeSeerr()).call({ service: 'whisparr', id: '7', seerr_blocklist: true })).rejects.toThrow(/Radarr film or a Sonarr series/);
    });
});

describe('get_media_details', () => {
    it('says when Seerr has the title blocklisted, and says nothing when it has not', async () => {
        const radarr = fakeArr({ '/api/v3/movie/412': MOVIE });
        const details = (seerr: ReturnType<typeof fakeSeerr>) =>
            buildGetMediaDetails([new RadarrAdapter(keyed(7878), radarr.impl), new SeerrAdapter(seerrConfig(false, false), seerr.impl)], {
                service: 'radarr',
                id: '412',
                detail: 'standard',
                limit: 10
            });

        expect(await details(fakeSeerr({ listed: ['movie:348'] }))).toMatchObject({ seerrBlocklisted: true });
        expect(await details(fakeSeerr())).not.toHaveProperty('seerrBlocklisted');
    });

    it('still answers when the blocklist lookup fails', async () => {
        const radarr = fakeArr({ '/api/v3/movie/412': MOVIE });
        const broken = (async () => jsonResponse({ message: 'boom' }, 500)) as unknown as typeof fetch;
        const details = await buildGetMediaDetails([new RadarrAdapter(keyed(7878), radarr.impl), new SeerrAdapter(seerrConfig(false, false), broken)], {
            service: 'radarr',
            id: '412',
            detail: 'standard',
            limit: 10
        });
        expect(details.title).toContain('Alien');
        expect(details).not.toHaveProperty('seerrBlocklisted');
    });
});

// Sonarr series carry a TMDB id too; the series form maps it to Seerr's `tv`.
describe('delete_media with seerr_blocklist on Sonarr', () => {
    it('blocklists the series as tv', async () => {
        const seerr = fakeSeerr();
        const sonarr = fakeArr({ '/api/v3/series/7': { id: 7, title: 'Game of Thrones', year: 2011, tmdbId: 1399, tvdbId: 121361, statistics: { sizeOnDisk: 1 } } });
        const h = harness(registerDeleteMedia, {
            adapters: [new SonarrAdapter(keyed(8989), sonarr.impl), new SeerrAdapter(seerrConfig(true, false), seerr.impl)],
            permissions: { sonarr: keyed(8989), seerr: seerrConfig(true, false) }
        });
        await h.confirmed({ service: 'sonarr', id: '7', seerr_blocklist: true });
        expect(seerr.sent.find(s => s.method === 'POST')?.body).toMatchObject({ tmdbId: 1399, mediaType: 'tv' });
    });
});

describe('blocklist_media without tmdb_id', () => {
    const setup = (seerr: ReturnType<typeof fakeSeerr>) =>
        harness(registerBlocklistMedia as typeof registerDeleteMedia, {
            adapters: [new SeerrAdapter(seerrConfig(true, false), seerr.impl)],
            permissions: { seerr: seerrConfig(true, false) }
        });

    it('refuses tmdb_id, which id replaced, and a call with no id', () => {
        const seerr = fakeSeerr();
        expect(() => setup(seerr).call({ action: 'add', tmdb_id: 348, kind: 'movie' })).toThrow(/tmdb_id/);
        expect(() => setup(seerr).call({ action: 'add', kind: 'movie' })).toThrow(/id/);
        expect(seerr.sent).toHaveLength(0);
    });
});
