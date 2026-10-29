import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import {
    hasCommandStatus,
    hasLibraryMaintenance,
    hasLibraryScan,
    hasManualImport,
    type ServiceAdapter
} from '../src/services/types.ts';
import { registerTriggerScan } from '../src/tools/triggerScan.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * `trigger_scan` on Lidarr: rescan the library or one artist, rename an
 * artist's files, import a finished download by its id, and follow the
 * command in `get_stack_health`. All through the shared helpers with
 * `resource: 'artist'`. The import rows follow `ManualImportResource`
 * (Lidarr 3.1.0) and are invented.
 */

const config: KeyedServiceConfig = {
    url: 'http://192.0.2.10:8686',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
};

type Sent = { method: string; path: string; query: URLSearchParams; body: unknown };

function lidarr(answer: (s: Sent) => unknown) {
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const s: Sent = {
            method: init?.method ?? 'GET',
            path: url.pathname,
            query: url.searchParams,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
        };
        sent.push(s);
        const out = answer(s);
        if (out instanceof Response) return out;
        if (out === undefined) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { adapter: new LidarrAdapter(config, impl), sent };
}

const COMMAND = (name: string) => ({ id: 41, name, status: 'queued' });

const ROWS = [
    { name: 'no path' },
    {
        path: '/dl/a/01.flac',
        name: '01.flac',
        size: 100,
        artist: { id: 3, artistName: 'Some Artist' },
        album: { id: 31, title: 'First' },
        albumReleaseId: 310,
        tracks: [{ id: 901 }],
        quality: { quality: { id: 1 } },
        rejections: []
    },
    {
        path: '/dl/a/02.flac',
        artist: { id: 3, artistName: 'Some Artist' },
        album: { id: 31, title: 'First' },
        albumReleaseId: 310,
        tracks: [],
        rejections: []
    },
    { path: '/dl/a/03.flac', artist: { id: 3 }, albumReleaseId: 0, tracks: [{ id: 903 }], rejections: [] },
    {
        path: '/dl/a/04.flac',
        artist: { id: 3, artistName: 'Some Artist' },
        album: { id: 31, title: 'First' },
        albumReleaseId: 310,
        tracks: [{ id: 904 }],
        rejections: [{ reason: 'Not an upgrade' }]
    },
    /** Lidarr reports a file it matched to no release as `albumReleaseId: 0`; `ManualImport` would fail on it. */
    {
        path: '/dl/a/05.flac',
        artist: { id: 3, artistName: 'Some Artist' },
        album: { id: 31, title: 'First' },
        albumReleaseId: 0,
        tracks: [{ id: 905 }],
        rejections: []
    }
];

/** Lidarr's queue is read before its candidates; a finished download is the one stuck at import. */
const QUEUE = (status: string) => ({
    totalRecords: 1,
    records: [{ id: 7, status, downloadId: 'nzo-1', artistId: 3, trackedDownloadState: status }]
});

const importing = (rows: unknown[] = ROWS) =>
    lidarr(s => {
        if (s.path === '/api/v1/queue') return QUEUE('completed');
        if (s.path === '/api/v1/manualimport' && s.method === 'GET') return rows;
        if (s.path === '/api/v1/command' && s.method === 'POST') return COMMAND('ManualImport');
        return undefined;
    });

describe('Lidarr scans and renames', () => {
    it('claims the four trigger_scan capabilities', () => {
        const { adapter } = lidarr(() => undefined);
        expect(hasLibraryScan(adapter)).toBe(true);
        expect(hasLibraryMaintenance(adapter)).toBe(true);
        expect(hasManualImport(adapter)).toBe(true);
        expect(hasCommandStatus(adapter)).toBe(true);
    });

    it('queues RefreshArtist on /api/v1 for a whole-library scan', async () => {
        const { adapter, sent } = lidarr(s => (s.path === '/api/v1/command' ? COMMAND('RefreshArtist') : undefined));

        await expect(adapter.startLibraryScan()).resolves.toMatchObject({
            service: 'lidarr',
            commandId: 41,
            name: 'RefreshArtist',
            status: 'queued'
        });
        expect(sent).toMatchObject([{ method: 'POST', path: '/api/v1/command', body: { name: 'RefreshArtist' } }]);
    });

    it('refreshes and renames one artist through artistIds', async () => {
        const { adapter, sent } = lidarr(s => (s.path === '/api/v1/command' ? COMMAND('x') : undefined));

        await adapter.refreshItem('3');
        await adapter.renameItem('3');

        expect(sent.map(s => s.body)).toEqual([
            { name: 'RefreshArtist', artistIds: [3] },
            { name: 'RenameArtist', artistIds: [3] }
        ]);
    });

    it('refuses an id that is not an artist id before asking Lidarr anything', async () => {
        const { adapter, sent } = lidarr(() => COMMAND('x'));

        await expect(adapter.refreshItem('abc')).rejects.toMatchObject({ service: 'lidarr' });
        await expect(adapter.renameItem('0')).rejects.toMatchObject({ service: 'lidarr' });
        expect(sent).toEqual([]);
    });

    /** `get_stack_health` follows only the commands this server can start, so Lidarr's two must be on that list. */
    it('reports its own refresh and rename commands, and not the per-minute pollers', async () => {
        // Relative to the real clock: the adapter reads `Date.now()` itself.
        const now = Date.now();
        const { adapter } = lidarr(s =>
            s.path === '/api/v1/command'
                ? [
                      { id: 1, name: 'RefreshArtist', status: 'started', queued: '2024-01-01T11:59:00Z' },
                      { id: 2, name: 'RenameArtist', status: 'queued', queued: '2024-01-01T11:59:30Z' },
                      { id: 3, name: 'RefreshMonitoredDownloads', status: 'started', queued: '2024-01-01T11:59:50Z' },
                      { id: 4, name: 'ManualImport', status: 'completed', queued: new Date(now - 120_000).toISOString(), ended: new Date(now - 60_000).toISOString() },
                      { id: 5, name: 'RefreshArtist', status: 'completed', queued: '2024-01-01T00:00:00Z', ended: '2024-01-01T00:10:00Z' }
                  ]
                : undefined
        );

        const commands = await adapter.listCommands();

        expect(commands.map(c => c.commandId).sort()).toEqual([1, 2, 4]);
    });
});

describe('Lidarr import by download id', () => {
    /** Lidarr's read defaults `replaceExistingFiles` to true, which this tool never wants. */
    it('reads the candidates without letting them replace library files', async () => {
        const { adapter, sent } = importing();

        await adapter.listImportCandidates('nzo-1');

        const read = sent.find(s => s.path === '/api/v1/manualimport');
        expect(Object.fromEntries(read!.query)).toEqual({
            downloadId: 'nzo-1',
            filterExistingFiles: 'true',
            replaceExistingFiles: 'false'
        });
    });

    it('names each file by artist and album, and says why one cannot be imported', async () => {
        const { adapter } = importing();

        const candidates = await adapter.listImportCandidates('nzo-1');

        expect(candidates.map(c => c.path)).toEqual(['/dl/a/01.flac', '/dl/a/02.flac', '/dl/a/03.flac', '/dl/a/04.flac', '/dl/a/05.flac']);
        expect(candidates[0]).toMatchObject({ matchedId: 3, sizeBytes: 100, rejections: [] });
        expect(unfenced(candidates[0]?.matchedTitle ?? '')).toBe('Some Artist — First');
        expect(candidates[1]?.rejections).toEqual(['no track matched']);
        expect(candidates[2]?.rejections).toEqual(['no album matched', 'no release matched']);
        expect(candidates[3]?.rejections.map(unfenced)).toEqual(['Not an upgrade']);
        expect(candidates[3]?.episodeIds).toBeUndefined();
        expect(candidates[4]?.rejections).toEqual(['no release matched']);
    });

    it('imports only the clean files, with their own album, release and track ids', async () => {
        const { adapter, sent } = importing();

        await adapter.runManualImport('nzo-1');

        const post = sent.find(s => s.method === 'POST');
        expect(post?.path).toBe('/api/v1/command');
        expect(post?.body).toEqual({
            name: 'ManualImport',
            importMode: 'auto',
            replaceExistingFiles: false,
            files: [
                {
                    path: '/dl/a/01.flac',
                    artistId: 3,
                    albumId: 31,
                    albumReleaseId: 310,
                    trackIds: [901],
                    quality: { quality: { id: 1 } },
                    downloadId: 'nzo-1',
                    disableReleaseSwitching: false
                }
            ]
        });
    });

    it('refuses to post when nothing is importable, and names the reasons', async () => {
        const { adapter, sent } = importing(ROWS.slice(2));

        await expect(adapter.runManualImport('nzo-1')).rejects.toMatchObject({
            message: expect.stringMatching(/will not import anything/),
            remedy: expect.stringMatching(/no track matched/)
        });
        expect(sent.filter(s => s.method === 'POST')).toEqual([]);
    });

    it('refuses a mapping before asking Lidarr anything, rather than ignoring it', async () => {
        const { adapter, sent } = importing();
        const mapping = [{ path: '01.flac', movieId: 42 }];

        await expect(adapter.listImportCandidates('nzo-1', mapping)).rejects.toThrow(/does not take a `mapping`/);
        await expect(adapter.runManualImport('nzo-1', mapping)).rejects.toThrow(/does not take a `mapping`/);
        expect(sent).toEqual([]);
    });

    /**
     * Lidarr lists an unfinished torrent's partial files rather than failing
     * the read, so its own queue is asked first, and nothing is read or posted.
     */
    it('refuses a download that has not finished, from Lidarr\'s own queue, before reading its files', async () => {
        const { adapter, sent } = lidarr(s => {
            if (s.path === '/api/v1/queue') return QUEUE('downloading');
            if (s.path === '/api/v1/manualimport') return ROWS;
            return COMMAND('ManualImport');
        });

        await expect(adapter.listImportCandidates('nzo-1')).rejects.toThrow(/has not finished downloading/);
        await expect(adapter.runManualImport('nzo-1')).rejects.toMatchObject({
            remedy: expect.stringMatching(/reports it as downloading/)
        });
        expect(sent.map(s => s.path)).toEqual(['/api/v1/queue', '/api/v1/queue']);
    });

    // Lidarr reads its queue first, so every usenet warning reaches the refusal.
    it('names the call that runs a finished NZBGet download again on Lidarr, and how to remove a deleted one', async () => {
        const warned = { totalRecords: 1, records: [{ id: 7, status: 'warning', downloadId: 'aaaabbbbccccddddeeeeffff00001111', artistId: 3, trackedDownloadState: 'downloading', protocol: 'usenet', size: 1000, sizeleft: 0 }] };
        const { adapter, sent } = lidarr(s => (s.path === '/api/v1/queue' ? warned : ROWS));

        await expect(adapter.listImportCandidates('aaaabbbbccccddddeeeeffff00001111')).rejects.toMatchObject({
            remedy: expect.stringContaining(
                'On NZBGet, fix the cause (free disk space, for one), then run its post-processing again there, or with import_download on NZBGet, `action: "postprocess"` and `download_id` "aaaabbbbccccddddeeeeffff00001111". If NZBGet deleted it as a duplicate or as bad, remove it from lidarr’s queue with remove_queue_item and `id` "7", with `blocklist: true` if it was bad. Its `errorMessage`, which get_queue shows at `detail: "full"`, says which.'
            )
        });
        expect(sent.map(s => s.path)).toEqual(['/api/v1/queue']);
    });

    it('names a warning as a warning on Lidarr too, and still reads no files', async () => {
        const { adapter, sent } = lidarr(s => (s.path === '/api/v1/queue' ? QUEUE('warning') : ROWS));

        await expect(adapter.listImportCandidates('nzo-1')).rejects.toMatchObject({
            message: expect.stringMatching(/has a warning in the download client/),
            remedy: expect.stringMatching(/get_queue at `detail: "full"` shows that row's `errorMessage`/)
        });
        expect(sent.map(s => s.path)).toEqual(['/api/v1/queue']);
    });

    it('names a failed download as the client reports it, and still reads no files', async () => {
        const { adapter, sent } = lidarr(s => (s.path === '/api/v1/queue' ? QUEUE('failed') : ROWS));

        await expect(adapter.listImportCandidates('nzo-1')).rejects.toMatchObject({
            message: expect.stringMatching(/is failed in the download client/),
            remedy: expect.stringMatching(/not completed.*remove_queue_item/)
        });
        expect(sent.map(s => s.path)).toEqual(['/api/v1/queue']);
    });

    it('fails rather than reading the files when Lidarr\'s queue cannot be read', async () => {
        const { adapter, sent } = lidarr(s => (s.path === '/api/v1/manualimport' ? ROWS : undefined));

        await expect(adapter.listImportCandidates('nzo-1')).rejects.toMatchObject({ service: 'lidarr' });
        expect(sent.map(s => s.path)).toEqual(['/api/v1/queue']);
    });
});

describe('trigger_scan on lidarr', () => {
    type Call = (args: Record<string, unknown>) => Promise<{ structuredContent: WriteToolResult }>;

    function harness(adapter: ServiceAdapter) {
        let call: Call = () => Promise.reject(new Error('not registered'));
        const server = {
            registerTool(_n: string, cfg: { inputSchema: z.ZodObject }, handler: Call) {
                call = args => handler(cfg.inputSchema.parse(args) as Record<string, unknown>);
            }
        };
        registerTriggerScan(
            server as never,
            {
                permissions: permissionSourceFrom(instancesOf({ lidarr: { ...config } as AnyServiceConfig })),
                confirm: new ConfirmTokens(),
                audit: WriteAudit.ephemeral(),
                library: { invalidate: () => {} } as never
            } as never,
            [adapter]
        );
        return (a: Record<string, unknown>) => call(a);
    }

    /** The preview names the artist, read through `getMediaDetails`, rather than a bare id. */
    const named = () => lidarr(s => (s.path === '/api/v1/artist/3' ? { id: 3, artistName: 'Some Artist' } : undefined));
    const plain = (s: string) => s.replace(/<<untrusted:[^>]*>>|<<\/>>/g, '');

    /** Lidarr's rescan after a one-artist refresh still reads every root folder, so the preview must not say "its folder". */
    it('previews one artist\'s scan by name, as a rescan of every root folder, sending no command', async () => {
        const { adapter, sent } = named();
        const call = harness(adapter);

        const { structuredContent } = await call({ service: 'lidarr', id: '3', dry_run: true });

        expect(plain(structuredContent.summary)).toBe('Ask lidarr to refresh Some Artist and rescan every root folder.');
        const effects = structuredContent.effects.map(plain).join(' ');
        expect(effects).toMatch(/rescans every root folder/);
        expect(effects).not.toMatch(/not touched/);
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['GET /api/v1/artist/3']);
    });

    it('previews one artist\'s rename by name, sending no command', async () => {
        const { adapter, sent } = named();
        const call = harness(adapter);

        const { structuredContent } = await call({ service: 'lidarr', action: 'rename', id: '3', dry_run: true });

        expect(plain(structuredContent.summary)).toBe('Rename the files of Some Artist in lidarr.');
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['GET /api/v1/artist/3']);
    });

    it('previews an import by artist and album, and skips what Lidarr rejects', async () => {
        const { adapter } = importing();
        const call = harness(adapter);

        const { structuredContent } = await call({ service: 'lidarr', action: 'import', download_id: 'nzo-1', dry_run: true });
        const effects = structuredContent.effects.map(e => e.replace(/<<untrusted:[^>]*>>|<<\/>>/g, ''));

        expect(structuredContent.summary).toContain('Import 1 file(s) from download nzo-1 into lidarr');
        expect(effects[0]).toContain('01.flac as Some Artist — First');
        expect(effects.slice(1).join(' ')).toContain('no track matched');
    });

    it('refuses a mapping on lidarr through the tool, before any request', async () => {
        const { adapter, sent } = importing();
        const call = harness(adapter);

        await expect(
            call({ service: 'lidarr', action: 'import', download_id: 'nzo-1', mapping: [{ path: '01.flac', movie_id: '42' }], dry_run: true })
        ).rejects.toThrow(/does not take a `mapping`/);
        expect(sent).toEqual([]);
    });
});
