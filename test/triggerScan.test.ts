import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, MultiUserServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { ProwlarrAdapter } from '../src/services/prowlarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerTriggerScan } from '../src/tools/triggerScan.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * The write `diagnose` was missing. Until 1.0 it could report that a library
 * had not been scanned and nothing here could start one, so its best answer
 * ended "now go and do it yourself".
 */

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const multiUser = (port: number): MultiUserServiceConfig => ({ ...keyed(port), allow_other_users: false });

const permissive = (safe_write: boolean, destructive = false): AnyServiceConfig =>
    ({ ...keyed(7878), permissions: { safe_write, destructive } }) as AnyServiceConfig;

function recordingFetch(routes: Record<string, unknown>) {
    const sent: { url: string; method: string }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({ url: url.pathname, method: init?.method ?? 'GET' });
        if (url.pathname in routes) return jsonResponse(routes[url.pathname]);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

/** Jellyfin's ids are per-install GUIDs, so the task is found by `Key`. */
const TASKS = [
    { Id: 'guid-1', Key: 'SomethingElse', Name: 'Other', State: 'Idle' },
    { Id: 'guid-scan', Key: 'RefreshLibrary', Name: 'Mediabibliotheek scannen', State: 'Idle' }
];

describe('JellyfinAdapter.startLibraryScan', () => {
    it('finds the task by key, not by its localised name', async () => {
        const { impl, sent } = recordingFetch({
            '/ScheduledTasks': TASKS,
            '/ScheduledTasks/Running/guid-scan': {}
        });

        await new JellyfinAdapter(multiUser(8096), impl).startLibraryScan();

        const post = sent.find(s => s.method === 'POST');
        expect(post?.url).toBe('/ScheduledTasks/Running/guid-scan');
    });

    it('accepts the empty 204 a started scan actually answers with', async () => {
        // Every other case here stubs the POST with `{}`, a JSON body the real
        // service never sends. Parsing the empty one failed *after* the scan
        // had started, so the tool reported failure for work already underway
        // and invited a retry that would start it again.
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/ScheduledTasks') return jsonResponse(TASKS);
            return new Response(null, { status: 204 });
        }) as unknown as typeof fetch;

        await expect(new JellyfinAdapter(multiUser(8096), impl).startLibraryScan()).resolves.toMatchObject({
            status: 'started'
        });
    });

    /** The name is localised — a Dutch install returns "Mediabibliotheek
     *  scannen" — so matching on it would work only in English. */
    it('does not post when no task carries the key', async () => {
        const { impl, sent } = recordingFetch({ '/ScheduledTasks': [TASKS[0]] });

        await expect(new JellyfinAdapter(multiUser(8096), impl).startLibraryScan()).rejects.toThrow(/scan task/i);
        expect(sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });
});

describe('RadarrAdapter.startLibraryScan', () => {
    it('queues the same command getScanState reads the last run of', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/command': { id: 12, name: 'RefreshMovie' } });
        const handle = await new RadarrAdapter(keyed(7878), impl).startLibraryScan();

        expect(sent.find(s => s.method === 'POST')?.url).toBe('/api/v3/command');
        expect(handle).toMatchObject({ service: 'radarr', commandId: 12, name: 'RefreshMovie' });
    });
});

// --- the tool ------------------------------------------------------------

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: { permissions?: Partial<Record<ServiceId, AnyServiceConfig>>; adapters?: ServiceAdapter[] } = {}) {
    const jellyfin = recordingFetch({
        '/ScheduledTasks': TASKS,
        '/ScheduledTasks/Running/guid-scan': {}
    });
    const prowlarr = recordingFetch({});

    const adapters = opts.adapters ?? [
        new JellyfinAdapter(multiUser(8096), jellyfin.impl),
        new ProwlarrAdapter(keyed(9696), prowlarr.impl)
    ];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_name: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    registerTriggerScan(
        server as never,
        {
            permissions: permissionSourceFrom(
                instancesOf(opts.permissions ?? { jellyfin: permissive(true), prowlarr: permissive(true) })
            ),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (args: Record<string, unknown>) => call(args), jellyfin };
}

describe('trigger_scan', () => {
    it('previews without scanning, and hands back a token', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'jellyfin' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(h.jellyfin.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    /**
     * `dry_run: true` is a different question from an unconfirmed call: it is
     * "tell me what this would do", not "let me do it". So it issues no token,
     * and a caller who only wanted to look cannot accidentally hold one.
     */
    it('issues no token for an explicit dry run', async () => {
        const { structuredContent } = await harness().call({ service: 'jellyfin', dry_run: true });

        expect(structuredContent.dry_run).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    it('says in the preview that it runs in the background', async () => {
        const { structuredContent } = await harness().call({ service: 'jellyfin', dry_run: true });
        expect(structuredContent.effects?.join(' ')).toMatch(/background|minutes/i);
    });

    it('scans once confirmed', async () => {
        const h = harness();
        const preview = await h.call({ service: 'jellyfin' });

        await h.call({ service: 'jellyfin', confirm: preview.structuredContent.confirm_token });
        expect(h.jellyfin.sent.filter(s => s.method === 'POST')).toHaveLength(1);
    });

    /**
     * Safe, not destructive: a scan reads the filesystem and updates a
     * database. Nothing is deleted and nothing is grabbed, so running one you
     * did not need costs time rather than data.
     */
    it('needs safe_write, and nothing more', async () => {
        const denied = await harness({ permissions: { jellyfin: permissive(false) } }).call({
            service: 'jellyfin',
            dry_run: true
        });
        expect(denied.structuredContent.applied).toBe(false);

        const allowed = await harness({ permissions: { jellyfin: permissive(true, false) } }).call({
            service: 'jellyfin'
        });
        expect(allowed.structuredContent.confirm_token).toBeDefined();
    });

    /**
     * Refused rather than accepted as a no-op. An indexer has no library, and
     * reporting success for something that could never happen is how a model
     * concludes the scan is done and stops looking.
     */
    it('refuses a service with no library to scan', async () => {
        await expect(harness().call({ service: 'prowlarr', dry_run: true })).rejects.toThrow(/no library/i);
    });
});

/**
 * "It downloaded but Jellyfin cannot see it" has more than one cause, and
 * until now the only follow-up write was a whole-library scan. These are the
 * other two: re-read one item, and rename its files to the naming scheme.
 */
describe('trigger_scan on a single item', () => {
    const arrRoutes = () => ({
        '/api/v3/movie/15': { id: 15, title: 'Heat', year: 1995 },
        '/api/v3/command': { id: 77, name: 'RefreshMovie', status: 'queued' }
    });

    const radarrHarness = () => {
        const radarr = recordingFetch(arrRoutes());
        return {
            ...harness({
                adapters: [new RadarrAdapter(keyed(7878), radarr.impl)],
                permissions: { radarr: permissive(true) }
            }),
            radarr
        };
    };

    const bodies = (impl: ReturnType<typeof recordingFetch>) =>
        impl.sent.filter(x => x.method === 'POST').map(x => x.url);

    it('refreshes one movie rather than the whole library', async () => {
        const h = radarrHarness();
        const first = await h.call({ service: 'radarr', id: '15' });
        await h.call({ service: 'radarr', id: '15', confirm: first.structuredContent.confirm_token });
        expect(bodies(h.radarr)).toContain('/api/v3/command');
    });

    it('names the title in the preview rather than a bare id', async () => {
        const h = radarrHarness();
        const { structuredContent } = await h.call({ service: 'radarr', id: '15', dry_run: true });
        expect(structuredContent.summary).toContain('Heat');
    });

    it('says a rename moves files on disk', async () => {
        const h = radarrHarness();
        const { structuredContent } = await h.call({
            service: 'radarr',
            id: '15',
            action: 'rename',
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toMatch(/renames/i);
    });

    it('refuses a rename with no id — there is no "rename the library"', async () => {
        const h = radarrHarness();
        await expect(h.call({ service: 'radarr', action: 'rename', dry_run: true })).rejects.toThrow(/id/i);
    });

    it('refuses an id on a service that cannot describe one item', async () => {
        const h = harness();
        await expect(h.call({ service: 'jellyfin', id: '15', dry_run: true })).rejects.toThrow(/radarr|sonarr/i);
    });

    it('still scans the whole library when no id is given', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'jellyfin', dry_run: true });
        expect(structuredContent.summary).toMatch(/rescan its library/i);
    });
});
