import { describe, expect, it } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { serving } from './helpers/serve.ts';

const base = {
    url: 'http://192.0.2.10:7878',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const PAGE = 'page=1&pageSize=50&sortKey=date&sortDirection=descending';
const byId = (id: string) => `/api/v3/history?downloadId=${id}&${PAGE}`;
const radarr = (routes: Record<string, unknown>) => new RadarrAdapter(base, serving(routes));
const sonarr = (routes: Record<string, unknown>) => new SonarrAdapter(base, serving(routes));
const fence = (value: string) => fenceText(value, { service: 'radarr', field: 'sourceTitle' });

describe('traceDownload', () => {
    it('returns undefined when Radarr never grabbed the id', async () => {
        expect(await radarr({ [byId('abc')]: { records: [] } }).traceDownload('abc')).toBeUndefined();
    });

    it('reports the failure and a later replacement that was imported', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [
                    { eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', movieId: 7, sourceTitle: 'Old.Release', downloadId: 'abc' },
                    { eventType: 'grabbed', date: '2026-10-01T09:00:00Z', movieId: 7, sourceTitle: 'Old.Release', downloadId: 'abc' }
                ]
            },
            [`/api/v3/history?movieIds=7&eventType=1&${PAGE}`]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', movieId: 7, sourceTitle: 'New.Release', downloadId: 'def' }]
            },
            [byId('def')]: {
                records: [{ eventType: 'downloadFolderImported', date: '2026-10-01T10:30:00Z', movieId: 7, downloadId: 'def' }]
            }
        }).traceDownload('abc');
        expect(trace).toEqual({
            service: 'radarr',
            title: fence('Old.Release'),
            failedAt: '2026-10-01T10:00:00Z',
            replacement: { title: fence('New.Release'), grabbedAt: '2026-10-01T10:05:00Z', imported: true }
        });
    });

    it('reports a replacement that has not been imported yet', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [
                    { eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' },
                    { eventType: 'grabbed', date: '2026-10-01T09:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' }
                ]
            },
            [`/api/v3/history?movieIds=7&eventType=1&${PAGE}`]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', movieId: 7, sourceTitle: 'New', downloadId: 'def' }]
            },
            [byId('def')]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', movieId: 7, downloadId: 'def' }]
            }
        }).traceDownload('abc');
        expect(trace?.replacement?.imported).toBe(false);
    });

    it('ignores grabs from before the failure and the failed download itself', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [
                    { eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' },
                    { eventType: 'grabbed', date: '2026-10-01T09:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' }
                ]
            },
            [`/api/v3/history?movieIds=7&eventType=1&${PAGE}`]: {
                records: [
                    { eventType: 'grabbed', date: '2026-10-01T09:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' },
                    { eventType: 'grabbed', date: '2026-09-30T09:00:00Z', movieId: 7, sourceTitle: 'Earlier', downloadId: 'zzz' }
                ]
            }
        }).traceDownload('abc');
        expect(trace).toEqual({ service: 'radarr', title: fence('Old'), failedAt: '2026-10-01T10:00:00Z' });
    });

    it('reports no failure without a second read when nothing failed', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T09:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' }]
            }
        }).traceDownload('abc');
        expect(trace).toEqual({ service: 'radarr', title: fence('Old') });
    });

    // Whether every supported build applies `movieIds` is not established;
    // the result must not depend on it.
    it('ignores a later grab for another movie, even if the server ignored movieIds', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [
                    { eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' },
                    { eventType: 'grabbed', date: '2026-10-01T09:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' }
                ]
            },
            [`/api/v3/history?movieIds=7&eventType=1&${PAGE}`]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', movieId: 8, sourceTitle: 'Other.Film', downloadId: 'def' }]
            }
        }).traceDownload('abc');
        expect(trace?.replacement).toBeUndefined();
    });

    it('ignores a later grab for another series, even with no episodes to match', async () => {
        const trace = await sonarr({
            [byId('abc')]: {
                records: [{ eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', seriesId: 3, sourceTitle: 'Old', downloadId: 'abc' }]
            },
            [`/api/v3/history?seriesIds=3&eventType=1&${PAGE}`]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', seriesId: 4, sourceTitle: 'Other.Show', downloadId: 'def' }]
            }
        }).traceDownload('abc');
        expect(trace?.replacement).toBeUndefined();
    });

    // A server that ignored `downloadId=` would answer unrelated records,
    // and those without an id would otherwise pass for this download's.
    it('counts only records carrying exactly this download id', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [
                    { eventType: 'movieFileRenamed', date: '2026-10-01T10:00:00Z', movieId: 7, sourceTitle: 'Unrelated' },
                    { eventType: 'grabbed', date: '2026-10-01T09:00:00Z', movieId: 7, sourceTitle: 'Other', downloadId: 'abcd' }
                ]
            }
        }).traceDownload('abc');
        expect(trace).toBeUndefined();
    });

    it('does not count an import of another download as the replacement\'s', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [{ eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' }]
            },
            [`/api/v3/history?movieIds=7&eventType=1&${PAGE}`]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', movieId: 7, sourceTitle: 'New', downloadId: 'def' }]
            },
            [byId('def')]: {
                records: [{ eventType: 'downloadFolderImported', date: '2026-10-01T10:30:00Z', movieId: 7, downloadId: 'defg' }]
            }
        }).traceDownload('abc');
        expect(trace?.replacement).toMatchObject({ title: fence('New'), imported: false });
    });

    it('names the newest of several later grabs, whatever order they arrive in', async () => {
        const trace = await radarr({
            [byId('abc')]: {
                records: [{ eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', movieId: 7, sourceTitle: 'Old', downloadId: 'abc' }]
            },
            [`/api/v3/history?movieIds=7&eventType=1&${PAGE}`]: {
                records: [
                    { eventType: 'grabbed', date: '2026-10-01T10:05:00Z', movieId: 7, sourceTitle: 'First', downloadId: 'd1' },
                    { eventType: 'grabbed', date: '2026-10-01T12:00:00Z', movieId: 7, sourceTitle: 'Newest', downloadId: 'd3' },
                    { eventType: 'grabbed', date: '2026-10-01T11:00:00Z', movieId: 7, sourceTitle: 'Second', downloadId: 'd2' }
                ]
            },
            [byId('d3')]: { records: [] }
        }).traceDownload('abc');
        expect(trace?.replacement).toEqual({ title: fence('Newest'), grabbedAt: '2026-10-01T12:00:00Z', imported: false });
    });

    // A failed grab with no episode ids (an older Sonarr record) can only be
    // matched on the series.
    it('Sonarr falls back to the series when the failed grab names no episodes', async () => {
        const trace = await sonarr({
            [byId('abc')]: {
                records: [{ eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', seriesId: 3, sourceTitle: 'Old', downloadId: 'abc' }]
            },
            [`/api/v3/history?seriesIds=3&eventType=1&${PAGE}`]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', seriesId: 3, episodeId: 99, sourceTitle: 'New', downloadId: 'def' }]
            },
            [byId('def')]: { records: [] }
        }).traceDownload('abc');
        expect(trace?.replacement?.title).toBe(fenceText('New', { service: 'sonarr', field: 'sourceTitle' }));
    });

    it('Sonarr ignores a later grab with no episode when the failed one named episodes', async () => {
        const trace = await sonarr({
            [byId('abc')]: {
                records: [
                    { eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', seriesId: 3, episodeId: 31, sourceTitle: 'Old', downloadId: 'abc' }
                ]
            },
            [`/api/v3/history?seriesIds=3&eventType=1&${PAGE}`]: {
                records: [{ eventType: 'grabbed', date: '2026-10-01T10:05:00Z', seriesId: 3, sourceTitle: 'New', downloadId: 'def' }]
            }
        }).traceDownload('abc');
        expect(trace?.replacement).toBeUndefined();
    });

    it('Sonarr scopes the replacement to the same episodes', async () => {
        const routes = (laterEpisode: number) => ({
            [byId('abc')]: {
                records: [
                    { eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', seriesId: 3, episodeId: 31, sourceTitle: 'Old', downloadId: 'abc' },
                    { eventType: 'grabbed', date: '2026-10-01T09:00:00Z', seriesId: 3, episodeId: 31, sourceTitle: 'Old', downloadId: 'abc' }
                ]
            },
            [`/api/v3/history?seriesIds=3&eventType=1&${PAGE}`]: {
                records: [
                    { eventType: 'grabbed', date: '2026-10-01T10:05:00Z', seriesId: 3, episodeId: laterEpisode, sourceTitle: 'New', downloadId: 'def' }
                ]
            },
            [byId('def')]: {
                records: [{ eventType: 'downloadFolderImported', date: '2026-10-01T10:30:00Z', downloadId: 'def' }]
            }
        });
        expect((await sonarr(routes(32)).traceDownload('abc'))?.replacement).toBeUndefined();
        const same = await sonarr(routes(31)).traceDownload('abc');
        expect(same?.replacement).toEqual({
            title: fenceText('New', { service: 'sonarr', field: 'sourceTitle' }),
            grabbedAt: '2026-10-01T10:05:00Z',
            imported: true
        });
    });
});
