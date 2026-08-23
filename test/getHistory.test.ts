import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildGetHistory } from '../src/tools/getHistory.ts';
import { repeat } from './helpers/bigFixture.ts';
import { expectWithinBudget } from './helpers/budget.ts';
import { serving } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const RADARR_HISTORY = {
    records: [
        { id: 1, eventType: 'grabbed', date: '2026-08-01T10:00:00Z', sourceTitle: 'Alien.1979', movieId: 1689 },
        { id: 2, eventType: 'downloadFolderImported', date: '2026-08-01T11:00:00Z', sourceTitle: 'Alien.1979', movieId: 1689 }
    ]
};

const SONARR_HISTORY = {
    records: [
        {
            id: 3,
            eventType: 'downloadFailed',
            date: '2026-08-02T09:00:00Z',
            sourceTitle: 'Some.Show.S01E01',
            seriesId: 42,
            episodeId: 908,
            data: { message: 'Afgebroken, kan niet voltooid worden' }
        }
    ]
};

const radarr = (body: unknown = RADARR_HISTORY) => new RadarrAdapter(keyed(7878), serving({ '/api/v3/history': body }));
const sonarr = (body: unknown = SONARR_HISTORY) => new SonarrAdapter(keyed(8989), serving({ '/api/v3/history': body }));

const opts = { detail: 'full' as const, limit: 50 };

describe('get_history', () => {
    it('merges Radarr and Sonarr into one list', async () => {
        const result = await buildGetHistory([radarr(), sonarr()], opts);
        expect(result.items.map(i => i.service).sort()).toEqual(['radarr', 'radarr', 'sonarr']);
        expect(result.total).toBe(3);
    });

    it('sorts newest first', async () => {
        const result = await buildGetHistory([radarr(), sonarr()], opts);
        expect(result.items.map(i => i.id)).toEqual(['3', '2', '1']);
    });

    it('reports each service under its own count', async () => {
        const result = await buildGetHistory([radarr(), sonarr()], opts);
        expect(result.counts).toEqual({ radarr: 2, sonarr: 1 });
    });

    it('normalises the event vocabulary across both services', async () => {
        const result = await buildGetHistory([radarr(), sonarr()], opts);
        const byId = Object.fromEntries(result.items.map(i => [i.id, i.event]));
        expect(byId).toEqual({ '1': 'grabbed', '2': 'imported', '3': 'failed' });
    });

    it('fences a failure message even though it is not English', async () => {
        const result = await buildGetHistory([sonarr()], opts);
        expect(result.items[0]?.reason).toContain('<<untrusted:sonarr.reason>>');
        expect(result.items[0]?.reason).not.toContain('Afgebroken, kan niet voltooid worden</');
        expect(result.items[0]?.reason).toMatch(/Afgebroken/);
    });

    it('filters by event_type', async () => {
        const result = await buildGetHistory([radarr(), sonarr()], { ...opts, eventType: 'failed' });
        expect(result.items.map(i => i.id)).toEqual(['3']);
        expect(result.total).toBe(1);
    });

    it('counts reflect the event_type filter, not the raw per-service total', async () => {
        const result = await buildGetHistory([radarr(), sonarr()], { ...opts, eventType: 'grabbed' });
        expect(result.counts).toEqual({ radarr: 1, sonarr: 0 });
    });

    it('filters by since', async () => {
        const result = await buildGetHistory([radarr(), sonarr()], { ...opts, since: '2026-08-02T00:00:00Z' });
        expect(result.items.map(i => i.id)).toEqual(['3']);
    });

    it('scopes to one item via service and id, using the per-media endpoint', async () => {
        const seen: string[] = [];
        const scopedRadarr = new RadarrAdapter(
            keyed(7878),
            (async (input: string) => {
                seen.push(String(input));
                return new Response(JSON.stringify({ records: [], totalRecords: 0 }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }) as unknown as typeof fetch
        );
        await buildGetHistory([scopedRadarr, sonarr()], { ...opts, service: 'radarr', id: '1689' });
        expect(seen[0]).toContain('/api/v3/history/movie');
        expect(seen[0]).toContain('movieId=1689');
    });

    it('refuses an id with no service, rather than matching a coincidental id in the wrong service', async () => {
        await expect(buildGetHistory([radarr(), sonarr()], { ...opts, id: '1689' })).rejects.toThrow(/service/);
    });

    it('exposes episodeId separately from mediaId for Sonarr', async () => {
        const result = await buildGetHistory([sonarr()], opts);
        expect(result.items[0]).toMatchObject({ mediaId: '42', episodeId: '908' });
    });

    it('returns the other service worth of history when one is down', async () => {
        const broken = new SonarrAdapter(
            keyed(8989),
            (async () => {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }) as unknown as typeof fetch
        );
        const result = await buildGetHistory([radarr(), broken], opts);

        expect(result.items).toHaveLength(2);
        expect(result.degraded).toEqual(['sonarr']);
    });

    it('ignores adapters that have no history at all', async () => {
        const bare: ServiceAdapter = {
            id: 'prowlarr',
            type: 'prowlarr',
            getVersion: async () => '2.0.0',
            testConnection: async () => ({ ok: true, service: 'prowlarr', latency_ms: 1 })
        };
        const result = await buildGetHistory([radarr(), bare], opts);

        expect(result.total).toBe(2);
        expect(result.degraded).toEqual([]);
    });

    it('reads the whole history rather than the server default first page', async () => {
        const total = 25;
        const pagingHistory = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname !== '/api/v3/history') return new Response('{}', { status: 404 });
            const pageSize = Number(url.searchParams.get('pageSize') ?? 10);
            const page = Number(url.searchParams.get('page') ?? 1);
            const start = (page - 1) * pageSize;
            const records = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => ({
                id: start + i + 1,
                eventType: 'grabbed',
                date: `2026-08-01T${String(10 + i).padStart(2, '0')}:00:00Z`,
                sourceTitle: `Film.${start + i + 1}`
            }));
            return new Response(JSON.stringify({ page, pageSize, totalRecords: total, records }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as unknown as typeof fetch;

        const result = await buildGetHistory([new RadarrAdapter(keyed(7878), pagingHistory)], { detail: 'full', limit: 100 });
        expect(result.total).toBe(25);
        expect(result.items.map(i => i.id)).toContain('25');
    });

    it('reports truncation honestly across merged services', async () => {
        const many = { records: repeat(RADARR_HISTORY.records[0]!, 300) };
        const result = await buildGetHistory([radarr(many)], { detail: 'standard', limit: 50 });
        expect(result).toMatchObject({ total: 300, returned: 50, truncated: true });
    });

    it('returns id, at, event, title and mediaId only at detail: minimal', async () => {
        const result = await buildGetHistory([radarr()], { detail: 'minimal', limit: 50 });
        expect(Object.keys(result.items[0] ?? {}).sort()).toEqual(['at', 'event', 'id', 'mediaId', 'service', 'title']);
    });

    it('trims rawEvent, guid and indexerId below detail: full', async () => {
        const withGuid = {
            records: [
                {
                    id: 1,
                    eventType: 'grabbed',
                    date: '2026-08-01T10:00:00Z',
                    sourceTitle: 'Alien.1979',
                    data: { guid: 'abc-123', indexerId: 7 }
                }
            ]
        };
        const result = await buildGetHistory([radarr(withGuid)], { detail: 'standard', limit: 50 });
        expect(result.items[0]).not.toHaveProperty('guid');
        expect(result.items[0]).not.toHaveProperty('indexerId');
        expect(result.items[0]).not.toHaveProperty('rawEvent');
    });

    it('keeps rawEvent, guid and indexerId at detail: full', async () => {
        const withGuid = {
            records: [
                {
                    id: 1,
                    eventType: 'grabbed',
                    date: '2026-08-01T10:00:00Z',
                    sourceTitle: 'Alien.1979',
                    data: { guid: 'abc-123', indexerId: 7 }
                }
            ]
        };
        const result = await buildGetHistory([radarr(withGuid)], { detail: 'full', limit: 50 });
        expect(result.items[0]).toMatchObject({ rawEvent: 'grabbed', guid: 'abc-123', indexerId: 7 });
    });

    it('returns an empty result with no adapters configured', async () => {
        expect(await buildGetHistory([], opts)).toMatchObject({ items: [], total: 0, degraded: [], counts: {} });
    });

    it('stays within its token budget at the absolute maximum', async () => {
        const many = { records: repeat(RADARR_HISTORY.records[0]!, 500) };
        const result = await buildGetHistory([radarr(many)], { detail: 'full', limit: 500 });
        expectWithinBudget(result, 40_000);
    });
});
