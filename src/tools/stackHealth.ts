import type { McpServer } from '@modelcontextprotocol/server';
import type { ServiceInstance } from '../config/instances.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import {
    hasDiskSpace,
    hasHealthChecks,
    hasScanState,
    type ConnectionDiagnosis,
    type DiskSpace,
    type HealthCheck,
    type ScanState,
    type ServiceAdapter
} from '../services/types.ts';

type Shaped<T> = { items: T[]; total: number; returned: number; truncated: boolean };

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
    degraded: string[];
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
    const shapedDisks =
        remaining === 0
            ? { items: [], total: disks.length, returned: 0, truncated: disks.length > 0 }
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
            description:
                'Health of every configured service: version, disk space, failing health checks, when each library was last scanned, and what each instance is permitted to do. Returns partial results with a `degraded` list rather than failing when a service is down. The `permissions` list is also the set of ids you may pass as `instance` to other tools. `endpoints` gives each instance\'s base URL, for scripts that need to reach a service directly. API keys are never returned by any tool in this server — a script that needs one runs beside the config and reads it there.',
            inputSchema: toolInput({ detail: DetailSchema, limit: LimitSchema })
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
