import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, MultiUserServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { SeerrAdapter } from '../src/services/seerr.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerRequestMedia } from '../src/tools/requestMedia.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * `request_media` is the one write whose whole point is that it goes through
 * somebody else's approval pipeline. Two things follow: the identity gate has
 * to hold before anything is created, and "already requested" has to be
 * detected here — a live Seerr does not refuse a duplicate, it makes a second
 * request row.
 */

const seerrConfig = (over: Partial<MultiUserServiceConfig> = {}): MultiUserServiceConfig =>
    ({
        url: 'http://192.0.2.10:5055',
        api_key: 'k',
        timeout_ms: 10_000,
        default_user: 'Sam',
        allow_other_users: false,
        permissions: { safe_write: true, destructive: false },
        ...over
    }) as MultiUserServiceConfig;

const USERS = { pageInfo: { pages: 1 }, results: [{ id: 1, displayName: 'Sam' }, { id: 2, displayName: 'Alex' }] };

const requestRow = (over: Record<string, unknown> = {}) => ({
    id: 19,
    status: 2,
    createdAt: '2026-08-01T00:00:00.000Z',
    media: { tmdbId: 438631, mediaType: 'movie', title: 'Dune' },
    requestedBy: { id: 1, displayName: 'Sam' },
    ...over
});

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(
    opts: {
        config?: MultiUserServiceConfig;
        existing?: Record<string, unknown>[];
        /** What POST /api/v1/request answers. */
        created?: Record<string, unknown>;
    } = {}
) {
    const config = opts.config ?? seerrConfig();
    const posted: unknown[] = [];
    const seen: string[] = [];

    // What the title's own detail answers: the nested rows Seerr records under
    // `mediaInfo.requests`, rows that carry their own `media` as recorded.
    const detail = (tmdbId: number, type: string, base: Record<string, unknown>) => ({
        ...base,
        mediaInfo: {
            tmdbId,
            requests: (opts.existing ?? [])
                .filter(r => {
                    const m = r.media as { tmdbId?: number; mediaType?: string } | undefined;
                    return m?.tmdbId === tmdbId && m?.mediaType === type;
                })
        }
    });

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        if (method === 'GET') seen.push(url.pathname);

        if (method === 'POST' && url.pathname === '/api/v1/request') {
            posted.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
            return jsonResponse(opts.created ?? requestRow());
        }
        if (url.pathname === '/api/v1/user') return jsonResponse(USERS);
        if (url.pathname === '/api/v1/request') {
            return jsonResponse({ pageInfo: { pages: 1 }, results: opts.existing ?? [] });
        }
        if (url.pathname === '/api/v1/movie/438631') return jsonResponse(detail(438631, 'movie', { title: 'Dune', releaseDate: '2021-10-22' }));
        if (url.pathname === '/api/v1/tv/1396') return jsonResponse(detail(1396, 'tv', { name: 'Breaking Bad', firstAirDate: '2008-01-20', seasons: [0, 1, 2, 3, 4, 5].map(seasonNumber => ({ seasonNumber })) }));
        if (url.pathname === '/api/v1/movie/999') return jsonResponse(detail(999, 'movie', { title: 'Other', releaseDate: '2020-01-01' }));
        // What a live Seerr 3.4.1 answers for an id TMDB does not have: a 500,
        // not a 404.
        if (url.pathname === '/api/v1/tv/31510819') return jsonResponse({ message: 'Unable to retrieve series.' }, 500);
        if (url.pathname === '/api/v1/movie/31510819') return jsonResponse({ message: 'Unable to retrieve movie.' }, 500);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    const adapter = new SeerrAdapter(config, impl);

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, cfg: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(cfg.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const audit = WriteAudit.ephemeral();
    registerRequestMedia(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf({ seerr: config as unknown as AnyServiceConfig })),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        [adapter],
        new IdentityResolver(adapter, config)
    );

    return { call: (a: Record<string, unknown>) => call(a), posted, audit, seen };
}

const MOVIE = { media_type: 'movie', media_id: 438631 };

describe('request_media', () => {
    it('refuses to request as someone else without allow_other_users', async () => {
        // The admin API key can request on anyone's behalf. Without this gate
        // one household member's assistant spends another's quota and lands in
        // their approval trail.
        const h = harness();
        await expect(h.call({ ...MOVIE, user: 'Alex' })).rejects.toThrow(/allow_other_users/);
        expect(h.posted).toHaveLength(0);
    });

    it('requests as someone else once allow_other_users is on', async () => {
        const h = harness({ config: seerrConfig({ allow_other_users: true }) });
        const preview = await h.call({ ...MOVIE, user: 'Alex' });
        await h.call({ ...MOVIE, user: 'Alex', confirm: preview.structuredContent.confirm_token });

        expect(h.posted).toEqual([{ mediaType: 'movie', mediaId: 438631, userId: 2 }]);
    });

    it('requests as the default user when none is named', async () => {
        const h = harness();
        const preview = await h.call(MOVIE);
        await h.call({ ...MOVIE, confirm: preview.structuredContent.confirm_token });

        expect(h.posted).toEqual([{ mediaType: 'movie', mediaId: 438631, userId: 1 }]);
    });

    it('previews without creating a request', async () => {
        const h = harness();
        const { structuredContent } = await h.call(MOVIE);

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(h.posted).toHaveLength(0);
    });

    it('refuses a token issued for a different media id', async () => {
        const h = harness();
        const preview = await h.call(MOVIE);
        const swapped = await h.call({
            media_type: 'movie',
            media_id: 999,
            confirm: preview.structuredContent.confirm_token
        });

        expect(swapped.structuredContent.applied).toBe(false);
        expect(h.posted).toHaveLength(0);
    });

    it('asks for every season when none is named, rather than sending nothing', async () => {
        // A live Seerr answers HTTP 500 for a tv request with no `seasons` at
        // all — not a whole-series request. `all` is what "the show" means.
        const h = harness({ created: requestRow({ media: { tmdbId: 1396, mediaType: 'tv' } }) });
        const args = { media_type: 'tv', media_id: 1396 };
        const preview = await h.call(args);
        await h.call({ ...args, confirm: preview.structuredContent.confirm_token });

        expect(h.posted).toEqual([{ mediaType: 'tv', mediaId: 1396, seasons: 'all', userId: 1 }]);
    });

    it('sends only the named seasons when some are named', async () => {
        const h = harness({ created: requestRow({ media: { tmdbId: 1396, mediaType: 'tv' } }) });
        const args = { media_type: 'tv', media_id: 1396, seasons: [1, 2] };
        const preview = await h.call(args);
        await h.call({ ...args, confirm: preview.structuredContent.confirm_token });

        expect(h.posted).toEqual([{ mediaType: 'tv', mediaId: 1396, seasons: [1, 2], userId: 1 }]);
    });

    it('refuses seasons on a movie rather than silently dropping them', async () => {
        const h = harness();
        await expect(h.call({ ...MOVIE, seasons: [1] })).rejects.toThrow(/season/i);
    });

    it('is a no-op when the media is already requested', async () => {
        const h = harness({ existing: [requestRow()] });
        const { structuredContent } = await h.call(MOVIE);

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(h.posted).toHaveLength(0);
        expect(structuredContent.summary).toContain('requested by <<untrusted:seerr.user>>Sam<</>>');
    });

    it('names the pending request when a title has several, otherwise the newest', async () => {
        const row = (id: number, status: number, name: string) =>
            requestRow({ id, status, requestedBy: { id: 1, displayName: name } });

        const pending = harness({ existing: [row(30, 2, 'Approved'), row(20, 1, 'Waiting'), row(10, 2, 'Old')] });
        expect((await pending.call(MOVIE)).structuredContent.summary).toContain('Waiting');

        const newest = harness({ existing: [row(10, 2, 'Old'), row(30, 5, 'Newest'), row(20, 2, 'Middle')] });
        expect((await newest.call(MOVIE)).structuredContent.summary).toContain('Newest');
    });

    it('requests again after a decline or a failure, and says what is on record', async () => {
        for (const status of [3, 4]) {
            const h = harness({ existing: [requestRow({ status })] });
            const { structuredContent } = await h.call(MOVIE);
            expect(structuredContent.noop).toBe(false);
            expect(structuredContent.effects[0]).toMatch(/^Already on record for .*Dune.*: (declined|failed) by /);
        }
    });

    describe('on a series, an earlier request covers only its own seasons', () => {
        const SERIES = { media_type: 'tv', media_id: 1396 };
        const tvRow = (seasons: number[], status = 2) =>
            requestRow({ status, media: { tmdbId: 1396, mediaType: 'tv' }, seasons: seasons.map(seasonNumber => ({ seasonNumber })) });

        it('requests a season the earlier request did not ask for', async () => {
            const h = harness({ existing: [tvRow([1, 2])] });
            const { structuredContent } = await h.call({ ...SERIES, seasons: [3] });
            expect(structuredContent.noop).toBe(false);
            expect(structuredContent.effects[0]).toContain('approved by <<untrusted:seerr.user>>Sam<</>> (seasons 1, 2)');
        });

        it('is a no-op for seasons already requested', async () => {
            const h = harness({ existing: [tvRow([1, 2])] });
            expect((await h.call({ ...SERIES, seasons: [2] })).structuredContent.noop).toBe(true);
        });

        it('reads every season, specials aside, against what Seerr lists', async () => {
            expect((await harness({ existing: [tvRow([1, 2])] }).call(SERIES)).structuredContent.noop).toBe(false);
            expect((await harness({ existing: [tvRow([1, 2, 3]), tvRow([4, 5], 5)] }).call(SERIES)).structuredContent.noop).toBe(true);
        });
    });

    it('checks for a duplicate from the title lookup, not the whole request history', async () => {
        const h = harness({ existing: [requestRow()] });
        const { structuredContent } = await h.call(MOVIE);
        expect(structuredContent.noop).toBe(true);
        expect(h.seen).not.toContain('/api/v1/request');
        expect(h.seen.filter(p => p === '/api/v1/movie/438631')).toHaveLength(1);
    });

    it('still requests when an existing request is for a different media type', async () => {
        const h = harness({ existing: [requestRow({ media: { tmdbId: 438631, mediaType: 'tv' } })] });
        const { structuredContent } = await h.call(MOVIE);
        expect(structuredContent.noop).toBe(false);
    });

    it('throws rather than claiming success when the response carries no id', async () => {
        // Same rule as respond_to_request: if we cannot say what was created,
        // we do not say it worked.
        const h = harness({ created: {} });
        const preview = await h.call(MOVIE);
        await expect(h.call({ ...MOVIE, confirm: preview.structuredContent.confirm_token })).rejects.toThrow(
            /get_requests/
        );
    });

    it('names the config key when the permission is off', async () => {
        const h = harness({ config: seerrConfig({ permissions: { safe_write: false, destructive: false } }) });
        await expect(h.call(MOVIE)).rejects.toThrow(/safe_write/);
    });

    it('refuses rather than issuing a token when Seerr cannot resolve the id', async () => {
        // An IMDb number with the `tt` stripped is a real mistake a model made.
        // A token here gets confirmed, and the apply fails with an opaque 500.
        const h = harness();
        const call = h.call({ media_type: 'tv', media_id: 31510819 });
        await expect(call).rejects.toThrow(/search_media/);
        await expect(call).rejects.toThrow(/imdb:tt/);
        expect(h.posted).toHaveLength(0);
    });

    it('refuses an unresolvable movie id too', async () => {
        const h = harness();
        await expect(h.call({ media_type: 'movie', media_id: 31510819 })).rejects.toMatchObject({ kind: 'NotFound' });
    });

    it('still answers already-requested when the title lookup fails', async () => {
        // A no-op creates nothing, so there is no wrong-id request to prevent.
        const h = harness({ existing: [requestRow({ media: { tmdbId: 31510819, mediaType: 'tv' } })] });
        const { structuredContent } = await h.call({ media_type: 'tv', media_id: 31510819 });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toContain('title unavailable');
    });

    // Not the wrong-id refusal: Seerr has the id on record, so it is right.
    it('names the declined request when the title lookup fails and that is all Seerr has', async () => {
        const h = harness({ existing: [requestRow({ id: 23, status: 3, media: { tmdbId: 31510819, mediaType: 'tv' } })] });
        const call = h.call({ media_type: 'tv', media_id: 31510819 });
        await expect(call).rejects.toThrow(/request 23 by .*Sam.* was declined/);
        await expect(call).rejects.not.toThrow(/search_media/);
        expect(h.posted).toHaveLength(0);
    });

    it('names the title in the preview, not just the id', async () => {
        const h = harness();
        const { structuredContent } = await h.call(MOVIE);
        expect(structuredContent.summary).toContain('Dune');
    });

    it('writes an audit row on every branch', async () => {
        const previewed = harness();
        expect((await previewed.call(MOVIE)).structuredContent.audit_id).toBeDefined();

        const noop = harness({ existing: [requestRow()] });
        expect((await noop.call(MOVIE)).structuredContent.audit_id).toBeDefined();

        const denied = harness({ config: seerrConfig({ permissions: { safe_write: false, destructive: false } }) });
        await expect(denied.call(MOVIE)).rejects.toThrow();
        expect(denied.audit.recent(10)).toHaveLength(1);
    });
});
