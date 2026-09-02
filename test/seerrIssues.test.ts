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
            requestedBy: { displayName: 'Someone' },
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
        expect(rows[0]?.reportedBy).toBe('Someone');
        expect(rows[0]?.title).toContain('Heat');
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
