import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, MultiUserServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { SeerrAdapter } from '../src/services/seerr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerDeleteRequest, registerRespondToRequest } from '../src/tools/manageRequests.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const seerrConfig: MultiUserServiceConfig = {
    url: 'http://192.0.2.10:5055',
    api_key: 'k',
    timeout_ms: 10_000,
    default_user: 'Sam',
    allow_other_users: false,
    permissions: { safe_write: false, destructive: false }
};

/** A server whose default user is someone other than the fixture's requester. */
const otherUserConfig: MultiUserServiceConfig = { ...seerrConfig, default_user: 'Bartus' };

const tiered = (safe_write: boolean, destructive: boolean): AnyServiceConfig =>
    ({ ...seerrConfig, permissions: { safe_write, destructive } }) as AnyServiceConfig;

/**
 * Shaped like the *recorded* response, which is the point: real Seerr sends
 * **no title** on a request — `media` is ids and service metadata only. An
 * earlier version of this file invented `media.title`, and every assertion
 * against it passed while the live stack printed "request 19, requested by
 * Bardesss". A fixture that is kinder than reality tests nothing.
 */
const PENDING = {
    id: 31,
    status: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    media: { tmdbId: 603, tvdbId: null, mediaType: 'movie' },
    requestedBy: { id: 2, displayName: 'Sam' }
};
const APPROVED = { ...PENDING, status: 2 };

/** What `/api/v1/movie/{tmdbId}` answers — where the title actually lives. */
const MOVIE_DETAILS = { title: 'The Matrix', releaseDate: '1999-03-30' };

function recordingFetch(handlers: {
    requests?: unknown;
    onWrite?: (path: string, method: string) => Response;
    titleLookupFails?: boolean;
}) {
    const sent: { path: string; method: string; body: unknown }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({
            path: url.pathname,
            method,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        });

        if (method !== 'GET') {
            return handlers.onWrite?.(url.pathname, method) ?? new Response('', { status: 200 });
        }
        if (url.pathname === '/api/v1/request') {
            return jsonResponse(handlers.requests ?? { results: [PENDING] });
        }
        if (url.pathname.startsWith('/api/v1/movie/')) {
            return handlers.titleLookupFails === true
                ? jsonResponse({ message: 'not found' }, 404)
                : jsonResponse(MOVIE_DETAILS);
        }
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(
    register: typeof registerRespondToRequest,
    opts: {
        permissions?: Partial<Record<ServiceId, AnyServiceConfig>>;
        requests?: unknown;
        onWrite?: (path: string, method: string) => Response;
        titleLookupFails?: boolean;
        adapters?: ServiceAdapter[];
        identity?: MultiUserServiceConfig;
    } = {}
) {
    const fetchImpl = recordingFetch({
        ...(opts.requests === undefined ? {} : { requests: opts.requests }),
        ...(opts.onWrite === undefined ? {} : { onWrite: opts.onWrite }),
        ...(opts.titleLookupFails === undefined ? {} : { titleLookupFails: opts.titleLookupFails })
    });
    const adapters = opts.adapters ?? [new SeerrAdapter(seerrConfig, fetchImpl.impl)];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const invalidate = vi.fn();
    const audit = WriteAudit.ephemeral();
    register(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(opts.permissions ?? { seerr: tiered(false, true) })),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate } as unknown as LibraryLoader
        },
        adapters,
        new IdentityResolver(adapters[0] as never, opts.identity ?? seerrConfig)
    );

    return { call: (a: Record<string, unknown>) => call(a), fetchImpl, audit, invalidate };
}

// --- adapter -------------------------------------------------------------

describe('SeerrAdapter request writes', () => {
    it('posts to the verdict endpoint and reports what the request became', async () => {
        const { impl, sent } = recordingFetch({ onWrite: () => jsonResponse(APPROVED) });
        const updated = await new SeerrAdapter(seerrConfig, impl).respondToRequest('31', 'approve');

        const post = sent.find(s => s.method === 'POST');
        expect(post?.path).toBe('/api/v1/request/31/approve');
        expect(updated.status).toBe('approved');
    });

    it('resolves a title from the media endpoint, since the request has none', async () => {
        const { impl, sent } = recordingFetch({});
        const adapter = new SeerrAdapter(seerrConfig, impl);
        const [request] = await adapter.getRequests({});

        // The gap this exists to close: nothing on the request itself.
        expect(request?.title).toBeUndefined();

        const described = await adapter.describeRequestMedia(request!);
        // Fenced at the adapter boundary like every other free-text field, so
        // the assertion is on the content, not on an unfenced string.
        expect(described?.title).toContain('The Matrix');
        expect(described?.title).toContain('untrusted');
        expect(described?.year).toBe(1999);
        expect(sent.some(s => s.path === '/api/v1/movie/603')).toBe(true);
    });

    it('looks up a series on the tv path, where the title is called name', async () => {
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            seen.push(path);
            if (path.startsWith('/api/v1/tv/')) {
                return jsonResponse({ name: 'Alien: Earth', firstAirDate: '2025-08-12' });
            }
            return jsonResponse({ results: [{ ...PENDING, media: { tmdbId: 157239, mediaType: 'tv' } }] });
        }) as unknown as typeof fetch;

        const adapter = new SeerrAdapter(seerrConfig, impl);
        const [request] = await adapter.getRequests({});
        const described = await adapter.describeRequestMedia(request!);

        expect(described?.title).toContain('Alien: Earth');
        expect(described?.year).toBe(2025);
        expect(seen).toContain('/api/v1/tv/157239');
    });

    // The live-stack regression: Seerr sends an empty releaseDate for anything
    // TMDB has no date for, and Number(''.slice(0,4)) is 0, not NaN — so the
    // preview read "The Origin of Hide and Seek (0)".
    it('omits the year rather than reporting 0 when the date is empty', async () => {
        const impl = (async (input: string | URL | Request) => {
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            if (path.startsWith('/api/v1/movie/')) return jsonResponse({ title: 'Undated Film', releaseDate: '' });
            return jsonResponse({ results: [PENDING] });
        }) as unknown as typeof fetch;

        const adapter = new SeerrAdapter(seerrConfig, impl);
        const [request] = await adapter.getRequests({});
        const described = await adapter.describeRequestMedia(request!);

        expect(described?.title).toContain('Undated Film');
        expect(described).not.toHaveProperty('year');
    });

    it('rejects an implausible year rather than passing it through', async () => {
        const impl = (async (input: string | URL | Request) => {
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            if (path.startsWith('/api/v1/movie/')) return jsonResponse({ title: 'Bad Date', releaseDate: '0000-01-01' });
            return jsonResponse({ results: [PENDING] });
        }) as unknown as typeof fetch;

        const adapter = new SeerrAdapter(seerrConfig, impl);
        const [request] = await adapter.getRequests({});
        expect(await adapter.describeRequestMedia(request!)).not.toHaveProperty('year');
    });

    // A title lookup that fails must not stop someone deleting a request.
    it('resolves undefined rather than throwing when the lookup fails', async () => {
        const { impl } = recordingFetch({ titleLookupFails: true });
        const adapter = new SeerrAdapter(seerrConfig, impl);
        const [request] = await adapter.getRequests({});

        await expect(adapter.describeRequestMedia(request!)).resolves.toBeUndefined();
    });

    it('uses the decline endpoint for a decline', async () => {
        const { impl, sent } = recordingFetch({ onWrite: () => jsonResponse({ ...PENDING, status: 3 }) });
        const updated = await new SeerrAdapter(seerrConfig, impl).respondToRequest('31', 'decline');

        expect(sent.find(s => s.method === 'POST')?.path).toBe('/api/v1/request/31/decline');
        expect(updated.status).toBe('declined');
    });

    // Reporting "approved" off the back of a response we could not read would
    // be a claim we never verified.
    it('refuses to claim success when the response carries no request', async () => {
        const { impl } = recordingFetch({ onWrite: () => jsonResponse({}) });
        await expect(new SeerrAdapter(seerrConfig, impl).respondToRequest('31', 'approve')).rejects.toThrow(
            /returned no request/
        );
    });

    it('deletes by id', async () => {
        const { impl, sent } = recordingFetch({});
        await new SeerrAdapter(seerrConfig, impl).deleteRequest('31');

        const del = sent.find(s => s.method === 'DELETE');
        expect(del?.path).toBe('/api/v1/request/31');
    });

    it('refuses a non-numeric request id', async () => {
        const { impl, sent } = recordingFetch({});
        await expect(new SeerrAdapter(seerrConfig, impl).deleteRequest('matrix')).rejects.toThrow(ServiceError);
        expect(sent.filter(s => s.method !== 'GET')).toHaveLength(0);
    });
});

// --- respond_to_request --------------------------------------------------

describe('respond_to_request', () => {
    it("refuses to act on another user's request while allow_other_users is off", async () => {
        // get_requests will not so much as list Sam's requests to a server
        // configured for Bartus. Acting on one — and previewing its title and
        // requester — must not be the way around that: request ids are small
        // integers, so anything the read gate refuses is one guess away.
        const h = harness(registerRespondToRequest, { identity: otherUserConfig });

        await expect(h.call({ id: '31', verdict: 'approve', dry_run: true })).rejects.toThrow(/allow_other_users/);
    });

    it('names the film and who asked for it', async () => {
        const h = harness(registerRespondToRequest, { permissions: { seerr: tiered(true, false) } });
        const { structuredContent } = await h.call({ id: '31', verdict: 'approve', dry_run: true });

        expect(structuredContent.summary).toContain('The Matrix');
        expect(structuredContent.summary).toContain('1999');
        expect(structuredContent.summary).toContain('Sam');
        expect(structuredContent.tier).toBe('safe');
    });

    // The live-stack regression: with no title lookup this read "request 31,
    // requested by Sam", which is not something anyone can approve.
    it('never presents a bare id as though that were the whole story', async () => {
        const h = harness(registerRespondToRequest, {
            permissions: { seerr: tiered(true, false) },
            titleLookupFails: true
        });
        const { structuredContent } = await h.call({ id: '31', verdict: 'approve', dry_run: true });

        expect(structuredContent.summary).toContain('title unavailable');
        expect(structuredContent.summary).toContain('movie');
    });

    // "Approve" reads much cheaper than it is.
    it('warns that approving starts a download', async () => {
        const h = harness(registerRespondToRequest, { permissions: { seerr: tiered(true, false) } });
        const { structuredContent } = await h.call({ id: '31', verdict: 'approve', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('disk space and bandwidth');
    });

    it('says a decline downloads nothing', async () => {
        const h = harness(registerRespondToRequest, { permissions: { seerr: tiered(true, false) } });
        const { structuredContent } = await h.call({ id: '31', verdict: 'decline', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('Downloads nothing');
    });

    it('applies once confirmed and reports the resulting status', async () => {
        const h = harness(registerRespondToRequest, {
            permissions: { seerr: tiered(true, false) },
            onWrite: () => jsonResponse(APPROVED)
        });

        const first = await h.call({ id: '31', verdict: 'approve' });
        const second = await h.call({ id: '31', verdict: 'approve', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(second.structuredContent.result).toEqual({ id: 31, status: 'approved' });
    });

    // Asking someone to confirm a no-op teaches them to confirm without reading.
    it('short-circuits when the request is already in that state', async () => {
        const h = harness(registerRespondToRequest, {
            permissions: { seerr: tiered(true, false) },
            requests: { results: [APPROVED] }
        });

        const { structuredContent } = await h.call({ id: '31', verdict: 'approve' });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(h.fetchImpl.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('still acts when the verdict differs from the current state', async () => {
        const h = harness(registerRespondToRequest, {
            permissions: { seerr: tiered(true, false) },
            requests: { results: [APPROVED] },
            onWrite: () => jsonResponse({ ...PENDING, status: 3 })
        });

        const first = await h.call({ id: '31', verdict: 'decline' });
        expect(first.structuredContent.noop).toBe(false);
        expect(first.structuredContent.confirm_token).toBeTypeOf('string');
    });

    it('is reachable on safe_write alone', async () => {
        const h = harness(registerRespondToRequest, { permissions: { seerr: tiered(true, false) } });
        const first = await h.call({ id: '31', verdict: 'approve' });
        expect(first.structuredContent.confirm_token).toBeTypeOf('string');
    });

    it('fails legibly on an id that is not in the request list', async () => {
        const h = harness(registerRespondToRequest, { permissions: { seerr: tiered(true, false) } });
        await expect(h.call({ id: '999', verdict: 'approve', dry_run: true })).rejects.toThrow(
            /no Seerr request has id/
        );
    });

    it('refuses when Seerr is not configured, pointing at where requests live', async () => {
        const h = harness(registerRespondToRequest, { adapters: [], permissions: {} });
        await expect(h.call({ id: '31', verdict: 'approve', dry_run: true })).rejects.toThrow(/not configured/);
    });

    // The token binds the verdict, so a preview of one cannot apply the other.
    it('will not let an approve token be used to decline', async () => {
        const h = harness(registerRespondToRequest, { permissions: { seerr: tiered(true, false) } });
        const approve = await h.call({ id: '31', verdict: 'approve' });

        const swapped = await h.call({
            id: '31',
            verdict: 'decline',
            confirm: approve.structuredContent.confirm_token
        });

        expect(swapped.structuredContent.applied).toBe(false);
        expect(h.fetchImpl.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });
});

// --- delete_request ------------------------------------------------------

describe('delete_request', () => {
    it('is destructive tier, so safe_write alone will not reach it', async () => {
        const h = harness(registerDeleteRequest, { permissions: { seerr: tiered(true, false) } });
        await expect(h.call({ id: '31' })).rejects.toThrow(/services\.seerr\.permissions\.destructive: true/);
    });

    // The distinction people get wrong, stated before they act.
    it('says plainly that it does not delete the media', async () => {
        const h = harness(registerDeleteRequest);
        const { structuredContent } = await h.call({ id: '31', dry_run: true });

        const effects = structuredContent.effects.join(' ');
        expect(effects).toContain('Does NOT delete any media');
        expect(effects).toContain('delete_media');
    });

    it('deletes only once confirmed', async () => {
        const h = harness(registerDeleteRequest);
        const first = await h.call({ id: '31' });
        expect(h.fetchImpl.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);

        const second = await h.call({ id: '31', confirm: first.structuredContent.confirm_token });
        expect(second.structuredContent.applied).toBe(true);
        expect(h.fetchImpl.sent.find(s => s.method === 'DELETE')?.path).toBe('/api/v1/request/31');
    });

    it('records the deletion in the audit trail', async () => {
        const h = harness(registerDeleteRequest);
        const first = await h.call({ id: '31' });
        await h.call({ id: '31', confirm: first.structuredContent.confirm_token });

        const rows = h.audit.recent() as { outcome: string; operation: string; target: string }[];
        expect(rows[0]).toMatchObject({ outcome: 'applied', operation: 'delete_request', target: 'seerr:31' });
    });
});
