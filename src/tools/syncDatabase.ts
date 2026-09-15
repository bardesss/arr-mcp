import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import type { JobOutcome, JobStatus, ProfilarrDatabase } from '../services/profilarr.ts';
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

const TERMINAL: ReadonlySet<JobStatus> = new Set(['success', 'failed', 'cancelled']);

type SyncCapable = {
    status(): Promise<{ databases: ProfilarrDatabase[] }>;
    triggerSync(databaseId: number): Promise<number>;
    jobStatus(jobId: number): Promise<JobOutcome>;
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

/** What every read of a job's status says on failure — a mid-poll read that
 *  errors is not evidence the sync failed, only that this one check did. */
const STILL_RUNNING_REMEDY = 'The sync may still be running — check Profilarr directly.';

/** The one place a 202 stops being trusted: this waits for a real outcome. */
async function awaitJob(
    adapter: SyncCapable,
    jobId: number,
    pollIntervalMs: number,
    maxPolls: number
): Promise<JobOutcome> {
    for (let attempt = 0; attempt < maxPolls; attempt++) {
        let outcome: JobOutcome;
        try {
            outcome = await adapter.jobStatus(jobId);
        } catch (err) {
            throw new ServiceError(
                'UpstreamError',
                'profilarr',
                `could not read sync job ${jobId}'s status: ${err instanceof Error ? err.message : String(err)}`,
                { remedy: STILL_RUNNING_REMEDY, cause: err }
            );
        }
        if (TERMINAL.has(outcome.status)) return outcome;
        // Never after the last attempt — nothing is waiting on the throw below.
        if (attempt < maxPolls - 1) await sleep(pollIntervalMs);
    }
    throw new ServiceError('UpstreamError', 'profilarr', `sync job ${jobId} did not finish after ${maxPolls} polls`, {
        remedy: STILL_RUNNING_REMEDY
    });
}

export function registerSyncDatabase(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    /** Test-only knobs — production keeps the defaults. */
    opts: { pollIntervalMs?: number; maxPolls?: number } = {}
): void {
    // 24 polls at 1s apart, minus the skipped final sleep (see `awaitJob`):
    // ~23s worst case, comfortably inside a 60s client timeout, with a poll
    // frequent enough that an ordinary git-pull sync is reported promptly.
    const pollIntervalMs = opts.pollIntervalMs ?? 1000;
    const maxPolls = opts.maxPolls ?? 24;

    registerWriteTool(server, context, {
        name: 'sync_database',
        title: 'Sync a Profilarr database',
        description:
            "Asks Profilarr to pull one of its databases — custom formats, quality profiles, delay profiles — " +
            'from its configured git source. Safe tier: it only changes Profilarr\'s own store, never Radarr or ' +
            'Sonarr directly. `database` names one by name or id; required only when Profilarr has more than one. ' +
            'Profilarr answers the request with a queued job, and this tool polls it to a terminal status before ' +
            'reporting anything, so the result reflects whether the sync actually finished, not just that it was ' +
            'accepted. A sync can legitimately find nothing to pull; that reports as a completed call whose ' +
            '`outcome` is `skipped`, not as a normal sync. Previews by default — call again with the returned ' +
            '`confirm` token to run it.',
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
            const { status, result, detail } = await awaitJob(adapter, jobId, pollIntervalMs, maxPolls);

            if (status !== 'success') {
                throw new ServiceError(
                    'UpstreamError',
                    'profilarr',
                    `sync job ${jobId} ended as ${status}${detail === undefined ? '' : `: ${detail}`}`,
                    detail === undefined ? { remedy: "Check Profilarr's job history for what went wrong." } : {}
                );
            }

            // `status` is the queue outcome; `result` is the handler's own,
            // and can disagree — `failure`/`cancelled` here mean the handler
            // didn't do what was asked, so treat them like a failed queue.
            if (result === 'failure' || result === 'cancelled') {
                throw new ServiceError(
                    'UpstreamError',
                    'profilarr',
                    `sync job ${jobId} ended as ${result}${detail === undefined ? '' : `: ${detail}`}`,
                    detail === undefined ? { remedy: "Check Profilarr's job history for what went wrong." } : {}
                );
            }

            // `skipped` means Profilarr found nothing to pull — a real,
            // non-error outcome, not a sync that happened.
            if (result === 'skipped') {
                return { jobId, status, outcome: 'skipped', ...(detail === undefined ? {} : { detail }) };
            }

            return { jobId, status };
        },

        // Only the skipped case needs a different sentence — a real sync
        // keeps the default `Applied. ${plan.summary}`. Without this, a
        // sync that pulled nothing would still read as a completed sync,
        // which is the same bug the structured `outcome` field exists to
        // avoid, one level up in the text a client actually shows.
        applied(outcome, plan) {
            const o = outcome as { outcome?: string; detail?: string } | undefined;
            if (o?.outcome !== 'skipped') return undefined;
            const name = /"([^"]+)"/.exec(plan.summary)?.[1] ?? plan.target;
            return (
                `Nothing to pull — Profilarr's "${name}" database was already up to date with its git source, ` +
                `so no sync happened.${o.detail === undefined ? '' : ` Profilarr said: ${o.detail}`}`
            );
        }
    });
}
