import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceInstance } from '../config/instances.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, READ_ONLY, TruncationSchema, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import {
    hasDiskSpace,
    hasHealthChecks,
    hasMediaAdd,
    hasScanState,
    type ConnectionDiagnosis,
    type DiskSpace,
    type HealthCheck,
    type ScanState,
    type ServiceAdapter
} from '../services/types.ts';

type Shaped<T> = { items: T[]; total: number; returned: number; offset: number; truncated: boolean };

export type StackHealthResult = {
    services: ConnectionDiagnosis[];
    disks: Shaped<DiskSpace>;
    failures: Shaped<HealthCheck>;
    /**
     * Not run through applyLimit: bounded by the number of configured services,
     * so it can never exceed eight rows. Wrapping a list that cannot truncate
     * in a truncation contract is noise in every response.
     */
    scans: ScanState[];
    /**
     * What each instance is allowed to do — absent unless the caller supplied
     * the instances, and absent at `minimal`, which answers "is anything
     * broken" and a permission is not a fault.
     *
     * Reported here because `arr://instances` needs it and a resource must
     * mirror a tool rather than originate one: a client that ignores resources
     * must not be the only one unable to answer "what may I do here". The
     * permission *source* is untouched — `permissionSourceFrom` still reads
     * config so an adapter cannot widen its own grants. This reports the gate's
     * answer; it is not a second one.
     */
    permissions?: InstancePermissions[];
    /** Absent unless the caller supplied the instances, and absent at
     *  `minimal` — a URL is not a fault. */
    endpoints?: InstanceEndpoint[];
    /**
     * What each Radarr/Sonarr instance will accept on an add or an update.
     * Only at `detail: "full"`: it is three extra calls per instance, and it
     * answers "what may I choose", not "is anything broken".
     */
    options?: InstanceOptions[];
    degraded: string[];
};

/**
 * The values `add_media` and `update_media` refuse to guess at. Paths and tag
 * labels are the **fenced** display forms: these are for reading, and the raw
 * path is only ever posted back inside the write tools, which resolve it
 * themselves.
 */
export type InstanceOptions = {
    instance: string;
    qualityProfiles: { id: number; name: string }[];
    rootFolders: { path: string; freeSpaceBytes?: number }[];
    tags: string[];
};

export type InstancePermissions = { instance: string; safe_write: boolean; destructive: boolean };

/**
 * Where each instance lives — **never how to authenticate to it**. A sibling of
 * `permissions` rather than a field on it, because a base URL is not a
 * permission and `InstancePermissions` would start lying about what it holds.
 *
 * There is deliberately no tool that returns an API key. Everything a tool
 * returns passes through a model's context, so such a tool would publish the
 * key rather than retrieve it. A script needing credentials runs beside the
 * same config and imports `loadConfig`.
 */
export type InstanceEndpoint = { instance: string; service: ServiceId; baseUrl: string };

/**
 * A base URL with its userinfo removed.
 *
 * `UrlSchema` accepts `http://user:pass@host:9091` — Transmission and SABnzbd
 * are routinely deployed behind exactly that — and reporting it verbatim would
 * publish a credential into a model's context under a field whose whole
 * documented promise is that this server never returns one. The strip is here,
 * at the single place a URL leaves the process, rather than in the schema: the
 * adapters still need the URL they were configured with in order to connect.
 *
 * The string is returned untouched when it carries no userinfo, because
 * `new URL(...).toString()` normalises — it appends a trailing slash — and a
 * URL nobody wrote is a small lie of its own.
 */
export function withoutCredentials(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username === '' && parsed.password === '') return url;
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        // Unreachable through config, which parses every URL at startup. A
        // credential must not survive an unparseable one either, so drop the
        // authority's userinfo textually rather than returning the input.
        return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
    }
}

/**
 * minimal — is anything broken? A verdict per service, and counts only.
 * standard — everything except disk paths, the longest strings in the response
 *            and rarely what the question was about.
 * full — everything, paths included.
 */
function project(result: StackHealthResult, detail: DetailLevel): StackHealthResult {
    if (detail === 'full') return result;

    if (detail === 'standard') {
        return {
            ...result,
            disks: {
                ...result.disks,
                items: result.disks.items.map(({ path: _path, ...rest }) => rest)
            }
        };
    }

    return {
        services: result.services.map(s => ({
            ok: s.ok,
            service: s.service,
            latency_ms: s.latency_ms,
            // Kind and detail, but not the remedy: minimal answers "is it
            // broken", and the remedy is for someone about to fix it.
            ...(s.error === undefined ? {} : { error: { kind: s.error.kind, detail: s.error.detail } })
        })),
        disks: { ...result.disks, items: [], returned: 0 },
        failures: { ...result.failures, items: [], returned: 0 },
        scans: result.scans.map(s => ({
            service: s.service,
            ...(s.lastCompleted === undefined ? {} : { lastCompleted: s.lastCompleted })
        })),
        // No permissions and no endpoints: minimal answers "is anything
        // broken", and neither a grant nor a URL is a fault.
        degraded: result.degraded
    };
}

/**
 * Composes per-service diagnoses into one answer. This tool must work
 * *especially* well when something is broken — a service
 * that is down contributes a diagnosis and a `degraded` entry, never an
 * exception.
 */
export async function buildStackHealth(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number },
    /** Optional and last, so every existing call site keeps compiling. */
    instances?: readonly ServiceInstance[]
): Promise<StackHealthResult> {
    const services: ConnectionDiagnosis[] = [];
    const degraded: string[] = [];
    const disks: DiskSpace[] = [];
    const failures: HealthCheck[] = [];
    const scans: ScanState[] = [];

    const markDegraded = (id: string) => {
        if (!degraded.includes(id)) degraded.push(id);
    };

    await Promise.all(
        adapters.map(async adapter => {
            let diagnosis: ConnectionDiagnosis;
            try {
                diagnosis = await adapter.testConnection();
            } catch (err) {
                // testConnection is contractually non-throwing, but a bug in
                // one adapter must not take down the whole answer.
                logger.error({ service: adapter.id, err }, 'testConnection threw; treating as degraded');
                diagnosis = {
                    ok: false,
                    service: adapter.id,
                    latency_ms: 0,
                    error: {
                        kind: err instanceof ServiceError ? err.kind : 'UpstreamError',
                        detail: err instanceof Error ? err.message : 'unknown error'
                    }
                };
            }

            services.push(diagnosis);
            if (!diagnosis.ok) {
                markDegraded(adapter.id);
                return; // do not hammer a service that just failed its probe
            }

            // A service with neither capability contributes its diagnosis and
            // no rows, rather than being special-cased out of the loop.
            const [diskResult, healthResult, scanResult] = await Promise.allSettled([
                hasDiskSpace(adapter) ? adapter.getDiskSpace() : Promise.resolve([]),
                hasHealthChecks(adapter) ? adapter.getFailedHealthChecks() : Promise.resolve([]),
                hasScanState(adapter) ? adapter.getScanState() : Promise.resolve(undefined)
            ]);

            if (diskResult.status === 'fulfilled') {
                disks.push(...diskResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'diskspace read failed');
                markDegraded(adapter.id);
            }

            if (healthResult.status === 'fulfilled') {
                failures.push(...healthResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'health read failed');
                markDegraded(adapter.id);
            }

            if (scanResult.status === 'fulfilled') {
                if (scanResult.value !== undefined) scans.push(scanResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'scan state read failed');
                markDegraded(adapter.id);
            }
        })
    );

    // Settled per instance, never awaited bare: an instance whose profile list
    // is down still has health worth reporting, and this list is the least
    // important thing in the response.
    const options =
        opts.detail !== 'full'
            ? undefined
            : (
                  await Promise.all(
                      adapters.filter(hasMediaAdd).map(async adapter => {
                          try {
                              const [profiles, folders, tags] = await Promise.all([
                                  adapter.listQualityProfiles(),
                                  adapter.listRootFolders(),
                                  adapter.listTags()
                              ]);
                              return [
                                  {
                                      instance: adapter.id,
                                      qualityProfiles: profiles.map(p => ({ id: p.id, name: p.display })),
                                      rootFolders: folders.map(f => ({
                                          path: f.display,
                                          ...(f.freeSpaceBytes === undefined ? {} : { freeSpaceBytes: f.freeSpaceBytes })
                                      })),
                                      tags: tags.map(t => t.display)
                                  }
                              ];
                          } catch (err) {
                              logger.warn({ service: adapter.id, err }, 'add options unavailable; omitting');
                              markDegraded(adapter.id);
                              return [];
                          }
                      })
                  )
              )
                  .flat()
                  .sort((a, b) => a.instance.localeCompare(b.instance));

    // Promise.all resolves in input order but the pushes above race, so sort to
    // make the response stable across calls and diffable in tests.
    services.sort((a, b) => a.service.localeCompare(b.service));
    scans.sort((a, b) => a.service.localeCompare(b.service));
    degraded.sort();

    // One budget across both lists, spent on failures first: a failing health
    // check is the reason someone called this tool, and a disk row is context.
    // Applying `limit` to each list independently let `limit: 50` return 100
    // rows, against a parameter whose only job is bounding context.
    const shapedFailures = applyLimit(failures, opts.limit);
    const remaining = Math.max(0, opts.limit - shapedFailures.returned);

    // applyLimit clamps its limit to a minimum of one, deliberately: a caller
    // must not be able to ask for zero items and get a silently empty list.
    // A spent budget is the one case where zero is the honest answer, so it is
    // handled here rather than by weakening that guard for every other caller.
    // `offset: 0` rather than omitted, so a hand-built envelope reports the
    // same five fields `applyLimit` does. This tool takes no `offset`
    // parameter: one budget spans two lists, so a single number could not say
    // which of them it meant to skip into — and neither list is one you page
    // through. `limit` here bounds context, it does not paginate.
    const shapedDisks =
        remaining === 0
            ? { items: [], total: disks.length, returned: 0, offset: 0, truncated: disks.length > 0 }
            : applyLimit(disks, remaining);

    // Counts stay honest at every detail level: a model must never see
    // returned: 0 and conclude there are no disks.
    // Sorted by id like the lists above, and read from each instance's own
    // config rather than from its adapter — the same source the write gate
    // uses, so the two can never disagree about what is permitted.
    const permissions =
        instances === undefined
            ? undefined
            : [...instances]
                  .map(i => ({
                      instance: i.id,
                      safe_write: i.config.permissions.safe_write,
                      destructive: i.config.permissions.destructive
                  }))
                  .sort((a, b) => a.instance.localeCompare(b.instance));

    // Same source as permissions, so a base URL and its permission set can
    // never disagree about which instance they describe.
    const endpoints =
        instances === undefined
            ? undefined
            : [...instances]
                  .map(i => ({ instance: i.id, service: i.type, baseUrl: withoutCredentials(i.config.url) }))
                  .sort((a, b) => a.instance.localeCompare(b.instance));

    return project(
        {
            services,
            disks: shapedDisks,
            failures: shapedFailures,
            scans,
            ...(permissions === undefined ? {} : { permissions }),
            ...(endpoints === undefined ? {} : { endpoints }),
            ...(options === undefined ? {} : { options }),
            degraded
        },
        opts.detail
    );
}

export function registerStackHealth(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    instances?: readonly ServiceInstance[]
): void {
    server.registerTool(
        'stack_health',
        {
            title: 'Stack health',
            annotations: READ_ONLY,
            description:
                'Health of every configured service: version, disk space, failing health checks, when each library was last scanned, and what each instance is permitted to do. Returns partial results with a `degraded` list rather than failing when a service is down. The `permissions` list is also the set of ids you may pass as `instance` to other tools. `endpoints` gives each instance\'s base URL, for scripts that need to reach a service directly. At `detail: "full"`, `options` lists the quality profiles, root folders and tags each Radarr/Sonarr instance actually has — the values `add_media` and `update_media` refuse to guess, so read them here rather than inventing a profile name. API keys are never returned by any tool in this server — a script that needs one runs beside the config and reads it there.',
            inputSchema: toolInput({ detail: DetailSchema, limit: LimitSchema }),
            // The one read tool whose answer is not a list, so it declares its
            // own shape rather than the paged envelope. `disks` and `failures`
            // are envelopes of their own — one `limit` budget spans both, spent
            // on failures first, which is why neither is the top-level list.
            outputSchema: z.looseObject({
                services: z.array(z.unknown()).describe('One row per configured instance: reachable, version, latency.'),
                failures: TruncationSchema.describe('Health checks the services themselves are reporting.'),
                disks: TruncationSchema.describe('Free space per root folder.'),
                scans: z.array(z.unknown()).describe('When each library was last scanned. Never truncated — bounded by the number of services.'),
                permissions: z.array(z.unknown()).optional().describe('What each instance may do. Absent at `minimal` — a permission is not a fault.'),
                endpoints: z.array(z.unknown()).optional().describe('Where each instance lives. Never a credential.'),
                options: z
                    .array(z.unknown())
                    .optional()
                    .describe('Quality profiles, root folders and tags each Radarr/Sonarr instance has. Only at `detail: "full"`.'),
                degraded: z.array(z.string())
            })
        },
        async ({ detail, limit }) => {
            const result = await buildStackHealth(adapters, { detail, limit }, instances);
            const neverScanned = result.scans.filter(s => s.lastCompleted === undefined).length;
            const summary =
                result.degraded.length === 0
                    ? `All ${result.services.length} configured service(s) healthy.` +
                      (neverScanned > 0 ? ` ${neverScanned} report no completed library scan.` : '')
                    : `${result.degraded.length} of ${result.services.length} service(s) degraded: ${result.degraded.join(', ')}.`;

            return {
                content: [{ type: 'text', text: summary }],
                structuredContent: result
            };
        }
    );
}
