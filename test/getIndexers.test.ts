import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { ProwlarrAdapter } from '../src/services/prowlarr.ts';
import { buildGetIndexers, summarizeIndexers } from '../src/tools/getIndexers.ts';
import { repeat } from './helpers/bigFixture.ts';
import { expectWithinBudget } from './helpers/budget.ts';
import { serving } from './helpers/serve.ts';

const config: KeyedServiceConfig = {
    url: 'http://192.0.2.10:9696',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const INDEXERS = [
    { id: 1, name: 'NZBgeek', enable: true, protocol: 'usenet', priority: 25 },
    { id: 2, name: 'Torrentio', enable: false, protocol: 'torrent', priority: 50 }
];

const STATUS = [
    { id: 9, indexerId: 1, disabledTill: '2026-08-05T12:00:00Z', mostRecentFailure: 'Request limit reached' }
];

const STATS = {
    indexers: [
        {
            indexerId: 1,
            numberOfQueries: 412,
            numberOfGrabs: 37,
            numberOfRejectedQueries: 3,
            numberOfRejectedGrabs: 1
        }
    ]
};

const HISTORY = {
    records: [
        {
            indexerId: 1,
            date: '2026-08-04T22:10:00Z',
            successful: false,
            data: { query: 'some film 2026', reason: 'Query rate limit exceeded' }
        },
        { indexerId: 1, date: '2026-08-04T22:05:00Z', successful: true, data: { query: 'something else' } }
    ]
};

const routes = {
    '/api/v1/indexer': INDEXERS,
    '/api/v1/indexerstatus': STATUS,
    '/api/v1/indexerstats': STATS,
    '/api/v1/history': HISTORY
};

const adapter = (r: Record<string, unknown> = routes) => new ProwlarrAdapter(config, serving(r));

describe('get_indexers', () => {
    it('joins indexers with their status and statistics', async () => {
        const result = await buildGetIndexers([adapter()], { detail: 'full', limit: 50 });
        expect(result.items.find(i => i.name === 'NZBgeek')).toMatchObject({
            service: 'prowlarr',
            id: 1,
            enabled: true,
            protocol: 'usenet',
            priority: 25,
            disabledUntil: '2026-08-05T12:00:00Z',
            queries: 412,
            grabs: 37
        });
    });

    it('fences the failure message, which is text the indexer chose', async () => {
        const result = await buildGetIndexers([adapter()], { detail: 'full', limit: 50 });
        expect(result.items.find(i => i.name === 'NZBgeek')?.lastFailure).toBe(
            '<<untrusted:prowlarr.mostRecentFailure>>Request limit reached<</untrusted>>'
        );
    });

    it('reports an indexer with no status row as not disabled rather than omitting it', async () => {
        const result = await buildGetIndexers([adapter()], { detail: 'full', limit: 50 });
        const torrentio = result.items.find(i => i.name === 'Torrentio');
        expect(torrentio?.enabled).toBe(false);
        expect(torrentio?.disabledUntil).toBeUndefined();
    });

    it('drops statistics at detail: standard but keeps health', async () => {
        const result = await buildGetIndexers([adapter()], { detail: 'standard', limit: 50 });
        const geek = result.items.find(i => i.name === 'NZBgeek');
        expect(geek?.queries).toBeUndefined();
        expect(geek?.disabledUntil).toBe('2026-08-05T12:00:00Z');
    });

    it('returns name and enabled only at detail: minimal', async () => {
        const result = await buildGetIndexers([adapter()], { detail: 'minimal', limit: 50 });
        expect(Object.keys(result.items[0] ?? {}).sort()).toEqual(['enabled', 'id', 'name', 'service']);
    });

    it('reports truncation honestly', async () => {
        const many = repeat(INDEXERS[0]!, 120).map((i, n) => ({ ...i, id: n }));
        const result = await buildGetIndexers([adapter({ ...routes, '/api/v1/indexer': many })], {
            detail: 'standard',
            limit: 50
        });
        expect(result).toMatchObject({ total: 120, returned: 50, truncated: true });
    });

    it('still returns indexers when the statistics endpoint is down', async () => {
        const result = await buildGetIndexers(
            [adapter({ '/api/v1/indexer': INDEXERS, '/api/v1/indexerstatus': STATUS })],
            { detail: 'full', limit: 50 }
        );
        expect(result.items).toHaveLength(2);
        expect(result.items[0]?.queries).toBeUndefined();
        expect(result.degraded).toEqual([]);
    });

    it('degrades rather than failing when Prowlarr itself is unreachable', async () => {
        const refuse = (async () => {
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }) as unknown as typeof fetch;

        const result = await buildGetIndexers([new ProwlarrAdapter(config, refuse)], { detail: 'standard', limit: 50 });
        expect(result.items).toEqual([]);
        expect(result.degraded).toEqual(['prowlarr']);
    });

    it('returns an empty result rather than throwing when Prowlarr is not configured', async () => {
        expect(await buildGetIndexers([], { detail: 'standard', limit: 50 })).toMatchObject({
            items: [],
            total: 0,
            degraded: []
        });
    });

    it('returns the actual recent rejections, not just a count of them', async () => {
        const result = await buildGetIndexers([adapter()], { detail: 'full', limit: 50 });
        expect(result.recentRejections).toEqual([
            {
                service: 'prowlarr',
                indexer: 'NZBgeek',
                at: '2026-08-04T22:10:00Z',
                reason: '<<untrusted:prowlarr.reason>>Query rate limit exceeded<</untrusted>>',
                query: '<<untrusted:prowlarr.query>>some film 2026<</untrusted>>'
            }
        ]);
    });

    it('ignores successful history rows — those are not rejections', async () => {
        const result = await buildGetIndexers([adapter()], { detail: 'full', limit: 50 });
        expect(result.recentRejections).toHaveLength(1);
    });

    it('omits rejections below detail: full, where they are noise', async () => {
        for (const detail of ['minimal', 'standard'] as const) {
            const result = await buildGetIndexers([adapter()], { detail, limit: 50 });
            expect(result.recentRejections).toBeUndefined();
        }
    });

    it('reports an empty rejection list rather than omitting it when nothing was rejected', async () => {
        const result = await buildGetIndexers([adapter({ ...routes, '/api/v1/history': { records: [] } })], {
            detail: 'full',
            limit: 50
        });
        expect(result.recentRejections).toEqual([]);
    });

    it('still returns indexers when history is unavailable', async () => {
        const noHistory = {
            '/api/v1/indexer': INDEXERS,
            '/api/v1/indexerstatus': STATUS,
            '/api/v1/indexerstats': STATS
        };
        const result = await buildGetIndexers([adapter(noHistory)], { detail: 'full', limit: 50 });
        expect(result.items).toHaveLength(2);
        expect(result.recentRejections).toBeUndefined();
        expect(result.degraded).toEqual([]);
    });

    it('stays small for a realistic number of indexers', async () => {
        // A busy Prowlarr has tens of indexers, not hundreds. This is the
        // number that matters in practice, and it should be cheap.
        const fifty = repeat(INDEXERS[0]!, 50).map((i, n) => ({ ...i, id: n, name: `Indexer number ${n}` }));
        const result = await buildGetIndexers([adapter({ ...routes, '/api/v1/indexer': fifty })], {
            detail: 'full',
            limit: 500
        });
        expectWithinBudget(result, 2_000);
    });

    it('stays within its token budget at the absolute maximum', async () => {
        // 500 is the hard limit the schema allows, not a case anyone will hit.
        // The ceiling exists so a shaping regression — an extra field, an
        // unfenced blob — shows up as a jump rather than silently.
        const many = repeat(INDEXERS[0]!, 500).map((i, n) => ({ ...i, id: n, name: `Indexer number ${n}` }));
        const result = await buildGetIndexers([adapter({ ...routes, '/api/v1/indexer': many })], {
            detail: 'full',
            limit: 500
        });
        expectWithinBudget(result, 16_000);
    });
});

describe('ProwlarrAdapter.getRecentRejections', () => {
    it('asks Prowlarr for failures rather than filtering a page of history', async () => {
        // `pageSize` bounds the *history* window. Filtering `successful === false`
        // out of it afterwards means an indexer that failed forty queries
        // yesterday but has served twenty since answers with an empty list —
        // "no recent rejections" for a visibly failing indexer.
        const urls: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = input instanceof Request ? input.url : String(input);
            urls.push(url);
            return new Response(JSON.stringify(url.includes('/history') ? { records: [] } : []), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as unknown as typeof fetch;

        await new ProwlarrAdapter(config, impl).getRecentRejections(25);

        expect(urls.find(u => u.includes('/api/v1/history'))).toContain('successful=false');
    });
});

/**
 * Same root cause as the calendar's missing-file count, in the other
 * direction: `disabled` was counted over the *projected* items, and `minimal`
 * strips `disabledUntil`, so the cheap "is anything broken" question answered
 * "3 of 3 indexer(s)." with two of them disabled.
 */
describe('counting disabled indexers at minimal detail', () => {
    const rows = {
        '/api/v1/indexer': [
            { id: 1, name: 'One', enable: true, protocol: 'usenet', priority: 25 },
            { id: 2, name: 'Two', enable: true, protocol: 'usenet', priority: 25 },
            { id: 3, name: 'Three', enable: true, protocol: 'usenet', priority: 25 }
        ],
        '/api/v1/indexerstatus': [
            { id: 9, indexerId: 2, disabledTill: '2099-01-01T00:00:00Z' },
            { id: 10, indexerId: 3, disabledTill: '2099-01-01T00:00:00Z' }
        ],
        '/api/v1/indexerstats': { indexers: [] },
        '/api/v1/history': { records: [] }
    };

    it('counts the disabled ones even when the projection drops the field', async () => {
        const result = await buildGetIndexers([adapter(rows)], { detail: 'minimal', limit: 50 });

        expect(result.items[0]?.disabledUntil).toBeUndefined(); // the premise
        expect(result.disabledCount).toBe(2);
    });

    it('agrees with the full-detail count', async () => {
        const minimal = await buildGetIndexers([adapter(rows)], { detail: 'minimal', limit: 50 });
        const full = await buildGetIndexers([adapter(rows)], { detail: 'full', limit: 50 });

        expect(minimal.disabledCount).toBe(full.disabledCount);
    });
});

describe('several Prowlarrs', () => {
    const named = (name: string, r: Record<string, unknown> = routes) =>
        new ProwlarrAdapter({ ...config, name }, serving(r));

    const refuse = (async () => {
        throw new Error('connection refused');
    }) as unknown as typeof fetch;

    it('merges the indexers of every instance, attributed to each', async () => {
        const result = await buildGetIndexers([named('public'), named('private')], { detail: 'standard', limit: 50 });

        expect(result.total).toBe(4);
        expect(new Set(result.items.map(i => i.service))).toEqual(new Set(['prowlarr/public', 'prowlarr/private']));
    });

    // A partial list that says which Prowlarr is missing is useful; one that
    // silently drops half is not.
    it('degrades one by name while the other still answers', async () => {
        const broken = new ProwlarrAdapter({ ...config, name: 'private' }, refuse);
        const result = await buildGetIndexers([named('public'), broken], { detail: 'standard', limit: 50 });

        expect(result.degraded).toEqual(['prowlarr/private']);
        expect(result.total).toBe(2);
        expect(result.items.every(i => i.service === 'prowlarr/public')).toBe(true);
    });

    it('attributes a merged rejection to the instance that reported it', async () => {
        const result = await buildGetIndexers([named('public'), named('private')], { detail: 'full', limit: 50 });

        expect(result.recentRejections?.length).toBeGreaterThan(0);
        expect(new Set(result.recentRejections?.map(r => r.service))).toEqual(
            new Set(['prowlarr/public', 'prowlarr/private'])
        );
    });

    it('sorts by instance so two of them produce a stable order', async () => {
        const first = await buildGetIndexers([named('public'), named('private')], { detail: 'minimal', limit: 50 });
        const second = await buildGetIndexers([named('private'), named('public')], { detail: 'minimal', limit: 50 });

        expect(first.items.map(i => `${i.service}:${i.name}`)).toEqual(second.items.map(i => `${i.service}:${i.name}`));
    });

    it('answers empty when none is configured', async () => {
        expect(await buildGetIndexers([], { detail: 'standard', limit: 50 })).toMatchObject({ total: 0, degraded: [] });
    });

    // A healthy Prowlarr with nothing configured also has total === 0. Only
    // the fraction of instances actually degraded may claim total failure.
    it('does not claim total failure when a healthy instance simply has no indexers', async () => {
        const broken = new ProwlarrAdapter({ ...config, name: 'private' }, refuse);
        const empty = named('public', { ...routes, '/api/v1/indexer': [] });
        const result = await buildGetIndexers([empty, broken], { detail: 'standard', limit: 50 });

        expect(result.total).toBe(0);
        expect(result.degraded).toEqual(['prowlarr/private']);

        const summary = summarizeIndexers(result, 2);
        expect(summary).not.toContain('no indexer information available');
        expect(summary).toContain('prowlarr/private could not be reached');
    });
});

describe('summarizeIndexers', () => {
    const base = { items: [], returned: 0, offset: 0, truncated: false, disabledCount: 0 };

    it('claims total failure only when every configured instance degraded', () => {
        const result = { ...base, total: 0, degraded: ['prowlarr/a', 'prowlarr/b'] };
        expect(summarizeIndexers(result, 2)).toBe('prowlarr/a, prowlarr/b could not be reached; no indexer information available.');
    });

    it('names the degraded instance alongside the count when the others answered', () => {
        const result = { ...base, total: 3, returned: 3, degraded: ['prowlarr/b'] };
        expect(summarizeIndexers(result, 2)).toBe('3 of 3 indexer(s). prowlarr/b could not be reached.');
    });

    it('does not claim total failure when a healthy instance has zero indexers and another degraded', () => {
        const result = { ...base, total: 0, degraded: ['prowlarr/b'] };
        const summary = summarizeIndexers(result, 2);
        expect(summary).not.toMatch(/no indexer information available/);
        expect(summary).toContain('prowlarr/b could not be reached');
    });
});
