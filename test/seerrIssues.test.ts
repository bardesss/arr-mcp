import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import type { IdentityResolver } from '../src/core/identity.ts';
import { SeerrAdapter } from '../src/services/seerr.ts';
import { buildGetRequests } from '../src/tools/getRequests.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * What a household reports as broken — "the audio is out of sync" — which
 * nothing in this stack could report. Seerr numbers both the kind and the
 * state, and a model handed `issueType: 2` cannot say what is wrong.
 */
const config: MultiUserServiceConfig = {
    url: 'http://192.0.2.10:5055',
    api_key: 'k',
    timeout_ms: 10_000,
    allow_other_users: false,
    permissions: { safe_write: false, destructive: false }
};

const ISSUES = {
    results: [
        {
            id: 7,
            issueType: 2,
            status: 1,
            createdAt: '2026-09-01T10:00:00Z',
            media: { title: 'Heat' },
            createdBy: { displayName: 'Someone' },
            comments: [{ message: 'first' }, { message: 'second' }, { message: 'third' }, { message: 'newest' }]
        },
        { id: 8, issueType: 9, status: 2, media: { title: 'Taboo' }, comments: [] }
    ],
    pageInfo: { pages: 1, page: 1, results: 2 }
};

const REQUESTS = {
    results: [
        {
            id: 1,
            status: 1,
            media: { mediaType: 'movie', tmdbId: 949, title: 'Heat' },
            requestedBy: { id: 1, displayName: 'Someone' },
            createdAt: '2026-09-01T09:00:00Z'
        }
    ],
    pageInfo: { pages: 1, page: 1, results: 1 }
};

const serving = (issues: unknown = ISSUES, requests: unknown = REQUESTS) =>
    (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === '/api/v1/issue') {
            if (issues === 'fail') return jsonResponse({ message: 'nope' }, 500);
            return jsonResponse(issues);
        }
        if (url.pathname === '/api/v1/request') return jsonResponse(requests);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

const resolver = {
    resolve: async () => ({ id: '1', name: 'Someone' })
} as unknown as IdentityResolver;

describe('Seerr issues', () => {
    it('maps both numbered vocabularies to words', async () => {
        const rows = await new SeerrAdapter(config, serving()).getIssues({ limit: 50 });
        expect(rows[0]).toMatchObject({ id: '7', kind: 'audio', status: 'open' });
        // An issueType Seerr has not documented falls back rather than
        // reporting a number nobody can read.
        expect(rows[1]).toMatchObject({ kind: 'other', status: 'resolved' });
    });

    it('fences the comments, which are users own words, and caps them', async () => {
        const rows = await new SeerrAdapter(config, serving()).getIssues({ limit: 50 });
        expect(rows[0]?.comments).toHaveLength(3);
        expect(rows[0]?.comments.at(-1)).toContain('newest');
        expect(rows[0]?.comments[0]).toMatch(/untrusted/);
    });

    it('names who reported it and what it is about', async () => {
        const rows = await new SeerrAdapter(config, serving()).getIssues({ limit: 50 });
        expect(rows[0]?.reportedBy).toBe('<<untrusted:seerr.user>>Someone<</>>');
        expect(rows[0]?.title).toContain('Heat');
    });

    it('reads one page of `limit` issues rather than paging the whole list', async () => {
        const seen: URL[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            seen.push(url);
            return jsonResponse({ ...ISSUES, pageInfo: { pages: 250, page: 1, results: 500 } });
        }) as unknown as typeof fetch;
        const rows = await new SeerrAdapter(config, impl).getIssues({ limit: 1 });
        expect(seen).toHaveLength(1);
        expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({ take: '1', skip: '0', sort: 'added', filter: 'all' });
        expect(rows.map(r => r.id)).toEqual(['7']);
    });

    it('maps the recorded issue page', async () => {
        const recorded = JSON.parse(
            readFileSync(new URL('./fixtures/seerr/issue.json', import.meta.url), 'utf8')
        ) as unknown;
        const rows = await new SeerrAdapter(config, serving(recorded)).getIssues({ limit: 50 });
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(['video', 'audio', 'subtitle', 'other']).toContain(row.kind);
            expect(['open', 'resolved', 'unknown']).toContain(row.status);
        }
    });
});

describe('get_requests issues', () => {
    it('returns them at detail: full', async () => {
        const result = await buildGetRequests(new SeerrAdapter(config, serving()), resolver, {
            detail: 'full',
            limit: 50
        });
        expect(result.issues?.map(i => i.id)).toEqual(['7', '8']);
        expect(result.items).toHaveLength(1);
    });

    it('leaves them out below full', async () => {
        const result = await buildGetRequests(new SeerrAdapter(config, serving()), resolver, {
            detail: 'standard',
            limit: 50
        });
        expect(result.issues).toBeUndefined();
    });

    /** "Your requests could not be read" would be the wrong thing to say
     *  about a Seerr that answered for the requests. */
    it('still answers with the requests when the issue read fails', async () => {
        const result = await buildGetRequests(new SeerrAdapter(config, serving('fail')), resolver, {
            detail: 'full',
            limit: 50
        });
        expect(result.items).toHaveLength(1);
        expect(result.issues).toBeUndefined();
        expect(result.degraded).toEqual([]);
    });
});

/**
 * #577: `get_requests` at `detail: "full"` returned Seerr issues with no way
 * to tell which media they are about. The recorded fixture shows why: a real
 * `/api/v1/issue` row carries `media` as a MediaInfo — id, mediaType, tmdbId,
 * tvdbId — with no `title` at all, so the old mapper (which only read
 * `media.title`) emitted nothing. The title has to come from the media detail
 * endpoint, the same one `getMediaRequests` already reads.
 */
const ISSUES_WITH_IDS = {
    results: [
        {
            id: 14,
            issueType: 3,
            status: 1,
            createdAt: '2026-11-08T21:33:36.000Z',
            media: { id: 678, mediaType: 'movie', tmdbId: 12345, tvdbId: null },
            createdBy: { displayName: 'User1' },
            comments: [{ message: 'wrong subtitle' }]
        },
        {
            id: 15,
            issueType: 2,
            status: 1,
            media: { id: 679, mediaType: 'tv', tmdbId: 456, tvdbId: 789 },
            createdBy: { displayName: 'User1' },
            comments: []
        },
        // A second issue about the same film: its title must not cost a
        // second detail call.
        {
            id: 16,
            issueType: 3,
            status: 1,
            media: { id: 678, mediaType: 'movie', tmdbId: 12345, tvdbId: null },
            createdBy: { displayName: 'User1' },
            comments: []
        }
    ],
    pageInfo: { pages: 1, page: 1, results: 3 }
};

const servingWithDetails = (seen: string[]) =>
    (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        seen.push(url.pathname);
        if (url.pathname === '/api/v1/issue') return jsonResponse(ISSUES_WITH_IDS);
        if (url.pathname === '/api/v1/movie/12345')
            return jsonResponse({ title: 'Example Movie', mediaInfo: { tvdbId: null, requests: [] } });
        if (url.pathname === '/api/v1/tv/456')
            return jsonResponse({ name: 'Example Show', mediaInfo: { tvdbId: 789, requests: [] } });
        if (url.pathname === '/api/v1/request') return jsonResponse(REQUESTS);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

describe('Seerr issue media identity (#577)', () => {
    it('identifies the media each issue is about: title plus stable ids', async () => {
        const seen: string[] = [];
        const rows = await new SeerrAdapter(config, servingWithDetails(seen)).getIssues({ limit: 50 });
        expect(rows[0]).toMatchObject({
            id: '14',
            mediaType: 'movie',
            tmdbId: 12345
        });
        expect(rows[0]?.title).toContain('Example Movie');
        expect(rows[0]).not.toHaveProperty('tvdbId');
        expect(rows[1]).toMatchObject({
            id: '15',
            mediaType: 'tv',
            tmdbId: 456,
            tvdbId: 789
        });
        expect(rows[1]?.title).toContain('Example Show');
    });

    it('resolves a shared title once, not once per issue', async () => {
        const seen: string[] = [];
        await new SeerrAdapter(config, servingWithDetails(seen)).getIssues({ limit: 50 });
        expect(seen.filter(p => p === '/api/v1/movie/12345')).toHaveLength(1);
        expect(seen.filter(p => p === '/api/v1/tv/456')).toHaveLength(1);
    });

    it('caps the detail reads at four in flight', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const seen: string[] = [];
        const page = {
            results: Array.from({ length: 10 }, (_, n) => ({
                id: 30 + n,
                issueType: 1,
                status: 1,
                media: { id: 800 + n, mediaType: 'movie', tmdbId: 1000 + n },
                comments: []
            })),
            pageInfo: { pages: 1, page: 1, results: 10 }
        };
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/api/v1/issue') return jsonResponse(page);
            if (url.pathname.startsWith('/api/v1/movie/')) {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                // Slow enough that an uncapped run would overlap all ten.
                await new Promise(r => setTimeout(r, 10));
                inFlight--;
                seen.push(url.pathname);
                return jsonResponse({ title: `Film ${url.pathname.split('/').pop()}`, mediaInfo: { tvdbId: null, requests: [] } });
            }
            return jsonResponse({ message: 'not found' }, 404);
        }) as unknown as typeof fetch;
        const rows = await new SeerrAdapter(config, impl).getIssues({ limit: 50 });
        expect(rows).toHaveLength(10);
        expect(seen).toHaveLength(10);
        // The cap throttles, it does not serialize: a run that never had
        // two reads in flight would pass the upper bound while doing the
        // work one title at a time.
        expect(maxInFlight).toBeGreaterThan(1);
        expect(maxInFlight).toBeLessThanOrEqual(4);
        // The cap throttles, it does not drop: every title still resolves.
        for (const row of rows) expect(row.title).toContain('Film');
    });

    it('carries the recorded issue page media ids', async () => {
        const recorded = JSON.parse(
            readFileSync(new URL('./fixtures/seerr/issue.json', import.meta.url), 'utf8')
        ) as unknown;
        // The recorded serving mock answers 404 for the movie detail, so no
        // title is resolvable here — but the ids the payload does carry must
        // still reach the caller.
        const rows = await new SeerrAdapter(config, serving(recorded)).getIssues({ limit: 50 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            mediaType: 'movie',
            tmdbId: 1629051
        });
        expect(rows[0]).not.toHaveProperty('tvdbId');
    });

    it('returns an issue with no media at all, without ids or a lookup', async () => {
        const seen: string[] = [];
        const page = {
            results: [
                { id: 20, issueType: 1, status: 1, createdBy: { displayName: 'Someone' }, comments: [] },
                // Media named but no tmdbId or tvdbId: nothing to resolve
                // a title from, and a mediaType with no id to look it up
                // by names nothing the caller can use, so it is dropped.
                { id: 21, issueType: 1, status: 1, media: { id: 700, mediaType: 'movie' }, comments: [] },
                // An unknown mediaType still names the ids, but no title can
                // be resolved for it — and a null tmdbId names nothing at
                // all. Neither may cost a detail call.
                { id: 22, issueType: 1, status: 1, media: { id: 701, mediaType: 'music', tmdbId: 999 }, comments: [] },
                { id: 23, issueType: 1, status: 1, media: { tmdbId: null }, comments: [] },
                // A tvdbId alone is still an id to look the media up by,
                // so the mediaType stays even though no title can resolve
                // (title resolution needs a tmdbId).
                { id: 26, issueType: 1, status: 1, media: { id: 702, mediaType: 'tv', tvdbId: 789 }, comments: [] }
            ],
            pageInfo: { pages: 1, page: 1, results: 5 }
        };
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            seen.push(url.pathname);
            if (url.pathname === '/api/v1/issue') return jsonResponse(page);
            return jsonResponse({ message: 'not found' }, 404);
        }) as unknown as typeof fetch;
        const rows = await new SeerrAdapter(config, impl).getIssues({ limit: 50 });
        expect(rows).toHaveLength(5);
        expect(rows[0]).toMatchObject({ id: '20', kind: 'video', status: 'open' });
        expect(rows[0]).not.toHaveProperty('title');
        expect(rows[0]).not.toHaveProperty('tmdbId');
        expect(rows[1]).toMatchObject({ id: '21' });
        expect(rows[1]).not.toHaveProperty('title');
        expect(rows[1]).not.toHaveProperty('tmdbId');
        expect(rows[1]).not.toHaveProperty('mediaType');
        // Unknown mediaType: the ids are still emitted, but there is no
        // title to resolve and no mediaType worth reporting.
        expect(rows[2]).toMatchObject({ id: '22', tmdbId: 999 });
        expect(rows[2]).not.toHaveProperty('title');
        expect(rows[2]).not.toHaveProperty('mediaType');
        // A null tmdbId names nothing: no ids, no title, no lookup.
        expect(rows[3]).toMatchObject({ id: '23' });
        expect(rows[3]).not.toHaveProperty('title');
        expect(rows[3]).not.toHaveProperty('tmdbId');
        expect(rows[3]).not.toHaveProperty('tvdbId');
        expect(rows[3]).not.toHaveProperty('mediaType');
        // A tvdbId alone keeps the mediaType: the caller can look the
        // media up by it, even though no title resolves without a tmdbId.
        expect(rows[4]).toMatchObject({ id: '26', mediaType: 'tv', tvdbId: 789 });
        expect(rows[4]).not.toHaveProperty('title');
        expect(rows[4]).not.toHaveProperty('tmdbId');
        expect(seen.filter(p => p.startsWith('/api/v1/movie') || p.startsWith('/api/v1/tv'))).toHaveLength(0);
    });

    it('drops non-number media ids instead of emitting them', async () => {
        const seen: string[] = [];
        const page = {
            results: [
                // A numeric tmdbId still resolves (the 404 is caught per
                // title), but the string id / tvdbId must never be emitted.
                { id: 24, issueType: 1, status: 1, media: { id: 'x', mediaType: 'movie', tmdbId: 999, tvdbId: 'y' }, comments: [] }
            ],
            pageInfo: { pages: 1, page: 1, results: 1 }
        };
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            seen.push(url.pathname);
            if (url.pathname === '/api/v1/issue') return jsonResponse(page);
            return jsonResponse({ message: 'not found' }, 404);
        }) as unknown as typeof fetch;
        const rows = await new SeerrAdapter(config, impl).getIssues({ limit: 50 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: '24', mediaType: 'movie', tmdbId: 999 });
        expect(rows[0]).not.toHaveProperty('tvdbId');
        expect(rows[0]).not.toHaveProperty('title');
        expect(seen.filter(p => p === '/api/v1/movie/999')).toHaveLength(1);
    });

    it('treats an empty payload title like no title and resolves it', async () => {
        const seen: string[] = [];
        const page = {
            results: [
                { id: 25, issueType: 3, status: 1, media: { id: 678, mediaType: 'movie', tmdbId: 12345, tvdbId: null, title: '' }, createdBy: { displayName: 'User1' }, comments: [] }
            ],
            pageInfo: { pages: 1, page: 1, results: 1 }
        };
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            seen.push(url.pathname);
            if (url.pathname === '/api/v1/issue') return jsonResponse(page);
            if (url.pathname === '/api/v1/movie/12345')
                return jsonResponse({ title: 'Example Movie', mediaInfo: { tvdbId: null, requests: [] } });
            return jsonResponse({ message: 'not found' }, 404);
        }) as unknown as typeof fetch;
        const rows = await new SeerrAdapter(config, impl).getIssues({ limit: 50 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: '25', mediaType: 'movie', tmdbId: 12345 });
        expect(rows[0]?.title).toContain('Example Movie');
        expect(seen.filter(p => p === '/api/v1/movie/12345')).toHaveLength(1);
    });
});
