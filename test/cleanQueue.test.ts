import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerCleanQueue } from '../src/tools/cleanQueue.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const permissive = (safe_write: boolean, destructive = false): AnyServiceConfig =>
    ({ ...keyed(7878), permissions: { safe_write, destructive } }) as AnyServiceConfig;

const BLOCKED_A = {
    id: 693439963,
    title: 'Good.Boy.2025.1080p-SPHD',
    status: 'completed',
    trackedDownloadState: 'importBlocked'
};
const BLOCKED_B = {
    id: 1036990902,
    title: 'Summerween.2026.1080p-BobDobbs',
    status: 'completed',
    trackedDownloadState: 'importBlocked'
};
/** Unlinked but mid-transfer — the live Sonarr had one of these. */
const ORPHAN_DOWNLOADING = { id: 731469873, title: 'Lawless.2012-CHD', status: 'downloading', trackedDownloadState: 'downloading' };
const HEALTHY = { id: 5, title: 'Some.Film-GROUP', status: 'downloading', movieId: 1689, trackedDownloadState: 'downloading' };
/** Blocked, but its movie is still there — a real import problem to look at, not litter. */
const BLOCKED_LINKED = {
    id: 77,
    title: 'Still.Here-GROUP',
    status: 'completed',
    movieId: 42,
    trackedDownloadState: 'importBlocked'
};

function recordingFetch(records: unknown[]) {
    const sent: { path: string; method: string; query: Record<string, string> }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({ path: url.pathname, method: init?.method ?? 'GET', query: Object.fromEntries(url.searchParams) });
        if (init?.method === 'DELETE') return jsonResponse({});
        return jsonResponse({ records, totalRecords: records.length });
    }) as unknown as typeof fetch;
    return { impl, sent, deletes: () => sent.filter(s => s.method === 'DELETE') };
}

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(records: unknown[] = [BLOCKED_A, BLOCKED_B, ORPHAN_DOWNLOADING, HEALTHY, BLOCKED_LINKED], opts: { permissions?: Partial<Record<ServiceId, AnyServiceConfig>>; adapters?: ServiceAdapter[] } = {}) {
    const fetch = recordingFetch(records);
    const adapters = opts.adapters ?? [new RadarrAdapter(keyed(7878), fetch.impl)];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_name: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    registerCleanQueue(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(opts.permissions ?? { radarr: permissive(true, true) })),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (args: Record<string, unknown>) => call(args), fetch };
}

const args = { service: 'radarr' };

describe('clean_queue', () => {
    it('previews only the orphaned items that are import-blocked', async () => {
        const { structuredContent } = await harness().call({ ...args, dry_run: true });
        expect(structuredContent.summary).toContain('2');
        expect(structuredContent.effects.join(' ')).toContain('Good.Boy');
        expect(structuredContent.effects.join(' ')).toContain('Summerween');
    });

    it('never touches an orphan that is still downloading', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ ...args, dry_run: true });
        expect(structuredContent.effects.join(' ')).not.toContain('Lawless');

        const first = await h.call(args);
        await h.call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(h.fetch.deletes().map(d => d.path)).not.toContain('/api/v3/queue/731469873');
    });

    it('leaves a blocked item alone when its movie still exists', async () => {
        const { structuredContent } = await harness().call({ ...args, dry_run: true });
        expect(structuredContent.effects.join(' ')).not.toContain('Still.Here');
    });

    it('leaves a healthy download alone', async () => {
        const { structuredContent } = await harness().call({ ...args, dry_run: true });
        expect(structuredContent.effects.join(' ')).not.toContain('Some.Film');
    });

    it('changes nothing on a dry run', async () => {
        const h = harness();
        await h.call({ ...args, dry_run: true });
        expect(h.fetch.deletes()).toHaveLength(0);
    });

    it('deletes nothing on the first call, then every match on the confirmed one', async () => {
        const h = harness();
        const first = await h.call(args);
        expect(h.fetch.deletes()).toHaveLength(0);

        const second = await h.call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(second.structuredContent.applied).toBe(true);
        expect(h.fetch.deletes().map(d => d.path).sort()).toEqual([
            '/api/v3/queue/1036990902',
            '/api/v3/queue/693439963'
        ]);
    });

    it('removes them from the download client, which is the point', async () => {
        const h = harness();
        const first = await h.call(args);
        await h.call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(h.fetch.deletes()[0]?.query).toMatchObject({ removeFromClient: 'true' });
    });

    it('does not blocklist — the release was fine, the film was deleted', async () => {
        const h = harness();
        const first = await h.call(args);
        await h.call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(h.fetch.deletes()[0]?.query).toMatchObject({ blocklist: 'false' });
    });

    it('is a no-op when there is nothing orphaned to clean', async () => {
        const { structuredContent } = await harness([HEALTHY]).call({ ...args, dry_run: true });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    // The harness adds the prefix; a summary carrying its own doubles it.
    it('does not say "Nothing to do" twice', async () => {
        const { content } = await harness([HEALTHY]).call({ ...args, dry_run: true });
        expect(content[0]?.text).not.toMatch(/Nothing to do — Nothing to do/);
    });

    it('is destructive tier — safe_write alone is not enough', async () => {
        const h = harness(undefined, { permissions: { radarr: permissive(true, false) } });
        await expect(h.call(args)).rejects.toThrow(/services\.radarr\.permissions\.destructive: true/);
    });

    it('refuses a service with no queue', async () => {
        const jellyfin = {
            id: 'jellyfin' as ServiceId,
            type: 'jellyfin' as ServiceId,
            testConnection: () => Promise.reject(new Error('unused')),
            getVersion: () => Promise.resolve('10.8.0')
        } as unknown as ServiceAdapter;

        const h = harness(undefined, { adapters: [jellyfin], permissions: { jellyfin: permissive(true, true) } });
        await expect(h.call({ service: 'jellyfin', dry_run: true })).rejects.toThrow(/queue/i);
    });
});

/**
 * Removal used to throw on the first failure, which audited the whole write as
 * failed and told the caller nothing about the items that *had* been removed —
 * so a retry re-planned against a queue that had already changed underneath it.
 */
describe('partial removal', () => {
    const failingOn = (bad: (id: string) => boolean): ServiceAdapter => {
        const adapter = {
            id: 'radarr',
            type: 'radarr',
            getVersion: async () => '5.0.0',
            testConnection: async () => ({ ok: true, service: 'radarr', latency_ms: 1 }),
            getQueue: async () => [
                { service: 'radarr', id: 'a', title: 'A', status: 'completed', importState: 'importBlocked', orphaned: true, protocol: 'torrent' },
                { service: 'radarr', id: 'b', title: 'B', status: 'completed', importState: 'importBlocked', orphaned: true, protocol: 'torrent' }
            ],
            supportsBlocklist: true,
            removeQueueItem: async (id: string) => {
                if (bad(id)) throw new Error('gone already');
            }
        } as unknown as ServiceAdapter;
        return adapter;
    };

    it('reports how many were removed when one fails', async () => {
        const h = harness([], { adapters: [failingOn(id => id === 'b')] });
        const first = await h.call(args);
        const second = await h.call({ ...args, confirm: first.structuredContent.confirm_token });

        // The apply return travels in structuredContent.result; content[0] is
        // the plan summary the harness reports for every write.
        const result = String((second.structuredContent as { result?: unknown }).result ?? '');
        expect(result).toContain('1 of 2');
        expect(result).toContain('gone already');
    });

    it('still fails outright when nothing could be removed', async () => {
        const h = harness([], { adapters: [failingOn(() => true)] });
        const first = await h.call(args);

        await expect(h.call({ ...args, confirm: first.structuredContent.confirm_token })).rejects.toThrow(
            /none of the 2/i
        );
    });
});
