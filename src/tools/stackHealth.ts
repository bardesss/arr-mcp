import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
import type { ArrAdapter, ConnectionDiagnosis, DiskSpace, HealthCheck, ServiceAdapter } from '../services/types.ts';

type Shaped<T> = { items: T[]; total: number; returned: number; truncated: boolean };

export type StackHealthResult = {
    services: ConnectionDiagnosis[];
    disks: Shaped<DiskSpace>;
    failures: Shaped<HealthCheck>;
    degraded: ServiceId[];
};

const isArr = (a: ServiceAdapter): a is ArrAdapter =>
    'getDiskSpace' in a && typeof (a as ArrAdapter).getDiskSpace === 'function';

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

            if (!isArr(adapter)) return;

            const [diskResult, healthResult] = await Promise.allSettled([
                adapter.getDiskSpace(),
                adapter.getFailedHealthChecks()
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
        })
    );

    // Promise.all resolves in input order but the pushes above race, so sort to
    // make the response stable across calls and diffable in tests.
    services.sort((a, b) => a.service.localeCompare(b.service));
    degraded.sort();

    const shapedDisks = applyLimit(disks, opts.limit);
    const shapedFailures = applyLimit(failures, opts.limit);

    // `minimal` drops per-item payloads but keeps the counts honest: a model
    // must never see returned: 0 and conclude there are no disks.
    return {
        services,
        disks: opts.detail === 'minimal' ? { ...shapedDisks, items: [], returned: 0 } : shapedDisks,
        failures: shapedFailures,
        degraded
    };
}

export function registerStackHealth(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'stack_health',
        {
            description:
                'Health of every configured service: version, disk space, failing health checks, and which services could not be reached. Returns partial results with a `degraded` list rather than failing when a service is down.',
            inputSchema: z.object({ detail: DetailSchema, limit: LimitSchema })
        },
        async ({ detail, limit }) => {
            const result = await buildStackHealth(adapters, { detail, limit });
            const summary =
                result.degraded.length === 0
                    ? `All ${result.services.length} configured service(s) healthy.`
                    : `${result.degraded.length} of ${result.services.length} service(s) degraded: ${result.degraded.join(', ')}.`;

            return {
                content: [{ type: 'text', text: summary }],
                structuredContent: result
            };
        }
    );
}
