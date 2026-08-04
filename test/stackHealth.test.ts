import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ArrAdapter, ConnectionDiagnosis, DiskSpace, HealthCheck, ServiceAdapter } from '../src/services/types.ts';
import { buildStackHealth, registerStackHealth } from '../src/tools/stackHealth.ts';

function fakeArr(overrides: Partial<ArrAdapter> & { diagnosis: ConnectionDiagnosis }): ArrAdapter {
    return {
        id: 'radarr',
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
        const exploding: ArrAdapter = {
            id: 'radarr',
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
            path: `/mnt/${i}`,
            label: `d${i}`,
            freeSpace: 1,
            totalSpace: 2
        }));
        const failures: HealthCheck[] = Array.from({ length: 4 }, (_, i) => ({
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

        expect(result.disks).toMatchObject({ total: 7, returned: 3, truncated: true });
        expect(result.failures).toMatchObject({ total: 4, returned: 3, truncated: true });
    });

    it('omits disk detail at minimal but keeps the counts truthful', async () => {
        const disks: DiskSpace[] = [{ path: '/movies', label: 'movies', freeSpace: 1, totalSpace: 2 }];
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

    it('registers without throwing', () => {
        const server = new McpServer({ name: 'test', version: '0.0.0' });
        expect(() => registerStackHealth(server, [])).not.toThrow();
    });
});
