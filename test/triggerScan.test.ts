import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, MultiUserServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { PlexAdapter } from '../src/services/plex.ts';
import { ProwlarrAdapter } from '../src/services/prowlarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
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
        // A download client has no library at all. Prowlarr does have one
        // action here — it syncs its indexers to the apps — so it stopped
        // being the example of a service with nothing to do.
        const sab = {
            id: 'sabnzbd',
            type: 'sabnzbd',
            testConnection: async () => ({ ok: true, service: 'sabnzbd', latency_ms: 1 }),
            getVersion: async () => '4.0'
        } as unknown as ServiceAdapter;

        await expect(
            harness({ adapters: [sab], permissions: { sabnzbd: permissive(true) } }).call({
                service: 'sabnzbd',
                dry_run: true
            })
        ).rejects.toThrow(/no library/i);
    });
});

/**
 * The first write in the Plex adapter (issue #268). Until it landed, every
 * repair this tool proposed on a Plex stack ended in "now go and scan it in
 * the Plex UI" — the same gap on the media server that `trigger_scan` was
 * written to close on Jellyfin.
 */
describe('trigger_scan on Plex', () => {
    /** Plex answers a refresh with a bare 200 and no `Content-Type`, so the
     *  routes map cannot serve it — see the adapter's own probe. */
    const plexFetch = (refuse: string[] = []) => {
        const refreshed: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/library/sections') {
                return jsonResponse({
                    MediaContainer: {
                        Directory: [
                            { key: '1', type: 'movie', title: 'Movies' },
                            { key: '2', type: 'show', title: 'TV Shows' }
                        ]
                    }
                });
            }
            const key = /^\/library\/sections\/([^/]+)\/refresh$/.exec(url.pathname)?.[1];
            if (key === undefined) return jsonResponse({ message: 'not found' }, 404);
            refreshed.push(key);
            return refuse.includes(key) ? new Response('<html>404</html>', { status: 404 }) : new Response(null);
        }) as unknown as typeof fetch;
        return { impl, refreshed };
    };

    const plexHarness = (refuse: string[] = []) => {
        const plex = plexFetch(refuse);
        const h = harness({
            adapters: [new PlexAdapter(multiUser(32400), plex.impl)],
            permissions: { plex: permissive(true) }
        });
        return { ...h, refreshed: plex.refreshed };
    };

    it('previews without refreshing anything, and scans once confirmed', async () => {
        const h = plexHarness();
        const preview = await h.call({ service: 'plex' });
        expect(h.refreshed).toEqual([]);

        await h.call({ service: 'plex', confirm: preview.structuredContent.confirm_token });
        expect(h.refreshed).toEqual(['1', '2']);
    });

    /** Same tier as Jellyfin's: a scan reads disk and writes Plex's database,
     *  and nothing on the filesystem moves. */
    it('needs safe_write, and nothing more', async () => {
        const h = harness({
            adapters: [new PlexAdapter(multiUser(32400), plexFetch().impl)],
            permissions: { plex: permissive(false) }
        });
        expect((await h.call({ service: 'plex', dry_run: true })).structuredContent.applied).toBe(false);
        // `dry_run` reports applied:false whatever the permissions say, so the
        // denial is pinned by an undry call throwing, and the allowed case by
        // it handing back a confirm token.
        await expect(h.call({ service: 'plex' })).rejects.toThrow();

        const allowed = plexHarness();
        expect((await allowed.call({ service: 'plex' })).structuredContent.confirm_token).toBeDefined();
    });

    it('says in the preview that Plex scans every section', async () => {
        const preview = await plexHarness().call({ service: 'plex' });
        expect(JSON.stringify(preview.structuredContent)).toMatch(/every library section/);
    });

    it('reports which library refused rather than a bare success', async () => {
        const h = plexHarness(['2']);
        const preview = await h.call({ service: 'plex' });
        const done = await h.call({ service: 'plex', confirm: preview.structuredContent.confirm_token });

        expect(done.structuredContent.applied).toBe(true);
        expect(String(done.structuredContent.result)).toContain('Plex refused TV Shows');
    });

    /** Plex hands back no command id, so the message must not offer one to
     *  poll — the scan is followed through each section's `refreshing` flag. */
    it('offers no command id to follow up on', async () => {
        const h = plexHarness();
        const preview = await h.call({ service: 'plex' });
        const done = await h.call({ service: 'plex', confirm: preview.structuredContent.confirm_token });
        expect(String(done.structuredContent.result)).not.toMatch(/command id/i);
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

/**
 * The other half of "it downloaded but Jellyfin cannot see it": the *arr
 * never took the file, so a library scan finds nothing to find.
 */
describe('trigger_scan importing a finished download', () => {
    const CANDIDATES = [
        {
            path: '/downloads/Heat.1995.mkv',
            relativePath: 'Heat.1995.mkv',
            size: 8_000_000_000,
            movie: { id: 15, title: 'Heat' },
            quality: { quality: { id: 7 } },
            rejections: []
        },
        { path: '/downloads/sample.mkv', relativePath: 'sample.mkv', rejections: [{ reason: 'Sample' }] }
    ];

    const importHarness = (candidates: unknown = CANDIDATES) => {
        const radarr = recordingFetch({
            '/api/v3/manualimport': candidates,
            '/api/v3/command': { id: 5, name: 'ManualImport', status: 'queued' }
        });
        return {
            ...harness({
                adapters: [new RadarrAdapter(keyed(7878), radarr.impl)],
                permissions: { radarr: permissive(true) }
            }),
            radarr
        };
    };

    it('lists what will be imported and what will be skipped, with the reason', async () => {
        const h = importHarness();
        const { structuredContent } = await h.call({
            service: 'radarr',
            action: 'import',
            download_id: 'nzo_abc',
            dry_run: true
        });

        const effects = structuredContent.effects.join(' ');
        expect(effects).toContain('Heat.1995.mkv');
        expect(effects).toMatch(/skips.*sample\.mkv/i);
        expect(effects).toContain('Sample');
    });

    it('imports nothing while previewing', async () => {
        const h = importHarness();
        await h.call({ service: 'radarr', action: 'import', download_id: 'nzo_abc' });
        expect(h.radarr.sent.filter(x => x.method === 'POST')).toHaveLength(0);
    });

    it('queues the import once confirmed', async () => {
        const h = importHarness();
        const first = await h.call({ service: 'radarr', action: 'import', download_id: 'nzo_abc' });
        const second = await h.call({
            service: 'radarr',
            action: 'import',
            download_id: 'nzo_abc',
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        expect(h.radarr.sent.filter(x => x.method === 'POST' && x.url === '/api/v3/command')).toHaveLength(1);
    });

    it('needs a download_id', async () => {
        const h = importHarness();
        await expect(h.call({ service: 'radarr', action: 'import', dry_run: true })).rejects.toThrow(/download_id/);
    });

    it('is a no-op when the service sees no files for that download', async () => {
        const h = importHarness([]);
        const { structuredContent } = await h.call({
            service: 'radarr',
            action: 'import',
            download_id: 'gone'
        });
        expect(structuredContent.noop).toBe(true);
    });

    /** Something is there and cannot be taken — a different answer from
     *  "already imported", which is what a no-op would read as. */
    it('refuses when every file is rejected, naming the reasons', async () => {
        const h = importHarness([CANDIDATES[1]]);
        await expect(
            h.call({ service: 'radarr', action: 'import', download_id: 'nzo_bad', dry_run: true })
        ).rejects.toThrow(/Sample/);
    });

    it('refuses on a service that does not import downloads', async () => {
        const h = harness();
        await expect(
            h.call({ service: 'jellyfin', action: 'import', download_id: 'x', dry_run: true })
        ).rejects.toThrow(/cannot import a download/i);
    });
});

/**
 * Prowlarr has no library, but it has the same shape of action: push the
 * indexer list to the applications that use it.
 */
describe('trigger_scan on Prowlarr', () => {
    it('syncs the indexers to the apps, on the v1 api', async () => {
        const prowlarr = recordingFetch({ '/api/v1/command': { id: 3, name: 'ApplicationIndexerSync' } });
        const h = harness({
            adapters: [new ProwlarrAdapter(keyed(9696), prowlarr.impl)],
            permissions: { prowlarr: permissive(true) }
        });

        const first = await h.call({ service: 'prowlarr' });
        await h.call({ service: 'prowlarr', confirm: first.structuredContent.confirm_token });

        expect(prowlarr.sent.filter(x => x.method === 'POST').map(x => x.url)).toEqual(['/api/v1/command']);
    });

    it('does not offer per-item actions there', async () => {
        const prowlarr = recordingFetch({});
        const h = harness({
            adapters: [new ProwlarrAdapter(keyed(9696), prowlarr.impl)],
            permissions: { prowlarr: permissive(true) }
        });
        await expect(h.call({ service: 'prowlarr', id: '1', dry_run: true })).rejects.toThrow(/refresh or rename/i);
    });
});

/** The correction a person makes by watching; see the notes on
 *  `planArrEpisodeRemap` for why nothing automatic can make it. */
describe('trigger_scan remapping episodes', () => {
    /**
     * Models a Sonarr that applies what it is told: the remap now checks that
     * the reassignment landed, so a stub replaying the old association would
     * fail that check rather than exercise the tool (#264).
     */
    const remapHarness = (over: { renames?: unknown[] } = {}) => {
        const FILES = [1, 2].map(n => ({
            path: `/tv/Show/Season 01/Show - S01E0${n}.mkv`,
            relativePath: `Season 01/Show - S01E0${n}.mkv`,
            episodeFileId: 10 + n,
            episodes: [{ id: 100 + n }],
            rejections: []
        }));
        const episodes = [
            { id: 101, seasonNumber: 1, episodeNumber: 1, episodeFileId: 11 },
            { id: 102, seasonNumber: 1, episodeNumber: 2, episodeFileId: 12 }
        ];

        const sent: { url: string; method: string; body?: Record<string, unknown> }[] = [];
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const method = init?.method ?? 'GET';
            const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
            sent.push({ url: url.pathname, method, ...(body === undefined ? {} : { body }) });

            if (url.pathname === '/api/v3/manualimport') return jsonResponse(FILES);
            if (url.pathname === '/api/v3/episode') return jsonResponse(episodes);
            if (url.pathname === '/api/v3/rename') return jsonResponse(over.renames ?? []);
            if (url.pathname === '/api/v3/command' && method === 'POST') {
                const name = String(body?.name ?? '');
                if (name === 'ManualImport') {
                    for (const f of (body?.files ?? []) as { path?: string; episodeIds?: number[] }[]) {
                        const fileId = FILES.find(x => x.path === f.path)?.episodeFileId;
                        for (const id of f.episodeIds ?? []) {
                            const episode = episodes.find(e => e.id === id);
                            if (episode !== undefined && fileId !== undefined) episode.episodeFileId = fileId;
                        }
                    }
                }
                return jsonResponse({ id: 6, name, status: 'queued' });
            }
            // The remap waits for its own command before it can rename, since
            // the rename needs the ids that command assigns.
            if (url.pathname === '/api/v3/command/6') {
                return jsonResponse({
                    id: 6,
                    status: 'completed',
                    result: 'successful',
                    message: '1 selected episode files renamed for Show'
                });
            }
            return jsonResponse({ message: 'not found' }, 404);
        }) as unknown as typeof fetch;

        const sonarr = { impl, sent };
        return {
            ...harness({ adapters: [new SonarrAdapter(keyed(8989), impl)], permissions: { sonarr: permissive(true) } }),
            sonarr
        };
    };

    const SWAP = {
        service: 'sonarr',
        action: 'remap',
        id: '5',
        reassignments: [
            { path: 'Season 01/Show - S01E01.mkv', season: 1, episode: 2 },
            { path: 'Season 01/Show - S01E02.mkv', season: 1, episode: 1 }
        ]
    };

    it('previews each move and the side effects Sonarr will not report itself', async () => {
        const h = remapHarness();
        const { structuredContent } = await h.call({ ...SWAP, dry_run: true });

        const effects = structuredContent.effects.join('\n');
        expect(effects).toMatch(/S01E01\.mkv.*S01E01 → S01E02/);
        expect(effects).toMatch(/ids change/);
        expect(effects).toMatch(/date added/);
        expect(effects).toMatch(/nothing in its own history/);
        expect(h.sonarr.sent.filter(x => x.method === 'POST')).toHaveLength(0);
    });

    it('sends one command once confirmed', async () => {
        const h = remapHarness();
        const first = await h.call(SWAP);
        const second = await h.call({ ...SWAP, confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(h.sonarr.sent.filter(x => x.method === 'POST' && x.url === '/api/v3/command')).toHaveLength(1);
    });

    it('reports the rename it did, not a command to follow up on', async () => {
        const h = remapHarness({
            renames: [
                { episodeFileId: 11, existingPath: 'Season 01/Show - S01E01.mkv', newPath: 'Season 01/Show - S01E09.mkv' }
            ]
        });
        const first = await h.call(SWAP);
        const done = await h.call({ ...SWAP, confirm: first.structuredContent.confirm_token });

        expect(String(done.structuredContent.result)).toContain('renamed 1');
        // It has finished by the time it answers, so it must not send anyone
        // to stack_health to find out whether it worked.
        expect(String(done.structuredContent.result)).not.toMatch(/stack_health/);
    });

    /** The rotation case: the reassignment lands, the filenames cannot. The
     *  answer has to be both halves, not one of them. */
    it('says the reassignment applied and names the files still holding the old name', async () => {
        const h = remapHarness({
            renames: [
                { episodeFileId: 11, existingPath: 'Season 01/Show - S01E01.mkv', newPath: 'Season 01/Show - S01E02.mkv' },
                { episodeFileId: 12, existingPath: 'Season 01/Show - S01E02.mkv', newPath: 'Season 01/Show - S01E01.mkv' }
            ]
        });
        const first = await h.call(SWAP);
        const done = await h.call({ ...SWAP, confirm: first.structuredContent.confirm_token });

        const text = String(done.structuredContent.result);
        expect(done.structuredContent.applied).toBe(true);
        expect(text).toContain('reassigned');
        expect(text).toContain('renamed 0');
        expect(text).toMatch(/S01E01\.mkv.*wants.*S01E02\.mkv/);
        expect(text).toMatch(/naming format/);
    });

    /** A rotation is knowable before anything is sent, so the preview says so
     *  rather than letting the confirm token promise a rename it cannot do. */
    it('warns in the preview that a rotation cannot rename in one pass', async () => {
        const h = remapHarness();
        const { structuredContent } = await h.call({ ...SWAP, dry_run: true });
        expect(structuredContent.effects.join('\n')).toMatch(/free destination/);
    });

    it('is a no-op when every file is already where it was asked to go', async () => {
        const h = remapHarness();
        const { structuredContent } = await h.call({
            ...SWAP,
            reassignments: [{ path: 'Season 01/Show - S01E01.mkv', season: 1, episode: 1 }]
        });
        expect(structuredContent.noop).toBe(true);
    });

    it('needs an id and reassignments', async () => {
        const h = remapHarness();
        await expect(h.call({ service: 'sonarr', action: 'remap', id: '5', dry_run: true })).rejects.toThrow(/reassignments/);
    });

    it('refuses a service with no episodes', async () => {
        const h = harness();
        await expect(h.call({ ...SWAP, service: 'jellyfin', dry_run: true })).rejects.toThrow(/no episodes/);
    });
});
