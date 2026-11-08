import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, CredentialServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildGetQueue, queueLine } from '../src/tools/getQueue.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerPauseDownloads } from '../src/tools/pauseDownloads.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Choosing which files of a torrent the client downloads.
 *
 * **Spec-derived throughout.** No fixture was captured: the shapes follow the
 * qBittorrent WebUI API (`torrents/files`, `torrents/filePrio`) and the
 * Transmission RPC spec (`files`, `fileStats`, `files-wanted`,
 * `files-unwanted`). The mocks below are inline for that reason, the way the
 * other qBittorrent write paths in `pauseDownloads.test.ts` are.
 */

const credential = (port: number): CredentialServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
});

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
});

const HASH = 'ab'.repeat(20);

type Seen = { path: string; form?: URLSearchParams };

/**
 * A qBittorrent holding one torrent with a film and its .nfo, the .nfo set to
 * "Do not download" — the state Cleanuparr's Malware Blocker leaves behind.
 * `priorities` is live, so a `filePrio` call changes what the next read sees.
 */
function qbittorrent(opts: { filesStatus?: number; prioStatus?: number; withIndex?: boolean } = {}) {
    const priorities = [1, 0];
    const seen: Seen[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const form = typeof init?.body === 'string' ? new URLSearchParams(init.body) : undefined;
        seen.push({ path: url.pathname, ...(form === undefined ? {} : { form }) });

        if (url.pathname.endsWith('/torrents/info')) {
            return jsonResponse([{ hash: HASH, name: 'Some.Film.2026', state: 'stalledUP', size: 100, amount_left: 0 }]);
        }
        if (url.pathname.endsWith('/torrents/files')) {
            if (opts.filesStatus !== undefined) return new Response('Not Found', { status: opts.filesStatus });
            const rows = [
                { name: 'Some.Film.2026/Some.Film.2026.mkv', size: 8_000_000_000, progress: 1 },
                { name: 'Some.Film.2026/Some.Film.2026.nfo', size: 4_445, progress: 1 }
            ].map((row, index) => ({ ...row, priority: priorities[index], ...(opts.withIndex === false ? {} : { index }) }));
            return jsonResponse(rows);
        }
        if (url.pathname.endsWith('/torrents/filePrio')) {
            if (opts.prioStatus !== undefined) return new Response('Conflict', { status: opts.prioStatus });
            const priority = Number(form?.get('priority'));
            for (const i of (form?.get('id') ?? '').split('|')) priorities[Number(i)] = priority;
            return new Response('', { status: 200 });
        }
        return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    return { adapter: new QbittorrentAdapter(credential(8081), impl), seen, priorities };
}

/** A Transmission holding torrent 7, whose second file is unwanted. */
function transmission() {
    const wanted = [true, false];
    const methods: { method: string; arguments?: Record<string, unknown> }[] = [];
    const impl = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; arguments?: Record<string, unknown> };
        methods.push(body);
        if (body.method === 'torrent-get') {
            const ids = body.arguments?.['ids'] as number[] | undefined;
            if (ids !== undefined && !ids.includes(7)) return jsonResponse({ result: 'success', arguments: { torrents: [] } });
            return jsonResponse({
                result: 'success',
                arguments: {
                    torrents: [
                        {
                            id: 7,
                            files: [
                                { name: 'Show.S01/Show.S01E01.mkv', length: 1000, bytesCompleted: 1000 },
                                { name: 'Show.S01/Show.S01.nfo', length: 10, bytesCompleted: 0 }
                            ],
                            fileStats: wanted.map(w => ({ wanted: w, priority: 0, bytesCompleted: w ? 1000 : 0 }))
                        }
                    ]
                }
            });
        }
        return jsonResponse({ result: 'success' });
    }) as unknown as typeof fetch;
    return { adapter: new TransmissionAdapter(credential(9091), impl), methods };
}

// --- adapters ------------------------------------------------------------

describe('qbittorrent files', () => {
    it('reads priority 0 as not wanted, and fences the file names', async () => {
        const { adapter } = qbittorrent();
        const files = await adapter.readTorrentFiles(HASH);

        expect(files.map(f => [f.index, f.wanted])).toEqual([
            [0, true],
            [1, false]
        ]);
        expect(files[1]?.name).toMatch(/^<<untrusted:qbittorrent\.file>>.*\.nfo<<\/untrusted>>$/);
        expect(files[1]?.sizeBytes).toBe(4_445);
    });

    it('falls back to the position when a pre-2.8.2 build sends no index', async () => {
        const { adapter } = qbittorrent({ withIndex: false });
        expect((await adapter.readTorrentFiles(HASH)).map(f => f.index)).toEqual([0, 1]);
    });

    it('names where a torrent id comes from when the hash is unknown', async () => {
        const { adapter } = qbittorrent({ filesStatus: 404 });
        await expect(adapter.readTorrentFiles(HASH)).rejects.toThrow(/no torrent with hash.*get_queue/s);
    });

    it('sends filePrio with |-separated indexes, 0 to skip and 1 to want', async () => {
        const { adapter, seen } = qbittorrent();
        await adapter.setFilesWanted(HASH, [0, 1], false);
        await adapter.setFilesWanted(HASH, [1], true);

        const calls = seen.filter(s => s.path.endsWith('/torrents/filePrio')).map(s => Object.fromEntries(s.form ?? []));
        expect(calls).toEqual([
            { hash: HASH, id: '0|1', priority: '0' },
            { hash: HASH, id: '1', priority: '1' }
        ]);
    });

    it('reads a 409 as an index the torrent does not have, or metadata not in yet', async () => {
        const { adapter } = qbittorrent({ prioStatus: 409 });
        await expect(adapter.setFilesWanted(HASH, [9], true)).rejects.toThrow(/no file at one of indexes 9.*metadata/s);
    });

    it.each(['all', `${HASH}|${'c'.repeat(40)}`])('refuses %j before qBittorrent is called', async id => {
        const { adapter, seen } = qbittorrent();
        await expect(adapter.readTorrentFiles(id)).rejects.toThrow(/info hash/);
        await expect(adapter.setFilesWanted(id, [0], true)).rejects.toThrow(/info hash/);
        expect(seen).toEqual([]);
    });
});

describe('transmission files', () => {
    it('reads the parallel files and fileStats arrays, position as index', async () => {
        const { adapter } = transmission();
        const files = await adapter.readTorrentFiles('7');

        expect(files.map(f => [f.index, f.wanted, f.progress])).toEqual([
            [0, true, 1],
            [1, false, 0]
        ]);
    });

    it('sends files-unwanted to skip and files-wanted to bring back', async () => {
        const { adapter, methods } = transmission();
        await adapter.setFilesWanted('7', [0], false);
        await adapter.setFilesWanted('7', [1], true);

        const sets = methods.filter(m => m.method === 'torrent-set').map(m => m.arguments);
        expect(sets).toEqual([
            { ids: [7], 'files-unwanted': [0] },
            { ids: [7], 'files-wanted': [1] }
        ]);
    });

    it('refuses an index the torrent does not have instead of sending it', async () => {
        // torrent-set accepts an out-of-range index without complaint.
        const { adapter, methods } = transmission();
        await expect(adapter.setFilesWanted('7', [2], true)).rejects.toThrow(/no file at index 2/);
        expect(methods.some(m => m.method === 'torrent-set')).toBe(false);
    });

    it('refuses a torrent it does not have', async () => {
        const { adapter } = transmission();
        await expect(adapter.readTorrentFiles('8')).rejects.toThrow(/no torrent with id "8"/);
    });
});

// --- get_queue -----------------------------------------------------------

describe('get_queue with an id', () => {
    it('returns that torrent alone, with its files at detail full', async () => {
        const { adapter } = qbittorrent();
        const result = await buildGetQueue([adapter], { detail: 'full', limit: 50, id: HASH.toUpperCase() });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.files?.map(f => f.wanted)).toEqual([true, false]);
        expect(queueLine(result.items[0]!)).toMatch(/2 files, not downloaded: #1 .*\.nfo/);
    });

    it('reads no files below detail full, nor for a whole queue', async () => {
        const standard = qbittorrent();
        const narrowed = await buildGetQueue([standard.adapter], { detail: 'standard', limit: 50, id: HASH });
        expect(narrowed.items[0]?.files).toBeUndefined();

        const whole = qbittorrent();
        const all = await buildGetQueue([whole.adapter], { detail: 'full', limit: 50 });
        expect(all.items[0]?.files).toBeUndefined();
        expect(whole.seen.some(s => s.path.endsWith('/torrents/files'))).toBe(false);
    });

    it('keeps the row and reports the client degraded when its files cannot be read', async () => {
        const { adapter } = qbittorrent({ filesStatus: 500 });
        const result = await buildGetQueue([adapter], { detail: 'full', limit: 50, id: HASH });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.files).toBeUndefined();
        expect(result.degraded).toContain('qbittorrent');
    });

    it('returns nothing for an id no client has', async () => {
        const { adapter } = qbittorrent();
        expect((await buildGetQueue([adapter], { detail: 'full', limit: 50, id: 'c'.repeat(40) })).items).toEqual([]);
    });
});

// --- pause_downloads -----------------------------------------------------

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(adapters: ServiceAdapter[], permissions: Partial<Record<ServiceId, AnyServiceConfig>>) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    registerPauseDownloads(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(permissions)),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );
    return (a: Record<string, unknown>) => call(a);
}

describe('pause_downloads skip_files and want_files', () => {
    const setup = () => {
        const qb = qbittorrent();
        const call = harness([qb.adapter], { qbittorrent: credential(8081) as unknown as AnyServiceConfig });
        return { qb, call };
    };

    it('previews bringing back every skipped file when `files` is omitted, and changes nothing', async () => {
        const { qb, call } = setup();
        const { structuredContent } = await call({ service: 'qbittorrent', action: 'want_files', id: HASH });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(structuredContent.summary).toMatch(/Download 1 file of torrent/);
        expect(structuredContent.effects.join(' ')).toMatch(/\.nfo/);
        expect(structuredContent.effects.join(' ')).toMatch(/already there/);
        expect(qb.priorities).toEqual([1, 0]);
    });

    it('applies exactly the indexes the preview listed once the token comes back', async () => {
        const { qb, call } = setup();
        const preview = await call({ service: 'qbittorrent', action: 'want_files', id: HASH });
        const applied = await call({
            service: 'qbittorrent',
            action: 'want_files',
            id: HASH,
            confirm: preview.structuredContent.confirm_token
        });

        expect(applied.structuredContent.applied).toBe(true);
        expect(qb.priorities).toEqual([1, 1]);
    });

    it('is a no-op for files already in the state asked for', async () => {
        const { call } = setup();
        const { structuredContent } = await call({ service: 'qbittorrent', action: 'skip_files', id: HASH, files: [1] });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    it('says what skipping costs: sharing, and the tools that link or import the file', async () => {
        const { call } = setup();
        const { structuredContent } = await call({ service: 'qbittorrent', action: 'skip_files', id: HASH, files: [0] });

        expect(structuredContent.effects.join(' ')).toMatch(/cross-seed/);
        expect(structuredContent.effects.join(' ')).toMatch(/Deletes nothing on disk/);
    });

    it('names the valid range for an index the torrent does not have', async () => {
        const { call } = setup();
        await expect(call({ service: 'qbittorrent', action: 'want_files', id: HASH, files: [5] })).rejects.toThrow(
            /no file at index 5.*indexed 0 to 1/s
        );
    });

    it('needs an id, and skip_files needs files', async () => {
        const { call } = setup();
        await expect(call({ service: 'qbittorrent', action: 'want_files' })).rejects.toThrow(/`id`/);
        await expect(call({ service: 'qbittorrent', action: 'skip_files', id: HASH })).rejects.toThrow(/needs `files`/);
    });

    it('refuses a usenet client, naming the torrent clients', async () => {
        const sab = new SabnzbdAdapter(keyed(8080), (async () => jsonResponse({ status: true })) as unknown as typeof fetch);
        const call = harness([sab], { sabnzbd: keyed(8080) as unknown as AnyServiceConfig });
        await expect(call({ service: 'sabnzbd', action: 'want_files', id: 'SABnzbd_nzo_1' })).rejects.toThrow(
            /transmission and qbittorrent/
        );
    });
});
