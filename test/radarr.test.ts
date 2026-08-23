import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { hasDiskSpace, hasHealthChecks, hasScanState } from '../src/services/types.ts';

const config: KeyedServiceConfig = {
    url: 'http://192.168.1.20:7878',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const STATUS = { appName: 'Radarr', version: '6.3.0.10514', instanceName: 'Radarr' };
const DISKSPACE = [{ path: '/movies', label: 'movies', freeSpace: 1_234_567_890, totalSpace: 9_876_543_210 }];
const HEALTH = [{ source: 'IndexerStatusCheck', type: 'warning', message: 'Indexers unavailable due to failures' }];
/** Trimmed from a real capture: a live Radarr runs eleven of these. */
const TASKS = [
    { taskName: 'RefreshMovie', lastExecution: '2026-08-04T15:09:00Z' },
    { taskName: 'RefreshMonitoredDownloads', lastExecution: '2026-08-05T14:09:00Z' },
    { taskName: 'RefreshCollections', lastExecution: '2026-08-04T18:57:21Z' },
    { taskName: 'Backup', lastExecution: '2026-08-01T02:00:00Z' }
];

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serving = (routes: Record<string, unknown>) =>
    (async (input: string) => {
        const path = new URL(String(input)).pathname;
        if (!(path in routes)) return json({ message: 'not found' }, 404);
        return json(routes[path]);
    }) as unknown as typeof fetch;

const adapter = (routes: Record<string, unknown>) => new RadarrAdapter(config, serving(routes));

describe('RadarrAdapter', () => {
    it('returns the version from /api/v3/system/status', async () => {
        expect(await adapter({ '/api/v3/system/status': STATUS }).getVersion()).toBe('6.3.0.10514');
    });

    it('fails loudly when system/status carries no version field', async () => {
        await expect(adapter({ '/api/v3/system/status': { appName: 'Radarr' } }).getVersion()).rejects.toThrow(
            /no version field/
        );
    });

    it('diagnoses a healthy instance with a latency measurement and version', async () => {
        const d = await adapter({ '/api/v3/system/status': STATUS }).testConnection();
        expect(d.ok).toBe(true);
        expect(d.service).toBe('radarr');
        expect(d.version).toBe('6.3.0.10514');
        expect(d.latency_ms).toBeGreaterThanOrEqual(0);
        expect(d.error).toBeUndefined();
    });

    it('diagnoses a bad api key as AuthFailed with a remedy, not as a thrown error', async () => {
        const unauthorized = (async () => json({ message: 'Unauthorized' }, 401)) as unknown as typeof fetch;
        const d = await new RadarrAdapter(config, unauthorized).testConnection();
        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('AuthFailed');
        expect(d.error?.remedy).toMatch(/api key/i);
    });

    it('diagnoses connection refused as Unreachable', async () => {
        const refuse = (async () => {
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }) as unknown as typeof fetch;
        const d = await new RadarrAdapter(config, refuse).testConnection();
        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('Unreachable');
    });

    it('stamps every disk row with the reporting service', async () => {
        const disks = await adapter({ '/api/v3/diskspace': DISKSPACE }).getDiskSpace();
        expect(disks).toHaveLength(1);
        expect(disks[0]?.service).toBe('radarr');
        expect(disks[0]?.freeSpace).toBe(1_234_567_890);
        expect(disks[0]?.path).toBe('/movies');
    });

    it('returns only failing health checks, stamped with the service', async () => {
        const body = [...HEALTH, { source: 'X', type: 'ok', message: 'fine' }];
        const checks = await adapter({ '/api/v3/health': body }).getFailedHealthChecks();
        expect(checks).toHaveLength(1);
        expect(checks[0]?.source).toBe('IndexerStatusCheck');
        expect(checks[0]?.service).toBe('radarr');
    });

    it('reports the library scan task, not whichever refresh task ran most recently', async () => {
        const state = await adapter({ '/api/v3/system/task': TASKS }).getScanState();

        expect(state.service).toBe('radarr');
        // RefreshMovie, from 23 hours earlier — not RefreshMonitoredDownloads,
        // which polls the download queue every minute and would make a stale
        // library look permanently fresh.
        expect(state.lastCompleted).toBe('2026-08-04T15:09:00Z');
    });

    it('reports no last-completed scan rather than inventing one when the scan task is absent', async () => {
        const withoutScan = TASKS.filter(t => t.taskName !== 'RefreshMovie');
        const state = await adapter({ '/api/v3/system/task': withoutScan }).getScanState();
        expect(state.lastCompleted).toBeUndefined();
    });

    it('reports no last-completed scan when the task exists but has never run', async () => {
        const state = await adapter({ '/api/v3/system/task': [{ taskName: 'RefreshMovie' }] }).getScanState();
        expect(state.lastCompleted).toBeUndefined();
    });

    it('coerces a non-string health check type', async () => {
        const checks = await adapter({
            '/api/v3/health': [{ source: 'DownloadClientCheck', type: 2, message: 'no client' }]
        }).getFailedHealthChecks();
        expect(checks[0]?.type).toBe('2');
        expect(typeof checks[0]?.type).toBe('string');
    });

    it('advertises disk, health and scan capabilities to the type guards', () => {
        const a = adapter({});
        expect([hasDiskSpace(a), hasHealthChecks(a), hasScanState(a)]).toEqual([true, true, true]);
    });
});
