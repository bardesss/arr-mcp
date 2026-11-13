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
import { registerImportDownload } from '../src/tools/importDownload.ts';
import { registerTriggerScan } from '../src/tools/triggerScan.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * `trigger_scan` on Lidarr: rescan the library or one artist, rename an
 * artist's files, and follow the command in `get_stack_health`; and
 * `import_download`, which imports a finished download by its id. All
 * through the shared helpers with `resource: 'artist'`. The import rows follow `ManualImportResource`
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
        expect(unfenced(candidates[0]?.matchedTitle ?? '')).toBe('Some Artist: First');
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

    it('refuses a movie or episode mapping before asking Lidarr anything, rather than ignoring it', async () => {
        const { adapter, sent } = importing();

        await expect(adapter.listImportCandidates('nzo-1', [{ path: '01.flac', movieId: 42 }])).rejects.toThrow(
            /takes `album_id` and nothing else/
        );
        await expect(adapter.runManualImport('nzo-1', [{ path: '01.flac', albumId: 32, season: 1 }])).rejects.toThrow(
            /takes `album_id` and nothing else/
        );
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
                'On NZBGet, fix the cause (free disk space, for one), then run its post-processing again there, or with import_download, `action: "postprocess"` and `download_id` "aaaabbbbccccddddeeeeffff00001111", on the NZBGet that holds it. If NZBGet deleted it as a duplicate or as bad, remove it from lidarr’s queue with remove_queue_item and `id` "7", with `blocklist: true` if it was bad. Its `errorMessage`, which get_queue shows at `detail: "full"`, says which.'
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

    function harness(adapter: ServiceAdapter, register: typeof registerTriggerScan = registerTriggerScan) {
        let call: Call = () => Promise.reject(new Error('not registered'));
        const server = {
            registerTool(_n: string, cfg: { inputSchema: z.ZodObject }, handler: Call) {
                call = args => handler(cfg.inputSchema.parse(args) as Record<string, unknown>);
            }
        };
        register(
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

    it('previews an import by artist and album through import_download, and skips what Lidarr rejects', async () => {
        const { adapter } = importing();
        const call = harness(adapter, registerImportDownload);

        const { structuredContent } = await call({ service: 'lidarr', download_id: 'nzo-1', dry_run: true });
        const effects = structuredContent.effects.map(e => e.replace(/<<untrusted:[^>]*>>|<<\/>>/g, ''));

        expect(structuredContent.summary).toContain('Import 1 file(s) from download nzo-1 into lidarr');
        expect(effects[0]).toContain('01.flac as Some Artist: First');
        expect(effects.slice(1).join(' ')).toContain('no track matched');
    });

    it('refuses a movie mapping on lidarr through import_download, before any request', async () => {
        const { adapter, sent } = importing();
        const call = harness(adapter, registerImportDownload);

        await expect(
            call({ service: 'lidarr', download_id: 'nzo-1', mapping: [{ path: '01.flac', movie_id: '42' }], dry_run: true })
        ).rejects.toThrow(/takes `album_id` and nothing else/);
        expect(sent).toEqual([]);
    });

    it('previews a mapped file through import_download as the album named, and binds the mapping', async () => {
        const { adapter } = lidarr(s => {
            if (s.path === '/api/v1/queue') return QUEUE('completed');
            if (s.path === '/api/v1/album/32') return { id: 32, title: 'Second', artistId: 3, artist: { artistName: 'Some Artist' } };
            if (s.path === '/api/v1/manualimport' && s.method === 'POST') {
                return (s.body as Record<string, unknown>[]).map(b => ({
                    path: b.path,
                    artist: { id: 3, artistName: 'Some Artist' },
                    album: { id: 32, title: 'Second' },
                    albumReleaseId: 320,
                    tracks: [{ id: 933 }],
                    rejections: []
                }));
            }
            if (s.path === '/api/v1/manualimport') return ROWS;
            return undefined;
        });
        const call = harness(adapter, registerImportDownload);

        const { structuredContent } = await call({
            service: 'lidarr',
            download_id: 'nzo-1',
            mapping: [{ path: '03.flac', album_id: '32' }],
            dry_run: true
        });
        const effects = structuredContent.effects.map(plain);

        expect(structuredContent.summary).toContain('Import 2 file(s) from download nzo-1 into lidarr');
        expect(effects).toContainEqual(expect.stringContaining('03.flac as Some Artist: Second (your mapping)'));
    });

    it('refuses an import on trigger_scan: download_id is no longer one of its arguments', async () => {
        const { adapter, sent } = importing();
        const call = harness(adapter);

        expect(() => call({ service: 'lidarr', download_id: 'nzo-1', dry_run: true })).toThrow(/Unknown argument\(s\): download_id/);
        expect(sent).toEqual([]);
    });
});

/**
 * A mapping on Lidarr names the album; Lidarr's own reprocess (`POST
 * /manualimport`, `ManualImportService.UpdateItems`, Lidarr 3.1.6) then picks
 * the release and the tracks for the files in it and judges them again.
 */
describe('Lidarr import with a mapping', () => {
    const SECOND = { id: 32, title: 'Second', artistId: 3, artist: { id: 3, artistName: 'Some Artist' } };

    /** One verdict for a posted file; track id 93x for file 0x. */
    const judgedRow = (body: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
        path: body.path,
        artist: { id: body.artistId, artistName: 'Some Artist' },
        album: { id: body.albumId, title: 'Second' },
        albumReleaseId: 320,
        tracks: [{ id: 930 + Number(String(body.path).slice(-7, -5)) }],
        quality: { quality: { id: 6, name: 'FLAC' } },
        rejections: [],
        ...over
    });

    // Lidarr answers the reprocess grouped by album, so not in the order sent: reversed here.
    function mapped(reprocess?: (bodies: Record<string, unknown>[]) => unknown) {
        return lidarr(s => {
            if (s.path === '/api/v1/queue') return QUEUE('completed');
            if (s.path === '/api/v1/album/32') return SECOND;
            if (s.path === '/api/v1/manualimport' && s.method === 'POST') {
                const bodies = s.body as Record<string, unknown>[];
                return reprocess === undefined ? [...bodies].reverse().map(b => judgedRow(b)) : reprocess(bodies);
            }
            if (s.path === '/api/v1/manualimport') return ROWS;
            if (s.path === '/api/v1/command') return COMMAND('ManualImport');
            return undefined;
        });
    }

    const mapping = [
        { path: '03.flac', albumId: 32 },
        { path: '/dl/a/05.flac', albumId: 32 }
    ];

    it('asks Lidarr to judge the mapped file again on the album named, leaving the release to it', async () => {
        const { adapter, sent } = mapped();

        const candidates = await adapter.listImportCandidates('nzo-1', [{ path: '03.flac', albumId: 32 }]);

        const post = sent.find(s => s.method === 'POST');
        expect(post?.path).toBe('/api/v1/manualimport');
        expect(post?.body).toEqual([
            {
                path: '/dl/a/03.flac',
                artistId: 3,
                albumId: 32,
                quality: { quality: { id: 0, name: 'Unknown' }, revision: { version: 1, real: 0, isRepack: false } },
                downloadId: 'nzo-1',
                replaceExistingFiles: false,
                disableReleaseSwitching: false
            }
        ]);
        const three = candidates.find(c => c.path === '/dl/a/03.flac');
        expect(three).toMatchObject({ matchedId: 3, rejections: [], mapped: true });
        expect(unfenced(three?.matchedTitle ?? '')).toBe('Some Artist: Second');
    });

    it('merges Lidarr\'s verdicts by path, then imports the mapped files with the release and tracks it chose', async () => {
        const { adapter, sent } = mapped();

        await adapter.runManualImport('nzo-1', mapping);

        const command = sent.find(s => s.path === '/api/v1/command')?.body as { files: Record<string, unknown>[] };
        expect(command.files).toEqual([
            expect.objectContaining({ path: '/dl/a/01.flac', albumId: 31, albumReleaseId: 310, trackIds: [901] }),
            expect.objectContaining({ path: '/dl/a/03.flac', artistId: 3, albumId: 32, albumReleaseId: 320, trackIds: [933] }),
            expect.objectContaining({ path: '/dl/a/05.flac', artistId: 3, albumId: 32, albumReleaseId: 320, trackIds: [935] })
        ]);
    });

    it('still skips a mapped file Lidarr rejects, or places on no track', async () => {
        const { adapter } = mapped(bodies => [
            judgedRow(bodies[0]!, { rejections: [{ reason: 'Has missing tracks' }] }),
            judgedRow(bodies[1]!, { tracks: [] })
        ]);

        const candidates = await adapter.listImportCandidates('nzo-1', mapping);

        expect(candidates.find(c => c.path === '/dl/a/03.flac')?.rejections.map(unfenced)).toEqual(['Has missing tracks']);
        expect(candidates.find(c => c.path === '/dl/a/05.flac')?.rejections).toEqual(['no track matched']);
    });

    it('treats a file Lidarr put on another album as rejected', async () => {
        const { adapter } = mapped(bodies => bodies.map(b => judgedRow(b, { album: { id: 31, title: 'First' } })));

        const candidates = await adapter.listImportCandidates('nzo-1', [{ path: '03.flac', albumId: 32 }]);

        expect(candidates.find(c => c.path === '/dl/a/03.flac')?.rejections).toEqual(['not placed on album 32']);
    });

    it.each([
        ['leaves a mapped file out', (bodies: Record<string, unknown>[]) => [judgedRow(bodies[0]!)]],
        ['answers a row without rejections', (bodies: Record<string, unknown>[]) => bodies.map(b => ({ ...judgedRow(b), rejections: null }))],
        ['answers something other than a list', () => ({ message: 'error' })]
    ])('refuses the mapping when the reprocess %s', async (_case, answer) => {
        const { adapter, sent } = mapped(answer);

        await expect(adapter.runManualImport('nzo-1', mapping)).rejects.toThrow(/did not judge every mapped file/);
        expect(sent.filter(s => s.path === '/api/v1/command')).toEqual([]);
    });

    it('names an album Lidarr does not have, before the reprocess', async () => {
        const { adapter, sent } = mapped();

        await expect(adapter.listImportCandidates('nzo-1', [{ path: '03.flac', albumId: 99 }])).rejects.toMatchObject({
            message: expect.stringMatching(/has no album 99/),
            remedy: expect.stringMatching(/get_media_details/)
        });
        expect(sent.filter(s => s.method === 'POST')).toEqual([]);
    });

    it('names a path the download does not have', async () => {
        const { adapter } = mapped();

        await expect(adapter.listImportCandidates('nzo-1', [{ path: '09.flac', albumId: 32 }])).rejects.toThrow(/has no file "09.flac"/);
    });
});
