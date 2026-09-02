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
import type { ServiceInstance } from '../src/config/instances.ts';
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

/**
 * `arr://instances` needs to say what each instance is allowed to do, and a
 * resource must mirror a tool rather than originate — a client that ignores
 * resources must not be the only one unable to answer "what may I do here".
 * So stack_health reports it.
 *
 * The permission *source* is untouched: `permissionSourceFrom` still reads
 * config, deliberately, so an adapter cannot widen its own grants. This
 * reports the gate's answer; it does not become a second one.
 */
describe('stack_health permissions', () => {
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
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], std, [
            instance('radarr/4k', true, false),
            instance('sonarr', false, false)
        ]);

        expect(result.permissions).toEqual([
            { instance: 'radarr/4k', safe_write: true, destructive: false },
            { instance: 'sonarr', safe_write: false, destructive: false }
        ]);
    });

    /** Minimal answers "is anything broken", and a permission is not a fault. */
    it('leaves permissions out of a minimal answer', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail: 'minimal', limit: 50 }, [
            instance('radarr', true, true)
        ]);
        expect(result.permissions).toBeUndefined();
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
describe('stack_health endpoints', () => {
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
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], std, [
            instanceWithUrl('radarr', 'http://192.0.2.10:7878')
        ]);

        expect(result.endpoints).toEqual([{ instance: 'radarr', service: 'radarr', baseUrl: 'http://192.0.2.10:7878' }]);
    });

    /** Minimal answers "is anything broken", and a URL is not a fault. */
    it('omits endpoints out of a minimal answer', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail: 'minimal', limit: 50 }, [
            instanceWithUrl('radarr', 'http://192.0.2.10:7878')
        ]);
        expect(result).not.toHaveProperty('endpoints');
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
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], std, [
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
describe('stack_health add options', () => {
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

    it('lists profiles, root folders and tags at detail: full', async () => {
        const result = await buildStackHealth([addable()], { detail: 'full', limit: 50 });
        expect(result.options).toEqual([
            {
                instance: 'radarr',
                qualityProfiles: [{ id: 4, name: 'HD-1080p' }],
                rootFolders: [{ path: '/movies', freeSpaceBytes: 100 }],
                tags: ['4k']
            }
        ]);
    });

    it('leaves them out below full — a profile list is not a fault', async () => {
        expect((await buildStackHealth([addable()], std)).options).toBeUndefined();
        expect((await buildStackHealth([addable()], { detail: 'minimal', limit: 50 })).options).toBeUndefined();
    });

    it('degrades the instance rather than failing the call when the read is down', async () => {
        const result = await buildStackHealth(
            [
                addable({
                    profiles: async () => {
                        throw new Error('down');
                    }
                })
            ],
            { detail: 'full', limit: 50 }
        );
        expect(result.services).toHaveLength(1);
        expect(result.options).toEqual([]);
        expect(result.degraded).toEqual(['radarr']);
    });

    it('says nothing about a service that cannot add', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail: 'full', limit: 50 });
        expect(result.options).toEqual([]);
    });
});

/** The follow-up trigger_search and trigger_scan never had. */
describe('stack_health commands', () => {
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
