import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { apiKeyHeader } from '../src/core/auth.ts';
import { ServiceHttp } from '../src/core/http.ts';
import { readArrCommands } from '../src/services/arrCommands.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * `trigger_search` and `trigger_scan` hand back a command handle and there was
 * no way to ask what became of it — the only follow-up was waiting and
 * re-reading the queue.
 */
const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

function stack(routes: Record<string, unknown>) {
    const sent: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({
            path: url.pathname,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });
        if (url.pathname in routes) return jsonResponse(routes[url.pathname]);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return { impl, sent };
}

const QUEUED = { id: 1, name: 'MoviesSearch', status: 'queued', queued: '2026-09-02T12:00:00Z' };

describe('refreshing and renaming one item', () => {
    const command = { id: 9, name: 'RefreshMovie', status: 'queued' };

    it('refreshes one movie with the array shape Radarr wants', async () => {
        const s = stack({ '/api/v3/command': command });
        await new RadarrAdapter(keyed(7878), s.impl).refreshItem('15');
        expect(s.sent.at(-1)?.body).toEqual({ name: 'RefreshMovie', movieIds: [15] });
    });

    /** Sonarr takes a bare seriesId here, exactly as SeriesSearch does.
     *  Radarr's array shape is accepted and refreshes nothing. */
    it('refreshes one series with the bare seriesId Sonarr wants', async () => {
        const s = stack({ '/api/v3/command': command });
        await new SonarrAdapter(keyed(8989), s.impl).refreshItem('7');
        expect(s.sent.at(-1)?.body).toEqual({ name: 'RefreshSeries', seriesId: 7 });
    });

    it('renames one movie and one series', async () => {
        const movie = stack({ '/api/v3/command': command });
        await new RadarrAdapter(keyed(7878), movie.impl).renameItem('15');
        expect(movie.sent.at(-1)?.body).toEqual({ name: 'RenameMovie', movieIds: [15] });

        const series = stack({ '/api/v3/command': command });
        await new SonarrAdapter(keyed(8989), series.impl).renameItem('7');
        expect(series.sent.at(-1)?.body).toEqual({ name: 'RenameSeries', seriesIds: [7] });
    });

    it('refuses a non-integer id before posting anything', async () => {
        const s = stack({ '/api/v3/command': command });
        await expect(new RadarrAdapter(keyed(7878), s.impl).refreshItem('heat')).rejects.toThrow(/not a radarr/i);
        expect(s.sent).toHaveLength(0);
    });
});

describe('what a service is running', () => {
    const now = Date.parse('2026-09-02T12:10:00Z');

    it('reports queued and started commands', async () => {
        const s = stack({
            '/api/v3/command': [QUEUED, { id: 2, name: 'RefreshMovie', status: 'started', queued: '2026-09-02T12:05:00Z' }]
        });
        const rows = await new RadarrAdapter(keyed(7878), s.impl).listCommands();
        expect(rows.map(r => r.name)).toEqual(['RefreshMovie', 'MoviesSearch']);
        expect(rows[0]?.service).toBe('radarr');
    });

    /** The adapter's http is private, so the window rule is driven through
     *  the shared reader, which is where it lives. */
    const reader = (impl: typeof fetch) =>
        new ServiceHttp('radarr', keyed(7878), apiKeyHeader('X-Api-Key', 'k'), impl);

    it('keeps a command that finished a moment ago, so "did it work" is answerable', async () => {
        const s = stack({
            '/api/v3/command': [
                {
                    id: 3,
                    name: 'RefreshMovie',
                    status: 'completed',
                    queued: '2026-09-02T12:08:00Z',
                    ended: '2026-09-02T12:09:00Z'
                }
            ]
        });
        const rows = await readArrCommands(reader(s.impl), 'radarr', now);
        expect(rows.map(r => r.status)).toEqual(['completed']);
        expect(rows[0]?.endedAt).toBe('2026-09-02T12:09:00Z');
    });

    /** Measured live: the raw window on a quiet stack was 37 rows, every one
     *  of them a per-minute poller. Filtering on the trigger would not have
     *  helped — Radarr reports its own poller as `manual`. */
    it('leaves out the housekeeping nobody is following up', async () => {
        const s = stack({
            '/api/v3/command': [
                { id: 1, name: 'RefreshMonitoredDownloads', status: 'completed', trigger: 'manual', queued: '2026-09-02T12:09:00Z', ended: '2026-09-02T12:09:30Z' },
                { id: 2, name: 'ProcessMonitoredDownloads', status: 'started', queued: '2026-09-02T12:09:00Z' },
                { id: 3, name: 'MoviesSearch', status: 'started', queued: '2026-09-02T12:08:00Z' }
            ]
        });
        const rows = await readArrCommands(reader(s.impl), 'radarr', now);
        expect(rows.map(r => r.name)).toEqual(['MoviesSearch']);
    });

    it('drops a command that finished long ago — that is history, not status', async () => {
        const s = stack({
            '/api/v3/command': [
                { id: 4, name: 'RefreshMovie', status: 'completed', queued: '2026-09-02T09:00:00Z', ended: '2026-09-02T09:01:00Z' }
            ]
        });
        const rows = await readArrCommands(reader(s.impl), 'radarr', now);
        expect(rows).toEqual([]);
    });

    it('drops a row whose end time cannot be read rather than calling it running', async () => {
        const s = stack({
            '/api/v3/command': [{ id: 5, name: 'RenameMovie', status: 'completed', ended: 'yesterday' }]
        });
        const rows = await readArrCommands(reader(s.impl), 'radarr', now);
        expect(rows).toEqual([]);
    });
});
