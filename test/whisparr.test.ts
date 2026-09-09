import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';

const config: KeyedServiceConfig = {
    url: 'http://192.168.1.20:6969',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const V2 = { appName: 'Whisparr', version: '2.2.0.108', instanceName: 'Whisparr' };
/** What an Eros instance answers on the same path with the same header. */
const EROS = { appName: 'Whisparr', version: '3.4.0.1387', instanceName: 'Whisparr' };

/**
 * Dated by `releaseDate`, with no `airDateUtc` and no `episodeNumber` — the
 * shape a live 2.2.0.108 returns.
 */
const CALENDAR = [
    {
        id: 41,
        title: 'Scene 1',
        seasonNumber: 2026,
        releaseDate: '2026-09-02',
        hasFile: true,
        monitored: true,
        series: { title: 'Site 1' }
    },
    {
        id: 42,
        title: 'Scene 2',
        seasonNumber: 2026,
        releaseDate: '2026-09-03',
        hasFile: false,
        monitored: true,
        series: { title: 'Site 1' }
    }
];

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serving = (routes: Record<string, unknown>) =>
    (async (input: string) => {
        const path = new URL(String(input)).pathname;
        if (!(path in routes)) return json({ message: 'not found' }, 404);
        return json(routes[path]);
    }) as unknown as typeof fetch;

const adapter = (routes: Record<string, unknown>) => new WhisparrAdapter(config, serving(routes));

describe('WhisparrAdapter', () => {
    it('returns the version from /api/v3/system/status', async () => {
        expect(await adapter({ '/api/v3/system/status': V2 }).getVersion()).toBe('2.2.0.108');
    });

    /**
     * The whole reason V2 and Eros are separate service ids. Nothing in the URL
     * or the credential distinguishes them, and `assertVersionSupported` only
     * has a floor — Eros is 3.x, above it — so without this an Eros instance
     * connects cleanly and fails later on a `/series` route it does not serve.
     */
    it('refuses an Eros instance by name rather than failing later on /series', async () => {
        await expect(adapter({ '/api/v3/system/status': EROS }).getVersion()).rejects.toThrow(/Eros/);
    });

    it('reports the refusal as a failed connection, not a thrown error', async () => {
        const d = await adapter({ '/api/v3/system/status': EROS }).testConnection();
        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('VersionUnsupported');
    });

    it('diagnoses a healthy V2 instance', async () => {
        const d = await adapter({ '/api/v3/system/status': V2 }).testConnection();
        expect(d.ok).toBe(true);
        expect(d.version).toBe('2.2.0.108');
    });

    /**
     * `readSonarrCalendar` drops every row missing the field it dates by, so
     * the Sonarr default would return an empty calendar here — no error, no
     * rows, nothing to notice. This is the test that fails if the date field
     * argument is ever dropped.
     */
    it('reads the calendar by releaseDate, which is the only date Whisparr sends', async () => {
        const entries = await adapter({ '/api/v3/calendar': CALENDAR }).getCalendar({
            start: new Date('2026-09-01'),
            end: new Date('2026-12-31')
        });

        expect(entries).toHaveLength(2);
        expect(entries[0]?.date).toBe('2026-09-02');
        // Fenced, like every other title crossing this boundary — asserted by
        // containment so the test does not pin the fence's wording.
        expect(entries[0]?.seriesTitle).toContain('Site 1');
    });

    /** A season is a release year, so it must survive as the integer it is. */
    it('carries the release year through as the season', async () => {
        const entries = await adapter({ '/api/v3/calendar': CALENDAR }).getCalendar({
            start: new Date('2026-09-01'),
            end: new Date('2026-12-31')
        });

        expect(entries[0]?.season).toBe(2026);
    });

    it('refuses a non-integer site id before issuing a request', async () => {
        await expect(adapter({}).listEpisodeFiles('not-an-id')).rejects.toThrow(/not a Whisparr site id/);
    });
});
