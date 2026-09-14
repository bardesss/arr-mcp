import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { ProfilarrDatabase } from '../src/services/profilarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerSyncDatabase } from '../src/tools/syncDatabase.ts';
import type { WriteToolResult } from '../src/tools/write.ts';

type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
type FakeProfilarr = ServiceAdapter & {
    status(): Promise<{ databases: ProfilarrDatabase[] }>;
    triggerSync(databaseId: number): Promise<number>;
    jobStatus(jobId: number): Promise<JobStatus>;
};

const db = (id: number, name: string): ProfilarrDatabase => ({
    id,
    name,
    enabled: true,
    lastSyncedAt: null,
    counts: { customFormats: 0, qualityProfiles: 0, regularExpressions: 0, delayProfiles: 0 }
});

/** A job that answers `statuses` in order, holding the last one once exhausted. */
function fakeProfilarr(databases: ProfilarrDatabase[], statuses: JobStatus[]) {
    const triggerCalls: number[] = [];
    let jobCalls = 0;
    const adapter: FakeProfilarr = {
        id: 'profilarr',
        type: 'profilarr',
        testConnection: () => Promise.reject(new Error('not used')),
        getVersion: () => Promise.reject(new Error('not used')),
        status: () => Promise.resolve({ databases }),
        triggerSync: (databaseId: number) => {
            triggerCalls.push(databaseId);
            return Promise.resolve(9);
        },
        jobStatus: () => {
            const status = statuses[Math.min(jobCalls, statuses.length - 1)] as JobStatus;
            jobCalls++;
            return Promise.resolve(status);
        }
    };
    return { adapter, triggerCalls, jobCallCount: () => jobCalls };
}

const keyed: KeyedServiceConfig = {
    url: 'http://profilarr:6868',
    api_key: 'k',
    timeout_ms: 5000,
    permissions: { safe_write: true, destructive: false }
};

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: {
    adapter: ServiceAdapter;
    permissions?: Partial<Record<ServiceId, AnyServiceConfig>>;
}) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const audit = WriteAudit.ephemeral();
    registerSyncDatabase(
        server as never,
        {
            permissions: permissionSourceFrom(
                instancesOf(opts.permissions ?? { profilarr: keyed as unknown as AnyServiceConfig })
            ),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        [opts.adapter],
        // No real waiting in tests — only the polling behaviour is under test.
        { pollIntervalMs: 0, maxPolls: 5 }
    );

    return { call: (a: Record<string, unknown>) => call(a), audit };
}

describe('sync_database', () => {
    it('previews without triggering anything', async () => {
        const { adapter, triggerCalls } = fakeProfilarr([db(3, 'Dictionarry')], ['success']);
        const h = harness({ adapter });

        const { structuredContent } = await h.call({});
        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(triggerCalls).toHaveLength(0);
    });

    it('refuses to guess when several databases exist and none is named', async () => {
        const { adapter } = fakeProfilarr([db(1, 'Dictionarry'), db(2, 'TRaSH')], ['success']);
        const h = harness({ adapter });

        await expect(h.call({})).rejects.toThrow(/several databases/);
    });

    it('selects the named database among several, by name', async () => {
        const { adapter, triggerCalls } = fakeProfilarr([db(1, 'Dictionarry'), db(2, 'TRaSH')], ['success']);
        const h = harness({ adapter });

        const preview = await h.call({ database: 'TRaSH' });
        await h.call({ database: 'TRaSH', confirm: preview.structuredContent.confirm_token });

        expect(triggerCalls).toEqual([2]);
    });

    it('polls the job to a terminal state before reporting it applied', async () => {
        const { adapter, jobCallCount } = fakeProfilarr([db(3, 'Dictionarry')], ['queued', 'running', 'success']);
        const h = harness({ adapter });

        const preview = await h.call({});
        const applied = await h.call({ confirm: preview.structuredContent.confirm_token });

        expect(applied.structuredContent.applied).toBe(true);
        expect(applied.structuredContent.result).toMatchObject({ status: 'success' });
        // Never just the 202 — jobStatus had to be asked more than once.
        expect(jobCallCount()).toBeGreaterThan(1);
    });

    it('does not report success when the job ends failed', async () => {
        const { adapter } = fakeProfilarr([db(3, 'Dictionarry')], ['queued', 'failed']);
        const h = harness({ adapter });

        const preview = await h.call({});
        await expect(h.call({ confirm: preview.structuredContent.confirm_token })).rejects.toThrow(/failed/);
    });

    it('does not report success when the job is cancelled', async () => {
        const { adapter } = fakeProfilarr([db(3, 'Dictionarry')], ['queued', 'cancelled']);
        const h = harness({ adapter });

        const preview = await h.call({});
        await expect(h.call({ confirm: preview.structuredContent.confirm_token })).rejects.toThrow(/cancelled/);
    });

    it('does not report success when the job never reaches a terminal status', async () => {
        // Never terminates on its own — this is the exhaustion path, not one
        // of the three real outcomes. Reporting anything but a refusal here
        // would be the defining failure this whole tool exists to avoid.
        const { adapter, jobCallCount } = fakeProfilarr([db(3, 'Dictionarry')], ['running']);
        const h = harness({ adapter });

        const preview = await h.call({});
        await expect(h.call({ confirm: preview.structuredContent.confirm_token })).rejects.toThrow(
            /sync job 9 did not finish after 5 polls.*check profilarr/i
        );
        // Every budgeted poll ran — not an early bail after one or two checks.
        expect(jobCallCount()).toBe(5);
    });

    it('says the sync may still be running when a mid-poll status read fails', async () => {
        const { adapter: base } = fakeProfilarr([db(3, 'Dictionarry')], ['queued', 'success']);
        let calls = 0;
        const adapter: FakeProfilarr = {
            ...base,
            jobStatus: () => {
                calls += 1;
                // The first read is a transient upstream failure (a 502, say);
                // it must read as "still running", not as a failed sync.
                if (calls === 1) return Promise.reject(new Error('502 Bad Gateway'));
                return Promise.resolve('success');
            }
        };
        const h = harness({ adapter });

        const preview = await h.call({});
        await expect(h.call({ confirm: preview.structuredContent.confirm_token })).rejects.toThrow(
            /may still be running/i
        );
    });

    it('names the config key when safe writes are disabled', async () => {
        const { adapter } = fakeProfilarr([db(3, 'Dictionarry')], ['success']);
        const off: KeyedServiceConfig = { ...keyed, permissions: { safe_write: false, destructive: false } };
        const h = harness({ adapter, permissions: { profilarr: off as unknown as AnyServiceConfig } });

        await expect(h.call({})).rejects.toThrow(/safe_write/);
    });
});
