import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type {
    ConnectionDiagnosis,
    DiskSpace,
    DiskSpaceCapable,
    HealthCheck,
    HealthCheckCapable,
    LogCapable,
    RecentLogs,
    ScanState,
    ServiceAdapter
} from '../src/services/types.ts';
import type { ServiceInstance } from '../src/config/instances.ts';
import { buildStackHealth, registerStackHealth } from '../src/tools/stackHealth.ts';
import { buildInstanceOptions, registerGetInstanceOptions } from '../src/tools/instanceOptions.ts';
import { afterTicks } from './helpers/ticks.ts';

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
const full = { detail: 'full', limit: 50 } as const;

describe('get_stack_health primary media server', () => {
    it('names the primary media server at every detail level', async () => {
        for (const detail of ['minimal', 'standard', 'full'] as const) {
            const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail, limit: 50 }, undefined, 'plex');
            expect(result.primaryMediaServer).toBe('plex');
        }
    });

    it('leaves the key out without one', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], std);
        expect('primaryMediaServer' in result).toBe(false);
    });

    const textOf = async (primary?: string, adapters = [fakeArr({ diagnosis: healthy })], args: Record<string, unknown> = std) => {
        const server = new McpServer({ name: 'test', version: '0.0.0' });
        registerStackHealth(server, adapters, undefined, primary);
        const tool = (server as unknown as {
            _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: object) => Promise<{ content: { text: string }[] }> }>;
        })._registeredTools.get_stack_health!;
        return (await tool.handler(args, {})).content[0]!.text;
    };
    const summaryOf = async (primary?: string, adapters = [fakeArr({ diagnosis: healthy })]) =>
        (await textOf(primary, adapters)).split('\n')[0];

    const GIB = 1024 ** 3;
    const check = (n: number) => ({ service: 'radarr', source: 'IndexerCheck', type: 'warning', message: `problem ${n}` });
    const disk = (path: string, free: number) => ({ service: 'radarr', label: '', path, freeSpace: free * GIB, totalSpace: 10 * GIB });

    describe('the text (#234)', () => {
        it('lists each service, failing check and disk, not only in structuredContent', async () => {
            const text = await textOf(undefined, [
                fakeArr({
                    diagnosis: healthy,
                    getFailedHealthChecks: async () => [{ service: 'radarr', source: 'IndexerCheck', type: 'warning', message: 'No indexers available' }],
                    getDiskSpace: async () => [{ service: 'radarr', label: '/data', freeSpace: 2 * GIB, totalSpace: 10 * GIB }]
                })
            ]);
            expect(text.split('\n')).toEqual([
                'All 1 configured service(s) reachable. 1 failing health check(s).',
                'radarr: ok, 5.14.0.9383, 6 ms',
                'radarr health check IndexerCheck (warning): No indexers available',
                'disk (radarr /data): 2.0 GiB free of 10.0 GiB'
            ]);
        });

        it('gives a failure its remedy, and a diagnosis made without a request no latency', async () => {
            expect((await textOf(undefined, [fakeArr({ diagnosis: broken })])).split('\n')[1]).toBe(
                'radarr (Unreachable): connection refused at 192.168.1.20:7878'
            );
            const remedied = { ...broken, error: { ...broken.error!, remedy: 'Check the port.' } };
            expect((await textOf(undefined, [fakeArr({ diagnosis: remedied })])).split('\n')[1]).toBe(
                'radarr (Unreachable): connection refused at 192.168.1.20:7878. Check the port.'
            );
            expect((await textOf(undefined, [fakeArr({ diagnosis: { ...healthy, latency_ms: 0 } })])).split('\n')[1]).toBe('radarr: ok, 5.14.0.9383');
        });

        it('folds the mounts of one filesystem into one line, naming each by its path at full', async () => {
            const mounts = [disk('/', 2), disk('/config', 2), disk('/downloads', 2), disk('/media', 7)];
            const full = await textOf(undefined, [fakeArr({ diagnosis: healthy, getDiskSpace: async () => mounts })], { detail: 'full', limit: 50 });
            expect(full.split('\n').filter(l => l.startsWith('disk'))).toEqual([
                'disk (radarr /, radarr /config, radarr /downloads): 2.0 GiB free of 10.0 GiB',
                'disk (radarr /media): 7.0 GiB free of 10.0 GiB'
            ]);
            const standard = await textOf(undefined, [fakeArr({ diagnosis: healthy, getDiskSpace: async () => mounts })]);
            expect(standard.split('\n').filter(l => l.startsWith('disk'))).toEqual([
                'disk (radarr): 2.0 GiB free of 10.0 GiB',
                'disk (radarr): 7.0 GiB free of 10.0 GiB'
            ]);
        });

        it('says how many checks and disks a short limit left out', async () => {
            const adapters = [
                fakeArr({ diagnosis: healthy, getFailedHealthChecks: async () => [check(1), check(2), check(3)], getDiskSpace: async () => [disk('/a', 1), disk('/b', 2), disk('/c', 3), disk('/d', 4)] })
            ];
            const text = await textOf(undefined, adapters, { detail: 'standard', limit: 5 });
            expect(text.split('\n')[0]).toBe('All 1 configured service(s) reachable. 3 failing health check(s), 2 of 4 disk(s) shown.');
            expect(text.split('\n').filter(l => l.startsWith('disk'))).toHaveLength(2);
        });

        it('says so when the checks spend the whole limit and no disk is left', async () => {
            const adapters = [fakeArr({ diagnosis: healthy, getFailedHealthChecks: async () => [check(1), check(2)], getDiskSpace: async () => [disk('/a', 1)] })];
            const text = await textOf(undefined, adapters, { detail: 'standard', limit: 2 });
            expect(text.split('\n')[0]).toBe('All 1 configured service(s) reachable. 2 failing health check(s), 0 of 1 disk(s) shown.');
            expect(text).not.toMatch(/^disk/m);
        });

        it('at minimal, says the checks and disks are there rather than reading as none', async () => {
            const adapters = [fakeArr({ diagnosis: healthy, getFailedHealthChecks: async () => [check(1), check(2), check(3)], getDiskSpace: async () => [disk('/a', 1)] })];
            const text = await textOf(undefined, adapters, { detail: 'minimal', limit: 50 });
            expect(text.split('\n')).toEqual([
                'All 1 configured service(s) reachable. 0 of 3 failing health check(s) shown, 0 of 1 disk(s) shown.',
                'radarr: ok, 6 ms'
            ]);
        });
    });

    it('names the primary in the summary', async () => {
        expect(await summaryOf('plex')).toBe('All 1 configured service(s) healthy. plex is the primary media server.');
        expect(await summaryOf('jellyfin', [fakeArr({ diagnosis: broken })])).toMatch(/degraded: radarr\. jellyfin is the primary media server\.$/);
    });

    it('leaves the summary alone with one media server', async () => {
        expect(await summaryOf()).toBe('All 1 configured service(s) healthy.');
    });

    const outputKeys = (primary?: string) => {
        const server = new McpServer({ name: 'test', version: '0.0.0' });
        registerStackHealth(server, [], undefined, primary);
        const tool = (server as unknown as { _registeredTools: Record<string, { outputSchema: { shape: Record<string, unknown> } }> })
            ._registeredTools.get_stack_health!;
        return Object.keys(tool.outputSchema.shape);
    };

    it('declares primaryMediaServer in the output schema only with two media servers', () => {
        expect(outputKeys('plex')).toContain('primaryMediaServer');
        expect(outputKeys()).toEqual([
            'services',
            'failures',
            'disks',
            'scans',
            'commands',
            'permissions',
            'endpoints',
            'seedingRules',
            'cleanup',
            'cleanuparrRemovals',
            'logs',
            'degraded'
        ]);
    });
});

describe('get_stack_health logs', () => {
    const line = { service: 'radarr', level: 'error', logger: 'Transmission', message: 'm', count: 3, firstSeen: '2026-11-01T00:00:00Z', lastSeen: '2026-11-02T00:00:00Z' };
    const withLogs = (getRecentLogs: () => Promise<RecentLogs>) => ({ ...fakeArr({ diagnosis: healthy }), getRecentLogs });

    it('reads logs only at full', async () => {
        let calls = 0;
        const adapter = withLogs(async () => (calls++, { entries: [line], read: 50, total: 125 }));
        expect('logs' in (await buildStackHealth([adapter], std))).toBe(false);
        expect(calls).toBe(0);
        const full = await buildStackHealth([adapter], { detail: 'full', limit: 50 });
        expect(full.logs?.items).toEqual([line]);
        expect(full.logs?.lines).toEqual([{ service: 'radarr', read: 50, total: 125 }]);
    });

    it('marks a service degraded when its log cannot be read', async () => {
        const full = await buildStackHealth([withLogs(async () => Promise.reject(new Error('boom')))], { detail: 'full', limit: 50 });
        expect(full.logs?.total).toBe(0);
        expect(full.logs?.lines).toEqual([]);
        expect(full.degraded).toEqual(['radarr']);
    });

    it('flags a log whose database is off, without marking the service degraded', async () => {
        const adapter = withLogs(async () => ({ entries: [], read: 0, total: 0, logDbEnabled: false }));
        const full = await buildStackHealth([adapter], { detail: 'full', limit: 50 });
        expect(full.logs?.lines).toEqual([{ service: 'radarr', read: 0, total: 0, logDbEnabled: false }]);
        expect(full.degraded).toEqual([]);
    });

    it('sorts by the moment, whichever way a service writes its times', async () => {
        const seen = (lastSeen: string) => ({ ...line, lastSeen });
        const adapter = withLogs(async () => ({
            entries: [seen('2026-11-05T10:00:00Z'), seen('2026-11-05T10:00:00.500Z'), seen('2026-11-05T09:59:59.999+00:00')],
            read: 3,
            total: 3
        }));
        const full = await buildStackHealth([adapter], { detail: 'full', limit: 50 });
        expect(full.logs?.items.map(l => l.lastSeen)).toEqual(['2026-11-05T10:00:00.500Z', '2026-11-05T10:00:00Z', '2026-11-05T09:59:59.999+00:00']);
    });

    describe('one limit shared between the instances', () => {
        /** An instance whose log folds to `n` rows a second apart, the newest at `newest`. */
        const at = (id: string, n: number, newest: string): ServiceAdapter & LogCapable => {
            const entries = Array.from({ length: n }, (_, i) => ({
                ...line,
                service: id,
                message: `${id} ${i}`,
                lastSeen: new Date(Date.parse(newest) - i * 1000).toISOString()
            }));
            return {
                ...fakeArr({ diagnosis: { ...healthy, service: id } }),
                id,
                type: id.split('/')[0] as ServiceAdapter['type'],
                getRecentLogs: async () => ({ entries, read: n, total: n })
            };
        };
        const perInstance = (items: readonly { service: string }[] = []) =>
            items.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.service]: (acc[row.service] ?? 0) + 1 }), {});

        it('keeps the only row of a quiet instance that a busy one of the same type would have cut', async () => {
            const result = await buildStackHealth([at('sonarr/busy', 60, '2026-11-05T10:00:00Z'), at('sonarr/quiet', 1, '2026-11-01T00:00:00Z')], full);
            expect(perInstance(result.logs?.items)).toEqual({ 'sonarr/busy': 49, 'sonarr/quiet': 1 });
            expect(result.logs).toMatchObject({ total: 61, returned: 50, offset: 0, truncated: true });
        });

        it('passes the share an instance does not use on to the others', async () => {
            const result = await buildStackHealth([at('radarr', 40, '2026-11-05T10:00:00Z'), at('sonarr', 5, '2026-11-05T09:00:00Z')], { detail: 'full', limit: 30 });
            expect(perInstance(result.logs?.items)).toEqual({ radarr: 25, sonarr: 5 });
            expect(result.logs).toMatchObject({ total: 45, returned: 30, truncated: true });
        });

        it('hands the rows a share leaves over to the newest, whatever order the instances answer in', async () => {
            // A limit of 10 between three instances: 3 each, and one more. Radarr's
            // and Sonarr's rows are a second apart at the same moments, so the spare
            // row is a tie, which goes by instance id.
            const three = () => [at('radarr', 5, '2026-11-05T10:00:00Z'), at('sonarr', 5, '2026-11-05T10:00:00Z'), at('lidarr', 5, '2026-11-05T09:00:00Z')];
            const forward = await buildStackHealth(three(), { detail: 'full', limit: 10 });
            const backward = await buildStackHealth(three().reverse(), { detail: 'full', limit: 10 });
            expect(perInstance(forward.logs?.items)).toEqual({ radarr: 4, sonarr: 3, lidarr: 3 });
            expect(backward.logs?.items).toEqual(forward.logs?.items);
            const times = (forward.logs?.items ?? []).map(row => Date.parse(row.lastSeen));
            expect(times).toEqual([...times].sort((a, b) => b - a));
        });

        it('splits evenly when every instance has its share', async () => {
            const result = await buildStackHealth([at('radarr', 50, '2026-11-05T10:00:00Z'), at('sonarr', 50, '2026-11-05T09:00:00Z')], full);
            expect(perInstance(result.logs?.items)).toEqual({ radarr: 25, sonarr: 25 });
        });

        it('keeps one row of each when the limit equals the number of instances', async () => {
            const result = await buildStackHealth(
                [at('radarr', 3, '2026-11-05T10:00:00Z'), at('sonarr', 3, '2026-11-05T09:00:00Z'), at('lidarr', 3, '2026-11-05T08:00:00Z')],
                { detail: 'full', limit: 3 }
            );
            expect(result.logs?.items.map(row => row.message)).toEqual(['radarr 0', 'sonarr 0', 'lidarr 0']);
        });

        it('keeps every row, untruncated, when the limit is above them all', async () => {
            const result = await buildStackHealth([at('radarr', 3, '2026-11-05T10:00:00Z'), at('sonarr', 3, '2026-11-05T09:00:00Z')], full);
            expect(result.logs).toMatchObject({ total: 6, returned: 6, offset: 0, truncated: false });
        });

        it('keeps the newest rows overall when the limit is below the number of instances', async () => {
            const result = await buildStackHealth(
                [at('radarr', 3, '2026-11-05T10:00:00Z'), at('sonarr', 3, '2026-11-05T09:00:00Z'), at('lidarr', 3, '2026-11-05T08:00:00Z')],
                { detail: 'full', limit: 2 }
            );
            expect(result.logs?.items.map(row => row.message)).toEqual(['radarr 0', 'radarr 1']);
            expect(result.logs).toMatchObject({ total: 9, returned: 2, truncated: true });
        });

        it('orders rows from the same moment by instance id, not by which instance answered first', async () => {
            const result = await buildStackHealth([at('sonarr/b', 1, '2026-11-05T10:00:00Z'), at('sonarr/a', 1, '2026-11-05T10:00:00Z')], full);
            expect(result.logs?.items.map(row => row.service)).toEqual(['sonarr/a', 'sonarr/b']);
        });
    });
});

describe('get_stack_health', () => {
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
            freeSpace: i + 1,
            totalSpace: 10
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
        expect(result.disks).toEqual({ items: [], total: 0, returned: 0, offset: 0, truncated: false });
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
            { service: 'radarr', path: '/movies', label: '', freeSpace: 1, totalSpace: 2 }
        ];
        const build = (detail: 'standard' | 'full') =>
            buildStackHealth([fakeArr({ diagnosis: healthy, getDiskSpace: async () => disks })], {
                detail,
                limit: 50
            });

        expect((await build('full')).disks.items[0]?.mounts).toEqual(['radarr /movies']);
        expect((await build('standard')).disks.items[0]?.mounts).toEqual(['radarr']);
        // The row survives; only the path is gone.
        expect((await build('standard')).disks.items[0]?.freeSpace).toBe(1);
    });

    // Four *arrs on one host report the same filesystems; the text already
    // folded them, and the structured half sent each mount once per service.
    it('folds one filesystem seen by several services into one row, and counts rows against limit', async () => {
        const seen = (service: string): DiskSpace[] => [
            { service, label: '/data', freeSpace: 5, totalSpace: 10 },
            { service, label: '/config', freeSpace: 2, totalSpace: 4 }
        ];
        const arr = (id: string) => ({ ...fakeArr({ diagnosis: { ...healthy, service: id }, getDiskSpace: async () => seen(id) }), id, type: id }) as ArrLike;
        const result = await buildStackHealth([arr('radarr'), arr('sonarr'), arr('lidarr')], { detail: 'standard', limit: 2 });

        expect(result.disks).toMatchObject({ total: 2, returned: 2, truncated: false });
        expect(result.disks.items).toEqual([
            { freeSpace: 2, totalSpace: 4, services: ['lidarr', 'radarr', 'sonarr'], mounts: ['lidarr /config', 'radarr /config', 'sonarr /config'] },
            { freeSpace: 5, totalSpace: 10, services: ['lidarr', 'radarr', 'sonarr'], mounts: ['lidarr /data', 'radarr /data', 'sonarr /data'] }
        ]);
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

describe('get_stack_health failures order', () => {
    const check = (service: string, source: string, type: string): HealthCheck => ({ service, source, type, message: `${source} failed` });
    const named = (items: readonly HealthCheck[]) => items.map(f => `${f.service} ${f.source}`);

    /** An instance whose checks arrive after `ticks` microtasks, so a test sets which instance answers first. */
    const answering = (id: string, ticks: number, checks: HealthCheck[]): ArrLike => ({
        ...fakeArr({
            diagnosis: { ...healthy, service: id },
            getFailedHealthChecks: async () => {
                await afterTicks(ticks);
                return checks;
            }
        }),
        id,
        type: id as ServiceAdapter['type']
    });

    /** The same Radarr and Sonarr twice, each listed first and answering first once, so neither order can decide. */
    const bothWays = async (radarr: HealthCheck[], sonarr: HealthCheck[], limit: number) => {
        const radarrFirst = await buildStackHealth([answering('radarr', 0, radarr), answering('sonarr', 20, sonarr)], { detail: 'standard', limit });
        const sonarrFirst = await buildStackHealth([answering('sonarr', 0, sonarr), answering('radarr', 20, radarr)], { detail: 'standard', limit });
        return [radarrFirst, sonarrFirst];
    };

    it('lists errors, then warnings, notices and any other type, each by instance id, whichever instance answers first', async () => {
        const results = await bothWays(
            // A3 before A4 in Radarr's own list: the unknown type goes after the notice by rank, not by order.
            [check('radarr', 'A1', 'warning'), check('radarr', 'A2', 'error'), check('radarr', 'A3', 'unknown'), check('radarr', 'A4', 'notice')],
            // B3 before B2: Sonarr's own order, which the sort keeps within a type.
            [check('sonarr', 'B1', 'error'), check('sonarr', 'B3', 'warning'), check('sonarr', 'B2', 'warning')],
            50
        );
        for (const result of results) {
            expect(named(result.failures.items)).toEqual(['radarr A2', 'sonarr B1', 'radarr A1', 'sonarr B3', 'sonarr B2', 'radarr A4', 'radarr A3']);
        }
    });

    it('keeps the same check when limit: 1 cuts, whichever instance answers first', async () => {
        const results = await bothWays(
            [check('radarr', 'A1', 'warning'), check('radarr', 'A2', 'warning')],
            [check('sonarr', 'B1', 'warning'), check('sonarr', 'B2', 'warning')],
            1
        );
        for (const result of results) {
            expect(named(result.failures.items)).toEqual(['radarr A1']);
            expect(result.failures).toMatchObject({ total: 4, returned: 1, truncated: true });
        }
    });

    it('keeps an error over the warnings of an instance that sorts before it', async () => {
        const results = await bothWays([check('radarr', 'A1', 'warning'), check('radarr', 'A2', 'warning')], [check('sonarr', 'B1', 'error')], 1);
        for (const result of results) expect(named(result.failures.items)).toEqual(['sonarr B1']);
    });
});

describe('get_stack_health service and instance filter', () => {
    const sonarr = { ...fakeArr({ diagnosis: { ...healthy, service: 'sonarr' } }), id: 'sonarr', type: 'sonarr' } as ArrLike;
    const radarr4k = { ...fakeArr({ diagnosis: healthy }), id: 'radarr/4k', instance: '4k' } as ArrLike;
    const instance = (id: string, type: 'radarr' | 'sonarr') =>
        ({ id, type, config: { url: `http://${id}:1`, permissions: { safe_write: false, destructive: false } } }) as unknown as ServiceInstance;

    it('reports only the service asked for', async () => {
        const result = await buildStackHealth(
            [fakeArr({ diagnosis: healthy }), sonarr],
            { ...full, service: 'sonarr' },
            [instance('radarr', 'radarr'), instance('sonarr', 'sonarr')]
        );
        expect(result.services.map(s => s.service)).toEqual(['sonarr']);
        expect(result.permissions?.map(p => p.instance)).toEqual(['sonarr']);
        expect(result.endpoints?.map(e => e.instance)).toEqual(['sonarr']);
    });

    it('reports only the instance asked for', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy }), sonarr], { ...std, instance: 'radarr' });
        expect(result.services.map(s => s.service)).toEqual(['radarr']);
    });

    it('takes the bare instance name as well as the full id', async () => {
        const all = [fakeArr({ diagnosis: healthy }), radarr4k];
        const rows = [instance('radarr', 'radarr'), instance('radarr/4k', 'radarr')];
        const byName = await buildStackHealth(all, { ...full, service: 'radarr', instance: '4k' }, rows);
        const byId = await buildStackHealth(all, { ...full, instance: 'radarr/4k' }, rows);
        expect(byName.permissions?.map(p => p.instance)).toEqual(['radarr/4k']);
        expect(byId.permissions?.map(p => p.instance)).toEqual(['radarr/4k']);
    });

    it('refuses an instance that does not exist', async () => {
        await expect(buildStackHealth([fakeArr({ diagnosis: healthy })], { ...std, instance: 'nope' })).rejects.toThrow(/no instance "nope"/);
    });

    it('refuses a service and instance that disagree, saying which the instance is', async () => {
        const refused = buildStackHealth([fakeArr({ diagnosis: healthy }), sonarr], { ...std, service: 'sonarr', instance: 'radarr' });
        await expect(refused).rejects.toThrow(/no instance "radarr" under sonarr/);
        await expect(refused).rejects.toThrow(/Drop service or change it/);
    });

    it('leaves seedingRules out under a filter, so it cannot report gaps that need the whole stack', async () => {
        const client = { ...fakeArr({ diagnosis: healthy }), id: 'qbittorrent', type: 'qbittorrent', getSeedLimits: async () => ({ service: 'qbittorrent', action: 'stop' }) } as unknown as ArrLike;
        expect((await buildStackHealth([client], full)).seedingRules).toBeDefined();
        expect((await buildStackHealth([client, sonarr], { ...full, service: 'sonarr' })).seedingRules).toBeUndefined();
    });
});

/**
 * `arr://instances` needs to say what each instance is allowed to do, and a
 * resource must mirror a tool rather than originate — a client that ignores
 * resources must not be the only one unable to answer "what may I do here".
 * So get_stack_health reports it.
 *
 * The permission *source* is untouched: `permissionSourceFrom` still reads
 * config, deliberately, so an adapter cannot widen its own grants. This
 * reports the gate's answer; it does not become a second one.
 */
describe('get_stack_health permissions', () => {
    const instance = (id: string, safe_write: boolean, destructive: boolean) =>
        ({
            id,
            type: id.split('/')[0],
            // `url` is not what these cases are about, but every real
            // `ServiceInstance` carries one (the config schema requires it)
            // and `endpoints` now reads it — a stand-in that omits it is
            // testing a shape production cannot produce.
            config: { url: 'http://192.0.2.10:7878', permissions: { safe_write, destructive } }
        }) as unknown as ServiceInstance;

    it('reports what each instance is allowed to do', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], full, [
            instance('radarr/4k', true, false),
            instance('sonarr', false, false)
        ]);

        expect(result.permissions).toEqual([
            { instance: 'radarr/4k', safe_write: true, destructive: false },
            { instance: 'sonarr', safe_write: false, destructive: false }
        ]);
    });

    /** Static config, the same on every call: sent only when asked for. */
    it('leaves permissions out below full', async () => {
        for (const detail of ['minimal', 'standard'] as const) {
            const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail, limit: 50 }, [instance('radarr', true, true)]);
            expect(result, detail).not.toHaveProperty('permissions');
        }
    });

    /** Every existing call site passes no instances and must keep working. */
    it('omits the field entirely when nobody supplied instances', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], std);
        expect(result.permissions).toBeUndefined();
    });
});

/**
 * `endpoints` carries `instance`, `service` and `baseUrl` only — never
 * `api_key`, `password`, `bearer_token`, or any other credential. A tool that
 * returns a key on request does not retrieve it, it publishes it: everything
 * a tool returns passes through a model's context, so the key is available to
 * any prompt the model later sees. A script that needs one runs beside the
 * config and imports `loadConfig` instead.
 */
describe('get_stack_health endpoints', () => {
    const SENTINEL = 'sk-do-not-ship-me-0123456789';

    const instanceWithUrl = (id: string, url: string) =>
        ({
            id,
            type: id.split('/')[0],
            config: {
                url,
                api_key: SENTINEL,
                timeout_ms: 10_000,
                permissions: { safe_write: true, destructive: false }
            }
        }) as unknown as ServiceInstance;

    it('reports each instance base URL', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], full, [
            instanceWithUrl('radarr', 'http://192.0.2.10:7878')
        ]);

        expect(result.endpoints).toEqual([{ instance: 'radarr', service: 'radarr', baseUrl: 'http://192.0.2.10:7878' }]);
    });

    it('omits endpoints below full, like permissions', async () => {
        for (const detail of ['minimal', 'standard'] as const) {
            const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail, limit: 50 }, [instanceWithUrl('radarr', 'http://192.0.2.10:7878')]);
            expect(result, detail).not.toHaveProperty('endpoints');
        }
    });

    /** Every existing call site passes no instances and must keep working. */
    it('omits the field entirely when nobody supplied instances', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], std);
        expect(result.endpoints).toBeUndefined();
    });

    it('never serializes an API key, at any detail level', async () => {
        // The guard that matters. Everything a tool returns passes through a
        // model's context — transcripts, logs, a provider. A key reaching this
        // response is a key published, not a key retrieved.
        for (const detail of ['minimal', 'standard', 'full'] as const) {
            const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail, limit: 50 }, [
                instanceWithUrl('radarr', 'http://192.0.2.10:7878')
            ]);
            expect(JSON.stringify(result)).not.toContain(SENTINEL);
        }
    });

    it('never serializes a credential carried in the URL itself, at any detail level', async () => {
        // The sentinel above only plants an `api_key`, so it could not catch
        // this: `UrlSchema` accepts userinfo, and Transmission and SABnzbd are
        // routinely deployed as `http://user:pass@host:9091`. Reported
        // verbatim, that publishes the credential under the one field whose
        // description promises no tool here ever returns one.
        for (const detail of ['minimal', 'standard', 'full'] as const) {
            const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail, limit: 50 }, [
                instanceWithUrl('transmission', `http://admin:${SENTINEL}@192.0.2.10:9091`)
            ]);
            const serialized = JSON.stringify(result);
            expect(serialized).not.toContain(SENTINEL);
            // The username is a credential half too — a name is half of a
            // guess, and it is no more this tool's to publish than the secret.
            expect(serialized).not.toContain('admin');
        }
    });

    it('keeps the host and port after stripping the credential', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], full, [
            instanceWithUrl('transmission', `http://admin:${SENTINEL}@192.0.2.10:9091`)
        ]);
        // Still usable as a base URL: stripping must not cost the answer the
        // field exists to give.
        expect(result.endpoints?.[0]?.baseUrl).toBe('http://192.0.2.10:9091/');
    });
});

/**
 * The values `add_media` and `update_media` refuse to guess. Without a way to
 * read them, an agent has to invent a profile name and finds out it was wrong
 * once the download finishes.
 */
describe('get_stack_health add options', () => {
    const addable = (overrides: Partial<Record<'profiles' | 'folders' | 'tags', () => Promise<unknown>>> = {}) =>
        ({
            id: 'radarr',
            type: 'radarr',
            testConnection: async () => healthy,
            getVersion: async () => '5.0',
            listQualityProfiles: overrides.profiles ?? (async () => [{ id: 4, name: 'HD-1080p', display: 'HD-1080p' }]),
            listRootFolders:
                overrides.folders ??
                (async () => [{ path: '/movies', display: '/movies', freeSpaceBytes: 100 }]),
            listTags: overrides.tags ?? (async () => [{ id: 1, label: '4k', display: '4k' }]),
            lookupForAdd: async () => ({ title: 'x' }),
            addMedia: async () => ({ id: 1, title: 'x' })
        }) as unknown as ServiceAdapter;

    describe('get_instance_options', () => {
        const noop = () => {};

        it('lists profiles, root folders and tags', async () => {
            expect(await buildInstanceOptions([addable()], {}, noop)).toEqual([
                {
                    instance: 'radarr',
                    qualityProfiles: [{ id: 4, name: 'HD-1080p' }],
                    rootFolders: [{ path: '/movies', freeSpaceBytes: 100 }],
                    tags: ['4k']
                }
            ]);
        });

        it('returns nothing for a service that is not configured', async () => {
            expect(await buildInstanceOptions([addable()], { service: 'sonarr' }, noop)).toEqual([]);
        });

        it('refuses an instance that does not exist, naming the ones that do', async () => {
            const refused = buildInstanceOptions([addable()], { instance: 'nope' }, noop);
            await expect(refused).rejects.toThrow(/no instance "nope"/);
            await expect(refused).rejects.toThrow(/radarr/);
        });

        it('takes the bare instance name as well as the full id', async () => {
            const named = { ...addable(), id: 'radarr/4k', instance: '4k' } as unknown as ServiceAdapter;
            for (const filter of [{ service: 'radarr', instance: '4k' }, { instance: 'radarr/4k' }] as const) {
                expect((await buildInstanceOptions([addable(), named], filter, noop)).map(o => o.instance)).toEqual(['radarr/4k']);
            }
        });

        it('refuses a service and instance that disagree', async () => {
            await expect(buildInstanceOptions([addable()], { service: 'sonarr', instance: 'radarr' }, noop)).rejects.toThrow(/under sonarr/);
        });

        it('answers through the tool handler, with free space and unmapped folders in the text', async () => {
            const server = new McpServer({ name: 'test', version: '0.0.0' });
            registerGetInstanceOptions(
                server,
                [addable({ folders: async () => [{ path: '/movies', display: '/movies', freeSpaceBytes: 2 * 1024 ** 3, unmappedFolders: ['a', 'b'] }] })]
            );
            const tool = (server as unknown as {
                _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: object) => Promise<{ content: { text: string }[]; structuredContent: { items: unknown[]; degraded: string[] } }> }>;
            })._registeredTools.get_instance_options!;
            const result = await tool.handler({}, {});
            expect(result.structuredContent.degraded).toEqual([]);
            expect(result.structuredContent.items).toHaveLength(1);
            const [summary, line] = result.content[0]!.text.split('\n');
            expect(summary).toBe('1 instance(s).');
            expect(line).toContain('HD-1080p (4)');
            expect(line).toMatch(/\/movies \(2\.\d+ GiB free, 2 unmapped\)/);
        });

        it('marks an instance degraded when its read is down', async () => {
            const down: string[] = [];
            const result = await buildInstanceOptions(
                [addable({ tags: async () => Promise.reject(new Error('down')) })],
                {},
                id => down.push(id)
            );
            expect(result).toEqual([]);
            expect(down).toEqual(['radarr']);
        });
    });

    /**
     * Carried on the root folder that reported it, not as a list of its own:
     * "three folders under /movies answer to nothing" is the finding, and a
     * bare list of names would lose which root they sit in on a stack with
     * more than one.
     */
    it('carries the folders a root maps to nothing', async () => {
        const result = await buildInstanceOptions(
            [
                addable({
                    folders: async () => [
                        {
                            path: '/movies',
                            display: '/movies',
                            freeSpaceBytes: 100,
                            unmappedFolders: ['Back to Black (2024) [tmdbid-998846]']
                        }
                    ]
                })
            ],
            {},
            () => {}
        );

        expect(result[0]?.rootFolders).toEqual([
            { path: '/movies', freeSpaceBytes: 100, unmappedFolders: ['Back to Black (2024) [tmdbid-998846]'] }
        ]);
    });

    it('leaves them out of get_stack_health at every detail: a profile list is not a fault', async () => {
        for (const detail of ['minimal', 'standard', 'full'] as const) {
            expect('options' in (await buildStackHealth([addable()], { detail, limit: 50 }))).toBe(false);
        }
    });

    it('says nothing about a service that cannot add', async () => {
        expect(await buildInstanceOptions([fakeArr({ diagnosis: healthy })], {}, () => {})).toEqual([]);
    });
});

/** The follow-up trigger_search and trigger_scan never had. */
describe('get_stack_health commands', () => {
    const running = (rows: unknown[]) =>
        ({
            id: 'radarr',
            type: 'radarr',
            testConnection: async () => healthy,
            getVersion: async () => '5.0',
            listCommands: async () => rows
        }) as unknown as ServiceAdapter;

    it('reports what is queued or running', async () => {
        const result = await buildStackHealth(
            [running([{ service: 'radarr', commandId: 1, name: 'MoviesSearch', status: 'started' }])],
            std
        );
        expect(result.commands).toEqual([
            { service: 'radarr', commandId: 1, name: 'MoviesSearch', status: 'started' }
        ]);
    });

    it('leaves them out at minimal — a running command is not a fault', async () => {
        const result = await buildStackHealth([running([{ commandId: 1 }])], { detail: 'minimal', limit: 50 });
        expect(result.commands).toBeUndefined();
    });

    it('degrades the service rather than failing when the command read is down', async () => {
        const broken = {
            id: 'radarr',
            type: 'radarr',
            testConnection: async () => healthy,
            getVersion: async () => '5.0',
            listCommands: async () => {
                throw new Error('down');
            }
        } as unknown as ServiceAdapter;

        const result = await buildStackHealth([broken], std);
        expect(result.degraded).toEqual(['radarr']);
        expect(result.commands).toEqual([]);
    });
});
