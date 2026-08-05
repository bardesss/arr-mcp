import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
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
    degraded: ServiceId[];
};

/**
 * minimal  — is anything broken? A verdict per service, and counts only.
 * standard — everything except disk paths, the longest strings in the response
 *            and rarely what the question was about.
 * full     — everything, paths included.
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
        degraded: result.degraded
    };
}

/**
 * Composes per-service diagnoses into one answer. This tool must work
 * *especially* well when something is broken (design spec §15) — a service
 * that is down contributes a diagnosis and a `degraded` entry, never an
 * exception.
 */
export async function buildStackHealth(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number }
): Promise<StackHealthResult> {
    const services: ConnectionDiagnosis[] = [];
    const degraded: ServiceId[] = [];
    const disks: DiskSpace[] = [];
    const failures: HealthCheck[] = [];
    const scans: ScanState[] = [];

    const markDegraded = (id: ServiceId) => {
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
    return project(
        { services, disks: shapedDisks, failures: shapedFailures, scans, degraded },
        opts.detail
    );
}

export function registerStackHealth(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'stack_health',
        {
            description:
                'Health of every configured service: version, disk space, failing health checks, and when each library was last scanned. Returns partial results with a `degraded` list rather than failing when a service is down.',
            inputSchema: z.object({ detail: DetailSchema, limit: LimitSchema })
        },
        async ({ detail, limit }) => {
            const result = await buildStackHealth(adapters, { detail, limit });
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
