import { describe, expect, it } from 'vitest';
import type { BaseServiceConfig } from '../src/config/schema.ts';
import { apiKeyHeader } from '../src/core/auth.ts';
import { ServiceHttp } from '../src/core/http.ts';
import { pageArr } from '../src/services/arrPaging.ts';

const config: BaseServiceConfig = {
    url: 'http://192.168.1.20:7878',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const http = (fetchImpl: unknown) =>
    new ServiceHttp('radarr', config, apiKeyHeader('X-Api-Key', 'secret'), fetchImpl as typeof fetch);

describe('pageArr', () => {
    it('pages to completion rather than trusting one response', async () => {
        const pages = [
            { records: [{ id: 1 }, { id: 2 }], totalRecords: 3 },
            { records: [{ id: 3 }], totalRecords: 3 }
        ];
        let call = 0;
        const rows = await pageArr<{ id: number }>(http(async () => json(pages[call++])), '/api/v3/history');
        expect(rows.map(r => r.id)).toEqual([1, 2, 3]);
        expect(call).toBe(2);
    });

    it('stops on an empty page whatever totalRecords claims', async () => {
        // A service that disagrees with its own count must not spin here. This
        // is the guard the whole extraction exists to keep in one place.
        let call = 0;
        const rows = await pageArr<{ id: number }>(
            http(async () => {
                call++;
                return json({ records: [], totalRecords: 9999 });
            }),
            '/api/v3/history'
        );
        expect(rows).toEqual([]);
        expect(call).toBe(1);
    });

    it('stops when totalRecords is missing', async () => {
        let call = 0;
        const rows = await pageArr<{ id: number }>(
            http(async () => {
                call++;
                return json({ records: [{ id: 1 }] });
            }),
            '/api/v3/history'
        );
        expect(rows.map(r => r.id)).toEqual([1]);
        expect(call).toBe(1);
    });

    it('sends page and pageSize, and appends the extra query', async () => {
        const seen: string[] = [];
        await pageArr(
            http(async (input: string) => {
                seen.push(String(input));
                return json({ records: [], totalRecords: 0 });
            }),
            '/api/v3/wanted/missing',
            'sortKey=airDateUtc'
        );
        expect(seen[0]).toContain('page=1');
        expect(seen[0]).toContain('pageSize=');
        expect(seen[0]).toContain('sortKey=airDateUtc');
    });

    it('stops early when stopWhen says so, without fetching the page after', async () => {
        const pages = [
            { records: [{ id: 1 }, { id: 2 }], totalRecords: 3 },
            { records: [{ id: 3 }], totalRecords: 3 }
        ];
        let call = 0;
        const rows = await pageArr<{ id: number }>(
            http(async () => json(pages[call++])),
            '/api/v3/history',
            undefined,
            // True on the first page already — the second must never be fetched.
            records => records.some(r => r.id === 2)
        );
        expect(rows.map(r => r.id)).toEqual([1, 2]);
        expect(call).toBe(1);
    });

    it('never calls stopWhen once the empty-page guard has already ended it — an additional reason to stop, not a replacement', async () => {
        let stopWhenCalls = 0;
        const rows = await pageArr<{ id: number }>(
            http(async () => json({ records: [], totalRecords: 9999 })),
            '/api/v3/history',
            undefined,
            () => {
                stopWhenCalls++;
                return false;
            }
        );
        expect(rows).toEqual([]);
        expect(stopWhenCalls).toBe(0);
    });
});
