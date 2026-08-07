import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type {
    ConnectionDiagnosis,
    DiskSpace,
    DiskSpaceCapable,
    HealthCheck,
    HealthCheckCapable,
    ScanState,
    ServiceAdapter
} from '../src/services/types.ts';
import { buildStackHealth, registerStackHealth } from '../src/tools/stackHealth.ts';

/** What `ArrAdapter` used to name, now spelled as the capabilities it is. */
type ArrLike = ServiceAdapter & DiskSpaceCapable & HealthCheckCapable;

function fakeArr(overrides: Partial<ArrLike> & { diagnosis: ConnectionDiagnosis }): ArrLike {
    return {
        id: 'radarr',
        type: 'radarr',
        testConnection: async () => overrides.diagnosis,
        getVersion: async () => overrides.diagnosis.version ?? '0',
        getDiskSpace: overrides.getDiskSpace ?? (async () => []),
        getFailedHealthChecks: overrides.getFailedHealthChecks ?? (async () => [])
    };
}

const healthy: ConnectionDiagnosis = { ok: true, service: 'radarr', latency_ms: 6, version: '5.14.0.9383' };
const broken: ConnectionDiagnosis = {
    ok: false,
    service: 'radarr',
    latency_ms: 3,
    error: { kind: 'Unreachable', detail: 'connection refused at 192.168.1.20:7878' }
};

const std = { detail: 'standard', limit: 50 } as const;

describe('stack_health', () => {
    it('reports a healthy service with its version and latency', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], std);

        expect(result.services).toHaveLength(1);
        expect(result.services[0]).toMatchObject({ service: 'radarr', ok: true, version: '5.14.0.9383' });
        expect(result.degraded).toEqual([]);
    });

    it('degrades rather than failing when a service is down', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: broken })], std);

        expect(result.degraded).toEqual(['radarr']);
        expect(result.services[0]?.ok).toBe(false);
        expect(result.services[0]?.error?.kind).toBe('Unreachable');
    });

    it('still returns what it gathered when one adapter throws outright', async () => {
        const exploding: ArrLike = {
            id: 'radarr',
            type: 'radarr',
            testConnection: async () => {
                throw new Error('unexpected');
            },
            getVersion: async () => '0',
            getDiskSpace: async () => [],
            getFailedHealthChecks: async () => []
        };
        const result = await buildStackHealth([exploding], std);

        expect(result.degraded).toEqual(['radarr']);
        expect(result.services[0]?.ok).toBe(false);
    });

    it('does not call disk or health endpoints on a service that is down', async () => {
        let diskCalls = 0;
        const adapter = fakeArr({
            diagnosis: broken,
            getDiskSpace: async () => {
                diskCalls += 1;
                return [];
            }
        });
        await buildStackHealth([adapter], std);

        expect(diskCalls).toBe(0);
    });

    it('marks a service degraded when its disk read fails even though the probe passed', async () => {
        const adapter = fakeArr({
            diagnosis: healthy,
            getDiskSpace: async () => {
                throw new Error('boom');
            }
        });
        const result = await buildStackHealth([adapter], std);

        expect(result.degraded).toEqual(['radarr']);
        expect(result.services[0]?.ok).toBe(true); // the probe itself was fine
    });

    it('does not list a service twice when both follow-up reads fail', async () => {
        const adapter = fakeArr({
            diagnosis: healthy,
            getDiskSpace: async () => {
                throw new Error('boom');
            },
            getFailedHealthChecks: async () => {
                throw new Error('boom');
            }
        });
        const result = await buildStackHealth([adapter], std);

        expect(result.degraded).toEqual(['radarr']);
    });

    it('honours the truncation contract on disks and failures', async () => {
        const disks: DiskSpace[] = Array.from({ length: 7 }, (_, i) => ({
            service: 'radarr',
            path: `/mnt/${i}`,
            label: `d${i}`,
            freeSpace: 1,
            totalSpace: 2
        }));
        const failures: HealthCheck[] = Array.from({ length: 4 }, (_, i) => ({
            service: 'radarr',
            source: `S${i}`,
            type: 'warning',
            message: 'm'
        }));

        const result = await buildStackHealth(
            [
                fakeArr({
                    diagnosis: healthy,
                    getDiskSpace: async () => disks,
                    getFailedHealthChecks: async () => failures
                })
            ],
            { detail: 'standard', limit: 3 }
        );

        // One budget across both lists, spent on failures first. Applying the
        // limit to each independently would have returned 6 rows for limit: 3.
        expect(result.failures).toMatchObject({ total: 4, returned: 3, truncated: true });
        expect(result.disks).toMatchObject({ total: 7, returned: 0, truncated: true });
        expect(result.failures.returned + result.disks.returned).toBeLessThanOrEqual(3);
    });

    it('still reports the true disk total when the budget left no room for rows', async () => {
        const result = await buildStackHealth(
            [
                fakeArr({
                    diagnosis: healthy,
                    getDiskSpace: async () => [
                        { service: 'radarr', path: '/movies', label: 'movies', freeSpace: 1, totalSpace: 2 }
                    ],
                    getFailedHealthChecks: async () =>
                        Array.from({ length: 5 }, (_, i) => ({
                            service: 'radarr' as const,
                            source: `S${i}`,
                            type: 'warning',
                            message: 'm'
                        }))
                })
            ],
            { detail: 'standard', limit: 2 }
        );

        // A starved list must not read as "there are no disks".
        expect(result.disks.items).toEqual([]);
        expect(result.disks.total).toBe(1);
        expect(result.disks.truncated).toBe(true);
    });

    it('omits disk detail at minimal but keeps the counts truthful', async () => {
        const disks: DiskSpace[] = [
            { service: 'radarr', path: '/movies', label: 'movies', freeSpace: 1, totalSpace: 2 }
        ];
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy, getDiskSpace: async () => disks })], {
            detail: 'minimal',
            limit: 50
        });

        expect(result.disks.items).toEqual([]);
        expect(result.disks.total).toBe(1);
    });

    it('returns a stable service order regardless of which adapter resolves first', async () => {
        const slowSonarr: ServiceAdapter = {
            id: 'sonarr',
            type: 'sonarr',
            getVersion: async () => '4',
            testConnection: async () => {
                await new Promise(r => setTimeout(r, 10));
                return { ok: true, service: 'sonarr', latency_ms: 10 };
            }
        };
        const result = await buildStackHealth([slowSonarr, fakeArr({ diagnosis: healthy })], std);

        expect(result.services.map(s => s.service)).toEqual(['radarr', 'sonarr']);
    });

    it('returns an empty but well-formed result when nothing is configured', async () => {
        const result = await buildStackHealth([], std);

        expect(result.services).toEqual([]);
        expect(result.degraded).toEqual([]);
        expect(result.disks).toEqual({ items: [], total: 0, returned: 0, truncated: false });
    });

    it('includes a capability-less service in the diagnosis list without degrading it', async () => {
        const bare: ServiceAdapter = {
            id: 'sabnzbd',
            type: 'sabnzbd',
            getVersion: async () => '4.5.0',
            testConnection: async () => ({ ok: true, service: 'sabnzbd', latency_ms: 1, version: '4.5.0' })
        };
        const result = await buildStackHealth([bare], std);

        expect(result.services.map(s => s.service)).toContain('sabnzbd');
        expect(result.degraded).toEqual([]);
        expect(result.disks.total).toBe(0);
    });

    it('collects scan state from services that report it', async () => {
        const scanner: ServiceAdapter & { getScanState: () => Promise<ScanState> } = {
            id: 'jellyfin',
            type: 'jellyfin',
            getVersion: async () => '10.11.11',
            testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 }),
            getScanState: async () => ({
                service: 'jellyfin',
                lastCompleted: '2026-08-05T09:07:11Z',
                running: false
            })
        };
        const result = await buildStackHealth([scanner], std);

        expect(result.scans).toEqual([{ service: 'jellyfin', lastCompleted: '2026-08-05T09:07:11Z', running: false }]);
    });

    it('degrades rather than failing when a scan-state read throws', async () => {
        const broken: ServiceAdapter & { getScanState: () => Promise<ScanState> } = {
            id: 'jellyfin',
            type: 'jellyfin',
            getVersion: async () => '10.11.11',
            testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 }),
            getScanState: async () => {
                throw new Error('boom');
            }
        };
        const result = await buildStackHealth([broken], std);

        expect(result.degraded).toEqual(['jellyfin']);
        expect(result.scans).toEqual([]);
        expect(result.services).toHaveLength(1);
    });

    it('reports an empty scans list rather than omitting the field', async () => {
        expect((await buildStackHealth([], std)).scans).toEqual([]);
    });

    it('keeps counts honest at detail: minimal even though items are dropped', async () => {
        const disks: DiskSpace[] = [
            { service: 'radarr', path: '/movies', label: 'movies', freeSpace: 1, totalSpace: 2 }
        ];
        const failures: HealthCheck[] = [{ service: 'radarr', source: 'S', type: 'warning', message: 'm' }];
        const result = await buildStackHealth(
            [
                fakeArr({
                    diagnosis: healthy,
                    getDiskSpace: async () => disks,
                    getFailedHealthChecks: async () => failures
                })
            ],
            { detail: 'minimal', limit: 50 }
        );

        // Both lists drop their payloads at minimal — Phase 1 dropped only disks.
        expect(result.disks.items).toEqual([]);
        expect(result.failures.items).toEqual([]);
        expect(result.disks.total).toBe(1);
        expect(result.failures.total).toBe(1);
    });

    it('returns disk paths only at detail: full', async () => {
        const disks: DiskSpace[] = [
            { service: 'radarr', path: '/movies', label: 'movies', freeSpace: 1, totalSpace: 2 }
        ];
        const build = (detail: 'standard' | 'full') =>
            buildStackHealth([fakeArr({ diagnosis: healthy, getDiskSpace: async () => disks })], {
                detail,
                limit: 50
            });

        expect((await build('full')).disks.items[0]?.path).toBe('/movies');
        expect((await build('standard')).disks.items[0]?.path).toBeUndefined();
        // The row survives; only the path is gone.
        expect((await build('standard')).disks.items[0]?.freeSpace).toBe(1);
    });

    it('drops the remedy at minimal but keeps the error kind', async () => {
        const withRemedy: ConnectionDiagnosis = {
            ok: false,
            service: 'radarr',
            latency_ms: 3,
            error: { kind: 'Unreachable', detail: 'connection refused', remedy: 'Check the service is running.' }
        };
        const result = await buildStackHealth([fakeArr({ diagnosis: withRemedy })], { detail: 'minimal', limit: 50 });

        expect(result.services[0]?.error?.kind).toBe('Unreachable');
        expect(result.services[0]?.error?.remedy).toBeUndefined();
        expect(result.degraded).toEqual(['radarr']);
    });

    it('registers without throwing', () => {
        const server = new McpServer({ name: 'test', version: '0.0.0' });
        expect(() => registerStackHealth(server, [])).not.toThrow();
    });
});
