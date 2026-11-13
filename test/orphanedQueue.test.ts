import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerRemoveQueueItem } from '../src/tools/removeQueueItem.ts';
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
    trackedDownloadState: 'importBlocked',
    downloadId: 'AAA111'
};
const BLOCKED_B = {
    id: 1036990902,
    title: 'Summerween.2026.1080p-BobDobbs',
    status: 'completed',
    trackedDownloadState: 'importBlocked',
    downloadId: 'BBB222'
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

function baseHarness(records: unknown[] = [BLOCKED_A, BLOCKED_B, ORPHAN_DOWNLOADING, HEALTHY, BLOCKED_LINKED], opts: { permissions?: Partial<Record<ServiceId, AnyServiceConfig>>; adapters?: ServiceAdapter[]; tool?: string } = {}) {
    const fetch = recordingFetch(records);
    const adapters = opts.adapters ?? [new RadarrAdapter(keyed(7878), fetch.impl)];

    const calls = new Map<string, Call>();
    const server = {
        registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            calls.set(name, args => handler(config.inputSchema.parse(args) as Record<string, unknown>));
        }
    };

    const context = {
        permissions: permissionSourceFrom(instancesOf(opts.permissions ?? { radarr: permissive(true, true) })),
        confirm: new ConfirmTokens(),
        audit: WriteAudit.ephemeral(),
        library: { invalidate: vi.fn() } as unknown as LibraryLoader
    };
    registerRemoveQueueItem(server as never, context, adapters);

    const tool = opts.tool ?? 'remove_queue_item';
    const callTool = (name: string, args: Record<string, unknown>) => (calls.get(name) ?? (() => Promise.reject(new Error('not registered'))))(args);
    return { call: (args: Record<string, unknown>) => callTool(tool, args), callTool, fetch };
}


/**
 * `orphaned: true` lists and never removes. The *arrs delete a film's or
 * series' history with it, so nothing tells a download whose media was
 * deleted from one they never matched (a title mismatch, one added by hand),
 * and removing the second deletes data `import_download` could still import.
 */
describe('remove_queue_item orphaned: true lists', () => {
    const args = { service: 'radarr', orphaned: true };
    const harness = (records?: unknown[], opts: Parameters<typeof baseHarness>[1] = {}) => baseHarness(records, opts);
    type Steps = { next_steps?: { tool: string; arguments: Record<string, unknown>; why: string }[] };

    it('lists only the orphaned items that are import-blocked, with their ids', async () => {
        const { structuredContent } = await harness().call(args);
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toContain('2');
        const effects = structuredContent.effects.join(' ');
        expect(effects).toContain('Good.Boy');
        expect(effects).toContain('693439963');
        expect(effects).toContain('Summerween');
        expect(effects).not.toMatch(/Lawless|Still\.Here|Some\.Film/);
    });

    it('issues no confirmation token and removes nothing, even when confirmed', async () => {
        const h = harness();
        const first = await h.call(args);
        expect(first.structuredContent.confirm_token).toBeUndefined();
        const single = await h.call({ service: 'radarr', id: '5' });
        const again = await h.call({ ...args, confirm: single.structuredContent.confirm_token });
        expect(again.structuredContent.applied).toBe(false);
        expect(h.fetch.deletes()).toHaveLength(0);
    });

    it('offers, per row, the import with a mapping and the removal by id', async () => {
        const { structuredContent, content } = await harness().call(args);
        expect((structuredContent as WriteToolResult & Steps).next_steps).toEqual([
            expect.objectContaining({ tool: 'import_download', arguments: { service: 'radarr', action: 'import', download_id: 'AAA111' }, why: expect.stringContaining('`mapping`') }),
            expect.objectContaining({ tool: 'remove_queue_item', arguments: { service: 'radarr', id: '693439963' } }),
            expect.objectContaining({ tool: 'import_download', arguments: { service: 'radarr', action: 'import', download_id: 'BBB222' } }),
            expect.objectContaining({ tool: 'remove_queue_item', arguments: { service: 'radarr', id: '1036990902' } })
        ]);
        // A client that drops structuredContent still sees the rows and the steps.
        const text = content[0]?.text ?? '';
        expect(text).toContain('Good.Boy');
        expect(text).toContain('Next: remove_queue_item {"service":"radarr","id":"693439963"}');
        expect(text).not.toMatch(/^Nothing to do/);
    });

    it('does not claim the media is gone', async () => {
        const { structuredContent } = await harness().call(args);
        const said = [structuredContent.summary, ...structuredContent.effects].join(' ');
        expect(said).toContain('deleted, or never matched');
        expect(said).not.toMatch(/no media behind it|is gone/);
    });

    it('is a plain no-op when there is nothing orphaned', async () => {
        const { structuredContent, content } = await harness([HEALTHY]).call({ ...args, dry_run: true });
        expect(structuredContent.noop).toBe(true);
        // The Lidarr version note is Lidarr's alone.
        expect(structuredContent.summary).not.toContain('2.10.1');
        expect(structuredContent.confirm_token).toBeUndefined();
        expect((structuredContent as WriteToolResult & Steps).next_steps).toBeUndefined();
        expect(content[0]?.text).not.toMatch(/Nothing to do: Nothing to do/);
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

/** Lidarr marks a row orphaned when it matched no artist, as Radarr and Sonarr do for a film or series. */
describe('remove_queue_item orphaned: true on lidarr', () => {
    const ALBUM_BLOCKED = { id: 211, title: 'Deleted.Artist-Album-FLAC', status: 'completed', trackedDownloadState: 'importBlocked', downloadId: 'CCC333' };
    const ALBUM_DOWNLOADING = { id: 212, title: 'Gone.Artist-Live-MP3', status: 'downloading', trackedDownloadState: 'downloading' };
    const ALBUM_LINKED = { id: 213, title: 'Kept.Artist-Album-FLAC', status: 'completed', artistId: 12, trackedDownloadState: 'importBlocked' };
    /** Orphaned but already imported, the shape a deleted artist's finished downloads took live on 2.1.3. */
    const ALBUM_IMPORTED = { id: 214, title: 'Done.Artist-Album-FLAC', status: 'completed', trackedDownloadState: 'imported' };
    /** Finished, orphaned and stuck, but on Lidarr before 2.10.1, which never sets `importBlocked`: seen live on 2.1.3. */
    const ALBUM_PRE_2_10_1 = { id: 215, title: 'Older.Artist-Album-FLAC', status: 'completed', trackedDownloadState: 'downloading', trackedDownloadStatus: 'warning' };
    const args = { service: 'lidarr', orphaned: true };

    const lidarrHarness = (records: unknown[] = [ALBUM_BLOCKED, ALBUM_DOWNLOADING, ALBUM_LINKED, ALBUM_IMPORTED, ALBUM_PRE_2_10_1]) => {
        const fetch = recordingFetch(records);
        const h = baseHarness([], {
            adapters: [new LidarrAdapter(keyed(8686) as never, fetch.impl)],
            permissions: { lidarr: permissive(true, true) }
        });
        return { call: h.call, fetch };
    };

    it('asks Lidarr for the unknown-artist items it hides by default', async () => {
        const h = lidarrHarness();
        await h.call({ ...args, dry_run: true });
        const read = h.fetch.sent.find(s => s.method === 'GET' && s.path === '/api/v1/queue');
        expect(read?.query).toMatchObject({ includeUnknownArtistItems: 'true' });
    });

    it('lists only the import-blocked album, offers removal by id and no import, and removes nothing', async () => {
        const h = lidarrHarness();
        const { structuredContent } = await h.call(args);
        const effects = structuredContent.effects.join(' ');
        expect(effects).toContain('Deleted.Artist');
        expect(effects).not.toMatch(/Gone\.Artist|Kept\.Artist|Done\.Artist|Older\.Artist/);
        // Lidarr's import_download takes no mapping, so the import is Lidarr's own.
        expect(effects).not.toContain('mapping');
        expect(structuredContent.summary).toContain('by hand in lidarr');
        expect((structuredContent as { next_steps?: unknown }).next_steps).toEqual([
            expect.objectContaining({ tool: 'remove_queue_item', arguments: { service: 'lidarr', id: '211' } })
        ]);
        expect(h.fetch.deletes()).toHaveLength(0);
    });

    it('says, when there is nothing to list, that Lidarr before 2.10.1 never marks a download importBlocked', async () => {
        const h = lidarrHarness([ALBUM_PRE_2_10_1]);
        const { structuredContent, content } = await h.call({ ...args, dry_run: true });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toMatch(/before 2\.10\.1 never marks one importBlocked/);
        expect(structuredContent.summary).toContain('matched to nothing in the library (deleted, or never matched)');
        expect(content[0]?.text).toContain('remove_queue_item with its `id`');
    });
});

describe('remove_queue_item orphaned arguments', () => {
    const remove = (records?: unknown[], opts: Parameters<typeof baseHarness>[1] = {}) => baseHarness(records, opts);

    it('binds the listing to the orphaned target', async () => {
        const viaRemove = await remove().call({ service: 'radarr', orphaned: true, dry_run: true });
        expect(viaRemove.structuredContent.target).toBe('radarr:orphaned');
    });

    it('refuses an id with orphaned, naming the other', async () => {
        const h = remove();
        await expect(h.call({ service: 'radarr', orphaned: true, id: '5', dry_run: true })).rejects.toThrow(/`id` or `orphaned: true`, not both/);
        expect(h.fetch.sent).toHaveLength(0);
    });

    it('refuses neither id nor orphaned', async () => {
        const h = remove();
        await expect(h.call({ service: 'radarr', dry_run: true })).rejects.toThrow(/`orphaned: true`/);
        expect(h.fetch.sent).toHaveLength(0);
    });

    it.each([{ remove_from_client: false }, { remove_from_client: true }, { blocklist: true }])('refuses %o with orphaned, before any read', async extra => {
        const h = remove();
        await expect(h.call({ service: 'radarr', orphaned: true, ...extra, dry_run: true })).rejects.toThrow(/only lists/);
        expect(h.fetch.sent).toHaveLength(0);
    });

    it('refuses a download client with orphaned, before any read', async () => {
        const qbit = {
            id: 'qbittorrent',
            type: 'qbittorrent',
            getVersion: async () => '5.0.0',
            getQueue: vi.fn(async () => []),
            removeQueueItem: vi.fn()
        } as unknown as ServiceAdapter;
        const h = remove(undefined, { adapters: [qbit], permissions: { qbittorrent: permissive(true, true) } });
        await expect(h.call({ service: 'qbittorrent', orphaned: true, dry_run: true })).rejects.toThrow(/Radarr, Sonarr, Whisparr and Lidarr only/);
        expect((qbit as unknown as { getQueue: ReturnType<typeof vi.fn> }).getQueue).not.toHaveBeenCalled();
    });
});
