import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { buildGetCalendar } from '../src/tools/getCalendar.ts';
import { repeat } from './helpers/bigFixture.ts';
import { expectWithinBudget } from './helpers/budget.ts';
import { serving } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const NOW = new Date('2026-08-05T12:00:00Z');
const now = () => NOW;

const MOVIES = [
    { id: 100, title: 'Some Film', digitalRelease: '2026-08-07T00:00:00Z', hasFile: false, monitored: true },
    { id: 101, title: 'Cinema Only', inCinemas: '2026-08-06T00:00:00Z', hasFile: false, monitored: true }
];

const EPISODES = [
    {
        id: 200,
        title: 'Pilot',
        seasonNumber: 1,
        episodeNumber: 1,
        airDateUtc: '2026-08-04T20:00:00Z',
        hasFile: true,
        monitored: true,
        series: { title: 'Some Show' }
    }
];

const radarr = (body: unknown = MOVIES) => new RadarrAdapter(keyed(7878), serving({ '/api/v3/calendar': body }));
const sonarr = (body: unknown = EPISODES) => new SonarrAdapter(keyed(8989), serving({ '/api/v3/calendar': body }));

const opts = { detail: 'full' as const, limit: 50, daysBack: 7, daysAhead: 14, now };

describe('get_calendar', () => {
    it('merges films and episodes into one chronological list', async () => {
        const result = await buildGetCalendar([radarr(), sonarr()], opts);
        expect(result.items.map(i => i.date)).toEqual([
            '2026-08-04T20:00:00Z',
            '2026-08-06T00:00:00Z',
            '2026-08-07T00:00:00Z'
        ]);
    });

    it('prefers the digital release date for a film that has one', async () => {
        const result = await buildGetCalendar([radarr()], opts);
        expect(result.items.find(i => i.id === 100)?.date).toBe('2026-08-07T00:00:00Z');
    });

    it('falls back to the cinema date when no digital date exists', async () => {
        const result = await buildGetCalendar([radarr()], opts);
        expect(result.items.find(i => i.id === 101)?.date).toBe('2026-08-06T00:00:00Z');
    });

    it('dates a film by the release inside the window, not a later or earlier one', async () => {
        const films = [
            // In cinemas next week, digital months away.
            { id: 103, title: 'Cinema Now', inCinemas: '2026-08-10T00:00:00Z', digitalRelease: '2026-12-01T00:00:00Z', hasFile: false, monitored: true },
            // Digital long ago, physical this week.
            { id: 104, title: 'Disc Now', digitalRelease: '2024-01-01T00:00:00Z', physicalRelease: '2026-08-03T00:00:00Z', hasFile: false, monitored: true },
            // Two inside: the earlier one.
            { id: 105, title: 'Both', physicalRelease: '2026-08-09T00:00:00Z', inCinemas: '2026-08-01T00:00:00Z', hasFile: false, monitored: true }
        ];
        const result = await buildGetCalendar([radarr(films)], opts);
        expect(result.items.map(i => [i.id, i.date])).toEqual([
            [105, '2026-08-01T00:00:00Z'],
            [104, '2026-08-03T00:00:00Z'],
            [103, '2026-08-10T00:00:00Z']
        ]);
    });

    it('counts days back from the start of today, so 0 keeps what aired this morning', async () => {
        const morning = [{ ...EPISODES[0]!, airDateUtc: '2026-08-05T06:00:00Z' }];
        // Answers only what lies in the window asked for, as Sonarr does.
        const windowed = (async (input: string) => {
            const url = new URL(String(input));
            const [start, end] = ['start', 'end'].map(k => Date.parse(url.searchParams.get(k) ?? ''));
            const rows = morning.filter(e => Date.parse(e.airDateUtc) >= start! && Date.parse(e.airDateUtc) <= end!);
            return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;
        const result = await buildGetCalendar([new SonarrAdapter(keyed(8989), windowed)], { ...opts, daysBack: 0 });
        expect(result.items).toHaveLength(1);
    });

    it('omits a film with no date at all rather than emitting an undated row', async () => {
        const undated = [{ id: 102, title: 'No Date', hasFile: false, monitored: true }];
        expect((await buildGetCalendar([radarr(undated)], opts)).items).toEqual([]);
    });

    it('carries the series title on an episode', async () => {
        const result = await buildGetCalendar([sonarr()], opts);
        expect(result.items[0]).toMatchObject({ kind: 'episode', season: 1, episode: 1 });
        expect(result.items[0]?.seriesTitle).toContain('Some Show');
    });

    it('requests the window the caller asked for', async () => {
        const seen: string[] = [];
        const spy = (async (input: string) => {
            seen.push(String(input));
            return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;

        await buildGetCalendar([new RadarrAdapter(keyed(7878), spy)], { ...opts, daysBack: 3, daysAhead: 5 });

        const url = new URL(seen[0] ?? '');
        expect(url.searchParams.get('start')).toBe('2026-08-02T00:00:00.000Z');
        expect(url.searchParams.get('end')).toBe('2026-08-10T12:00:00.000Z');
    });

    it('degrades when one of the two services is down', async () => {
        const broken = new SonarrAdapter(
            keyed(8989),
            (async () => {
                throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
            }) as unknown as typeof fetch
        );
        const result = await buildGetCalendar([radarr(), broken], opts);

        expect(result.items).toHaveLength(2);
        expect(result.degraded).toEqual(['sonarr']);
        expect(result.counts).toEqual({ radarr: 2 });
    });

    it('reports truncation honestly', async () => {
        const many = repeat(MOVIES[0]!, 200).map((m, n) => ({ ...m, id: n }));
        const result = await buildGetCalendar([radarr(many)], { ...opts, detail: 'standard', limit: 50 });
        expect(result).toMatchObject({ total: 200, truncated: true });
    });

    it('returns title and date only at detail: minimal', async () => {
        const result = await buildGetCalendar([sonarr()], { ...opts, detail: 'minimal' });
        expect(Object.keys(result.items[0] ?? {}).sort()).toEqual(['date', 'id', 'kind', 'service', 'title']);
    });

    it('stays within its token budget at the absolute maximum', async () => {
        const many = repeat(MOVIES[0]!, 500).map((m, n) => ({ ...m, id: n }));
        const result = await buildGetCalendar([radarr(many)], { ...opts, limit: 500 });
        expectWithinBudget(result, 30_000);
    });
});

/**
 * The summary counted `!i.hasFile` over the *projected* items, and `minimal`
 * drops `hasFile` — so `!undefined` was true for every row and a fully
 * downloaded calendar read "N without a file".
 */
describe('counting files at minimal detail', () => {
    const DOWNLOADED = [
        { id: 300, title: 'Have It', digitalRelease: '2026-08-07T00:00:00Z', hasFile: true, monitored: true },
        { id: 301, title: 'Have It Too', digitalRelease: '2026-08-08T00:00:00Z', hasFile: true, monitored: true }
    ];

    it('reports nothing missing when every item has a file, even at minimal', async () => {
        const result = await buildGetCalendar([radarr(DOWNLOADED)], {
            detail: 'minimal',
            limit: 50,
            daysBack: 7,
            daysAhead: 14,
            now
        });

        expect(result.items[0]?.hasFile).toBeUndefined(); // the premise: minimal drops it
        expect(result.missingFiles).toBe(0);
    });

    it('still counts the ones actually missing a file', async () => {
        const result = await buildGetCalendar([radarr()], {
            detail: 'minimal',
            limit: 50,
            daysBack: 7,
            daysAhead: 14,
            now
        });

        expect(result.missingFiles).toBe(2);
    });

    it('agrees with the full-detail count', async () => {
        const opts = { limit: 50, daysBack: 7, daysAhead: 14, now };
        const minimal = await buildGetCalendar([radarr()], { ...opts, detail: 'minimal' as const });
        const full = await buildGetCalendar([radarr()], { ...opts, detail: 'full' as const });

        expect(minimal.missingFiles).toBe(full.missingFiles);
    });
});
