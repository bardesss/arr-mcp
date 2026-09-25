import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { applyLimit } from '../src/core/shape.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import type { HistoryEntry } from '../src/services/types.ts';
import { buildGetHistory } from '../src/tools/getHistory.ts';
import { buildGetWanted } from '../src/tools/getWanted.ts';
import { jsonResponse } from './helpers/serve.ts';

// #293: each service hands over only the rows the window needs. These check
// the merged window still matches slicing the two whole lists.

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const paged = (records: unknown[], pages: number[]) =>
    (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const page = Number(url.searchParams.get('page'));
        const size = Number(url.searchParams.get('pageSize'));
        pages.push(page);
        return jsonResponse({ page, pageSize: size, totalRecords: records.length, records: records.slice((page - 1) * size, page * size) });
    }) as unknown as typeof fetch;

const base = Date.UTC(2026, 8, 24);
const historyRows = (count: number, step: number, offset: number) =>
    Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        eventType: 'grabbed',
        date: new Date(base - (i * step + offset) * 60_000).toISOString(),
        sourceTitle: `Release.${i}`
    }));

const RADARR_HISTORY = historyRows(430, 3, 0);
const SONARR_HISTORY = historyRows(610, 2, 1);
const RADARR_WANTED = Array.from({ length: 230 }, (_, i) => ({ id: i + 1, title: `Film ${i}`, monitored: true }));
const SONARR_WANTED = Array.from({ length: 410 }, (_, i) => ({
    id: 10_000 + i,
    seriesId: 1 + (i % 7),
    title: `Episode ${i}`,
    monitored: true,
    series: { title: `Show ${1 + (i % 7)}` }
}));

const history = (pages: number[] = []) => [
    new RadarrAdapter(keyed(7878), paged(RADARR_HISTORY, pages)),
    new SonarrAdapter(keyed(8989), paged(SONARR_HISTORY, pages))
];
const wanted = (pages: number[] = []) => [
    new RadarrAdapter(keyed(7878), paged(RADARR_WANTED, pages)),
    new SonarrAdapter(keyed(8989), paged(SONARR_WANTED, pages))
];

const WINDOWS = [
    { limit: 10, offset: 0 },
    { limit: 50, offset: 180 },
    { limit: 500, offset: 0 },
    { limit: 100, offset: 200 },
    { limit: 100, offset: 400 },
    { limit: 25, offset: 1030 },
    { limit: 10, offset: 5000 }
];

const key = (i: { service: string; id: string }) => `${i.service}:${i.id}`;

describe('get_history reads only the window it returns (#293)', () => {
    it('fetches one page per service for limit 10, and still reports the full total', async () => {
        const pages: number[] = [];
        const result = await buildGetHistory(history(pages), { detail: 'full', limit: 10 });
        expect(pages).toEqual([1, 1]);
        expect(result.total).toBe(430 + 610);
        expect(result.counts).toEqual({ radarr: 430, sonarr: 610 });
        expect(result.truncated).toBe(true);
    });

    it.each(WINDOWS)('matches slicing the whole merged history at limit $limit, offset $offset', async ({ limit, offset }) => {
        const reads = await Promise.all(history().map(a => a.readHistory({})));
        const everything = reads
            .flatMap(r => (Array.isArray(r) ? r : r.items))
            .sort((a: HistoryEntry, b: HistoryEntry) => b.at.localeCompare(a.at));
        const expected = applyLimit(everything, limit, offset);

        const result = await buildGetHistory(history(), { detail: 'full', limit, offset });
        expect(result.items.map(key)).toEqual(expected.items.map(key));
        expect(result.total).toBe(expected.total);
        expect(result.truncated).toBe(expected.truncated);
    });
});

describe('get_wanted reads only the window it returns (#293)', () => {
    it('fetches one page per service for limit 10, and still reports the full total', async () => {
        const pages: number[] = [];
        const result = await buildGetWanted(wanted(pages), { scope: 'missing', detail: 'full', limit: 10 });
        expect(pages).toEqual([1, 1]);
        expect(result.total).toBe(230 + 410);
        expect(result.counts).toEqual({ radarr: 230, sonarr: 410 });
    });

    it.each(WINDOWS)('matches slicing both whole lists end to end at limit $limit, offset $offset', async ({ limit, offset }) => {
        const everything = (await Promise.all(wanted().map(async a => (await a.readWanted('missing')).items))).flat();
        const expected = applyLimit(everything, limit, offset);
        const row = (i: { service: string; id: string; episodeTitle?: string }) => `${key(i)}:${i.episodeTitle ?? ''}`;

        const result = await buildGetWanted(wanted(), { scope: 'missing', detail: 'full', limit, offset });
        expect(result.items.map(row)).toEqual(expected.items.map(row));
        expect(result.total).toBe(expected.total);
        expect(result.truncated).toBe(expected.truncated);
    });
});
