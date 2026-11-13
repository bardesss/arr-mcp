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

/** `remove_queue_item` with `orphaned: true`. */
const TOOLS = [['remove_queue_item', { service: 'radarr', orphaned: true }, { service: 'lidarr', orphaned: true }]] as const;

describe.each(TOOLS)('%s cleaning orphans', (tool, args) => {
    const harness = (records?: unknown[], opts: Parameters<typeof baseHarness>[1] = {}) => baseHarness(records, { ...opts, tool });

    it('previews only the orphaned items that are import-blocked', async () => {
        const { structuredContent } = await harness().call({ ...args, dry_run: true });
        expect(structuredContent.summary).toContain('2');
        expect(structuredContent.effects.join(' ')).toContain('Good.Boy');
        expect(structuredContent.effects.join(' ')).toContain('Summerween');
    });

    // A release the *arr never matched sits in the same state as deleted media.
    it('words each row as matched to nothing, deleted or never matched, and names the rescue', async () => {
        const { structuredContent } = await harness().call({ ...args, dry_run: true });
        const effects = structuredContent.effects.join(' ');
        expect(structuredContent.effects[0]).toBe('<<untrusted:radarr.title>>Good.Boy.2025.1080p-SPHD<</>>: completed/importBlocked, matched to nothing in the library: deleted, or never matched.');
        expect(effects).not.toMatch(/no media behind it|is gone/);
        expect(effects).toContain('import_download with a `mapping` can still import one that was never matched.');
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
        // The Lidarr version note is Lidarr's alone.
        expect(structuredContent.summary).not.toContain('2.10.1');
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
describe.each(TOOLS)('%s partial removal', (tool, args) => {
    const harness = (records?: unknown[], opts: Parameters<typeof baseHarness>[1] = {}) => baseHarness(records, { ...opts, tool });
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

        const result = String((second.structuredContent as { result?: unknown }).result ?? '');
        expect(result).toContain('1 of 2');
        expect(result).toContain('gone already');
        expect(second.content[0]?.text).toContain('1 of 2');
        expect(second.content[0]?.text).not.toMatch(/^Applied\./);
        // The summary beside `applied: true` says what happened, not what was asked.
        expect(second.structuredContent.summary).toContain('1 of 2');
    });

    it('still fails outright when nothing could be removed', async () => {
        const h = harness([], { adapters: [failingOn(() => true)] });
        const first = await h.call(args);

        await expect(h.call({ ...args, confirm: first.structuredContent.confirm_token })).rejects.toThrow(
            /none of the 2/i
        );
    });
});

/** Lidarr marks a row orphaned when its artist is gone, as Radarr and Sonarr do for a film or series. */
describe.each(TOOLS)('%s on lidarr', (tool, _args, lidarrArgs) => {
    const harness = (records?: unknown[], opts: Parameters<typeof baseHarness>[1] = {}) => baseHarness(records, { ...opts, tool });
    const ALBUM_BLOCKED = { id: 211, title: 'Deleted.Artist-Album-FLAC', status: 'completed', trackedDownloadState: 'importBlocked' };
    const ALBUM_DOWNLOADING = { id: 212, title: 'Gone.Artist-Live-MP3', status: 'downloading', trackedDownloadState: 'downloading' };
    const ALBUM_LINKED = { id: 213, title: 'Kept.Artist-Album-FLAC', status: 'completed', artistId: 12, trackedDownloadState: 'importBlocked' };
    /** Orphaned but already imported, the shape a deleted artist's finished downloads took live on 2.1.3. */
    const ALBUM_IMPORTED = { id: 214, title: 'Done.Artist-Album-FLAC', status: 'completed', trackedDownloadState: 'imported' };
    /**
     * Finished, orphaned and stuck, but on Lidarr before 2.10.1, which never
     * sets `importBlocked`: seen live on 2.1.3. The rule does not stretch to
     * cover it; `remove_queue_item` is the route, and the tool says so.
     */
    const ALBUM_PRE_2_10_1 = { id: 215, title: 'Older.Artist-Album-FLAC', status: 'completed', trackedDownloadState: 'downloading', trackedDownloadStatus: 'warning' };

    const lidarrHarness = () => {
        const fetch = recordingFetch([ALBUM_BLOCKED, ALBUM_DOWNLOADING, ALBUM_LINKED, ALBUM_IMPORTED, ALBUM_PRE_2_10_1]);
        const h = harness([], {
            adapters: [new LidarrAdapter(keyed(8686) as never, fetch.impl)],
            permissions: { lidarr: permissive(true, true) }
        });
        return { call: h.call, fetch };
    };

    it('asks Lidarr for the unknown-artist items it hides by default', async () => {
        const h = lidarrHarness();
        await h.call({ ...lidarrArgs, dry_run: true });

        const read = h.fetch.sent.find(s => s.method === 'GET' && s.path === '/api/v1/queue');
        expect(read?.query).toMatchObject({ includeUnknownArtistItems: 'true' });
    });

    it('removes only the import-blocked album whose artist is gone, from the client, without blocklisting', async () => {
        const h = lidarrHarness();
        const first = await h.call(lidarrArgs);
        const effects = first.structuredContent.effects.join(' ');

        expect(effects).toContain('Deleted.Artist');
        // Lidarr's import_download takes no mapping, so the rescue is Lidarr's own.
        expect(effects).not.toContain('mapping');
        expect(effects).toContain('can still be imported by hand in lidarr.');
        expect(effects).not.toContain('Gone.Artist');
        expect(effects).not.toContain('Kept.Artist');
        expect(effects).not.toContain('Done.Artist');
        expect(effects).not.toContain('Older.Artist');
        expect(h.fetch.deletes()).toHaveLength(0);

        await h.call({ ...lidarrArgs, confirm: first.structuredContent.confirm_token });

        expect(h.fetch.deletes().map(d => d.path)).toEqual(['/api/v1/queue/211']);
        expect(h.fetch.deletes()[0]?.query).toMatchObject({ removeFromClient: 'true', blocklist: 'false' });
    });

    it('says, when there is nothing to clean, that Lidarr before 2.10.1 never marks a download importBlocked', async () => {
        const fetch = recordingFetch([ALBUM_PRE_2_10_1]);
        const h = harness([], {
            adapters: [new LidarrAdapter(keyed(8686) as never, fetch.impl)],
            permissions: { lidarr: permissive(true, true) }
        });
        const { structuredContent, content } = await h.call({ ...lidarrArgs, dry_run: true });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toMatch(/before 2\.10\.1 never marks one importBlocked/);
        expect(content[0]?.text).toContain('remove_queue_item with its `id`');
    });
});

describe('remove_queue_item orphaned', () => {
    const remove = (records?: unknown[], opts: Parameters<typeof baseHarness>[1] = {}) => baseHarness(records, { ...opts, tool: 'remove_queue_item' });

    it('binds the preview to the orphaned target', async () => {
        const viaRemove = await remove().call({ service: 'radarr', orphaned: true, dry_run: true });
        expect(viaRemove.structuredContent.target).toBe('radarr:orphaned');
    });

    it('refuses remove_from_client: false with orphaned, before any read', async () => {
        const h = remove();
        await expect(h.call({ service: 'radarr', orphaned: true, remove_from_client: false, dry_run: true })).rejects.toThrow(/cannot leave it alone/);
        expect(h.fetch.sent).toHaveLength(0);
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

    it('refuses blocklist: true with orphaned, before any read', async () => {
        const h = remove();
        await expect(h.call({ service: 'radarr', orphaned: true, blocklist: true, dry_run: true })).rejects.toThrow(/never blocklists/);
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

    // One ConfirmTokens serves every tool, so a token must not carry from one
    // kind of removal to another: each confirm is a fresh preview, not a delete.
    describe('confirm tokens do not cross', () => {
        const refused = (r: { structuredContent: WriteToolResult }) => {
            expect(r.structuredContent.applied).not.toBe(true);
            expect(r.structuredContent.confirm_token).toBeDefined();
        };

        it('a single-id token sent with orphaned', async () => {
            const h = remove();
            const first = await h.call({ service: 'radarr', id: '5' });
            refused(await h.call({ service: 'radarr', orphaned: true, confirm: first.structuredContent.confirm_token }));
            expect(h.fetch.deletes()).toHaveLength(0);
        });

        it('an orphaned token sent with an id', async () => {
            const h = remove();
            const first = await h.call({ service: 'radarr', orphaned: true });
            refused(await h.call({ service: 'radarr', id: '5', confirm: first.structuredContent.confirm_token }));
            expect(h.fetch.deletes()).toHaveLength(0);
        });
    });
});
