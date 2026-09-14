import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import type { ProfilarrDatabase } from '../services/profilarr.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { chooseOne } from './chooseOne.ts';
import { resolveInstance } from './resolveInstance.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The only write in this plan. It reaches Profilarr alone — never Radarr or
 * Sonarr — and is `safe` tier because a `pcd.sync` only pulls Profilarr's own
 * git-tracked store; the arrs pick up any change later, on Profilarr's own
 * schedule.
 *
 * Profilarr answers the trigger with 202 and a job id, not an outcome. `apply`
 * polls the job to a terminal status and reports that, so a queued-but-not-run
 * sync is never reported as done.
 */

type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
const TERMINAL: ReadonlySet<JobStatus> = new Set(['success', 'failed', 'cancelled']);

type SyncCapable = {
    status(): Promise<{ databases: ProfilarrDatabase[] }>;
    triggerSync(databaseId: number): Promise<number>;
    jobStatus(jobId: number): Promise<JobStatus>;
};

const hasSync = (a: ServiceAdapter): a is ServiceAdapter & SyncCapable =>
    a.type === 'profilarr' &&
    typeof (a as Partial<SyncCapable>).triggerSync === 'function' &&
    typeof (a as Partial<SyncCapable>).jobStatus === 'function';

const findAdapter = (adapters: readonly ServiceAdapter[]): ServiceAdapter & SyncCapable => {
    const adapter = resolveInstance(adapters, 'profilarr');
    if (!hasSync(adapter)) {
        throw new ServiceError('NotFound', 'profilarr', 'this profilarr adapter cannot sync databases', {
            remedy: 'Needs a Profilarr adapter exposing triggerSync and jobStatus.'
        });
    }
    return adapter;
};

/** A request made entirely of digits is an id, never a name substring — the
 *  same rule chooseOne.ts applies to profiles, tags and folders. */
const isNumeric = (value: string) => /^\d+$/.test(value);

const DATABASE_MATCH = {
    exact: (d: ProfilarrDatabase, requested: string): boolean =>
        String(d.id) === requested || d.name.toLowerCase() === requested.toLowerCase(),
    loose: (d: ProfilarrDatabase, requested: string): boolean =>
        !isNumeric(requested) && d.name.toLowerCase().includes(requested.toLowerCase())
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The one place a 202 stops being trusted: this waits for a real outcome. */
async function awaitJob(
    adapter: SyncCapable,
    jobId: number,
    pollIntervalMs: number,
    maxPolls: number
): Promise<JobStatus> {
    for (let attempt = 0; attempt < maxPolls; attempt++) {
        const status = await adapter.jobStatus(jobId);
        if (TERMINAL.has(status)) return status;
        await sleep(pollIntervalMs);
    }
    throw new ServiceError('UpstreamError', 'profilarr', `sync job ${jobId} did not finish after ${maxPolls} polls`, {
        remedy: 'Check Profilarr directly — the job may still be running.'
    });
}

export function registerSyncDatabase(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    /** Test-only knobs — production keeps the defaults. */
    opts: { pollIntervalMs?: number; maxPolls?: number } = {}
): void {
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const maxPolls = opts.maxPolls ?? 60;

    registerWriteTool(server, context, {
        name: 'sync_database',
        title: 'Sync a Profilarr database',
        description:
            "Asks Profilarr to pull one of its databases — custom formats, quality profiles, delay profiles — " +
            'from its configured git source. Safe tier: it only changes Profilarr\'s own store, never Radarr or ' +
            'Sonarr directly. `database` names one by name or id; required only when Profilarr has more than one. ' +
            'Profilarr answers the request with a queued job, and this tool polls it to a terminal status before ' +
            'reporting anything, so the result reflects whether the sync actually finished, not just that it was ' +
            'accepted. Previews by default — call again with the returned `confirm` token to run it.',
        inputSchema: z.object({
            database: z
                .string()
                .optional()
                .describe('Database name or id. Optional only when Profilarr has exactly one.')
        }),
        service: 'profilarr',
        operation: 'sync_database',
        tier: 'safe',

        async plan({ database }): Promise<WritePlan> {
            const adapter = findAdapter(adapters);
            const { databases } = await adapter.status();
            const db = chooseOne(databases, database, DATABASE_MATCH, d => `${d.name} (id ${d.id})`, 'database', 'profilarr');

            return {
                target: `profilarr:${db.id}`,
                summary: `Sync Profilarr's "${db.name}" database from its configured git source.`,
                effects: [
                    `Profilarr re-reads "${db.name}" from git; the custom formats, quality profiles and delay ` +
                        'profiles it manages may change as a result.',
                    'Does not write anything to Radarr or Sonarr directly — they pick up the change only when ' +
                        'Profilarr syncs them on its own schedule.',
                    'Not reversible through arr-mcp: revert in Profilarr or git if the pulled change is unwanted.'
                ],
                args: { databaseId: db.id }
            };
        },

        async apply(plan) {
            const { databaseId } = plan.args as { databaseId: number };
            const adapter = findAdapter(adapters);
            const jobId = await adapter.triggerSync(databaseId);
            const status = await awaitJob(adapter, jobId, pollIntervalMs, maxPolls);

            if (status !== 'success') {
                throw new ServiceError('UpstreamError', 'profilarr', `sync job ${jobId} ended as ${status}`, {
                    remedy: "Check Profilarr's job history for what went wrong."
                });
            }
            return { jobId, status };
        }
    });
}
