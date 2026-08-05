import { describe, expect, it, vi } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';

const config: KeyedServiceConfig = {
    url: 'http://192.168.1.20:7878',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

/**
 * Fixture shapes are Radarr v3's /api/v3/system/status, /diskspace and /health
 * responses trimmed to the fields we consume. Design spec §21.2 flags the
 * Radarr schema as unconfirmed — Task 10 Step 2 verifies these against a live
 * instance and corrects fixture and type together if a field name differs.
 */
const STATUS = { appName: 'Radarr', version: '5.14.0.9383', instanceName: 'Radarr' };
const DISKSPACE = [{ path: '/movies', label: 'movies', freeSpace: 1_234_567_890, totalSpace: 9_876_543_210 }];
const HEALTH = [{ source: 'IndexerStatusCheck', type: 'warning', message: 'Indexers unavailable due to failures' }];

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const timeoutError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const refusedError = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

describe('RadarrAdapter', () => {
    it('sends the api key as the X-Api-Key header, never in the query string', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            expect(url).not.toContain('test-key');
            expect(new Headers(init?.headers).get('X-Api-Key')).toBe('test-key');
            return jsonResponse(STATUS);
        });

        const adapter = new RadarrAdapter(config, fetchMock as unknown as typeof fetch);
        await adapter.getVersion();
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('returns the version from /api/v3/system/status', async () => {
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(STATUS)) as unknown as typeof fetch);
        expect(await adapter.getVersion()).toBe('5.14.0.9383');
    });

    it('requests the documented status path', async () => {
        const seen: string[] = [];
        const spy = async (input: string | URL | Request) => {
            seen.push(String(input));
            return jsonResponse(STATUS);
        };
        await new RadarrAdapter(config, spy as unknown as typeof fetch).getVersion();
        expect(seen[0]).toBe('http://192.168.1.20:7878/api/v3/system/status');
    });

    it('errors rather than returning undefined when status carries no version', async () => {
        const adapter = new RadarrAdapter(config, (async () => jsonResponse({ appName: 'Radarr' })) as unknown as typeof fetch);
        await expect(adapter.getVersion()).rejects.toThrow(/no version/i);
    });

    it('diagnoses a healthy instance with a latency measurement and version', async () => {
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(STATUS)) as unknown as typeof fetch);
        const d = await adapter.testConnection();

        expect(d.ok).toBe(true);
        expect(d.service).toBe('radarr');
        expect(d.version).toBe('5.14.0.9383');
        expect(d.latency_ms).toBeGreaterThanOrEqual(0);
        expect(d.error).toBeUndefined();
    });

    it('diagnoses a bad api key as AuthFailed with a remedy, not as a thrown error', async () => {
        const adapter = new RadarrAdapter(
            config,
            (async () => jsonResponse({ message: 'Unauthorized' }, 401)) as unknown as typeof fetch
        );
        const d = await adapter.testConnection();

        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('AuthFailed');
        expect(d.error?.remedy).toMatch(/api key/i);
    });

    it('diagnoses connection refused as Unreachable', async () => {
        const adapter = new RadarrAdapter(config, (async () => {
            throw refusedError();
        }) as unknown as typeof fetch);
        const d = await adapter.testConnection();

        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('Unreachable');
    });

    it('diagnoses a non-JSON body as UpstreamError rather than crashing', async () => {
        const adapter = new RadarrAdapter(config, (async () =>
            new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch);
        const d = await adapter.testConnection();

        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('UpstreamError');
    });

    it('returns only failing health checks, filtering out ok entries', async () => {
        const body = [...HEALTH, { source: 'X', type: 'ok', message: 'fine' }];
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(body)) as unknown as typeof fetch);
        const checks = await adapter.getFailedHealthChecks();

        expect(checks).toHaveLength(1);
        expect(checks[0]?.source).toBe('IndexerStatusCheck');
    });

    it('returns disk space entries', async () => {
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(DISKSPACE)) as unknown as typeof fetch);
        const disks = await adapter.getDiskSpace();

        expect(disks).toHaveLength(1);
        expect(disks[0]?.freeSpace).toBe(1_234_567_890);
    });

    it('retries a read once on timeout, then succeeds', async () => {
        let calls = 0;
        const flaky = async () => {
            calls += 1;
            if (calls === 1) throw timeoutError();
            return jsonResponse(STATUS);
        };
        const adapter = new RadarrAdapter(config, flaky as unknown as typeof fetch);

        expect(await adapter.getVersion()).toBe('5.14.0.9383');
        expect(calls).toBe(2);
    });

    it('gives up after exactly one retry — reads do not retry forever', async () => {
        let calls = 0;
        const alwaysTimeout = async () => {
            calls += 1;
            throw timeoutError();
        };
        const adapter = new RadarrAdapter(config, alwaysTimeout as unknown as typeof fetch);

        await expect(adapter.getVersion()).rejects.toThrow(/timed out/);
        expect(calls).toBe(2);
    });

    it('does not retry a 401 — an auth failure is not transient', async () => {
        let calls = 0;
        const unauthorized = async () => {
            calls += 1;
            return jsonResponse({}, 401);
        };
        const adapter = new RadarrAdapter(config, unauthorized as unknown as typeof fetch);

        await expect(adapter.getVersion()).rejects.toThrow(/auth failed/);
        expect(calls).toBe(1);
    });

    it('does not retry connection refused — only timeouts are retried', async () => {
        let calls = 0;
        const refuse = async () => {
            calls += 1;
            throw refusedError();
        };
        const adapter = new RadarrAdapter(config, refuse as unknown as typeof fetch);

        await expect(adapter.getVersion()).rejects.toThrow(/unreachable/);
        expect(calls).toBe(1);
    });

    it('opens the circuit after 5 consecutive failures and stops calling out', async () => {
        let calls = 0;
        const refuse = async () => {
            calls += 1;
            throw refusedError();
        };
        const adapter = new RadarrAdapter(config, refuse as unknown as typeof fetch);

        for (let i = 0; i < 5; i += 1) {
            await adapter.testConnection();
        }
        const callsAfterFive = calls;

        const d = await adapter.testConnection();
        expect(d.ok).toBe(false);
        expect(d.error?.detail).toMatch(/circuit/i);
        expect(calls).toBe(callsAfterFive); // no further network attempts
    });

    it('half-opens after the cooldown and lets a single trial request through', async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            let failing = true;
            const flaky = async () => {
                calls += 1;
                if (failing) throw refusedError();
                return jsonResponse(STATUS);
            };
            const adapter = new RadarrAdapter(config, flaky as unknown as typeof fetch);

            for (let i = 0; i < 5; i += 1) await adapter.testConnection();
            const callsWhenOpen = calls;

            // Still open immediately after tripping.
            await adapter.testConnection();
            expect(calls).toBe(callsWhenOpen);

            // After the 60s cooldown the service is healthy again.
            failing = false;
            vi.advanceTimersByTime(60_001);
            const d = await adapter.testConnection();

            expect(calls).toBe(callsWhenOpen + 1);
            expect(d.ok).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resets the failure count after a success, so intermittent errors never trip the circuit', async () => {
        let failNext = true;
        const alternating = async () => {
            failNext = !failNext;
            if (!failNext) throw refusedError();
            return jsonResponse(STATUS);
        };
        const adapter = new RadarrAdapter(config, alternating as unknown as typeof fetch);

        for (let i = 0; i < 12; i += 1) await adapter.testConnection();

        // A circuit that counted cumulatively rather than consecutively would
        // be open by now; this must still be attempting real requests.
        const d = await adapter.testConnection();
        expect(d.error?.detail ?? '').not.toMatch(/circuit/i);
    });
});
