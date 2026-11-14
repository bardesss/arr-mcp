import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId, CredentialServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerDeleteEpisodeFiles } from '../src/tools/deleteEpisodeFiles.ts';
import { registerDeleteMedia } from '../src/tools/deleteMedia.ts';
import type { CrossChecker } from '../src/tools/crossChecks.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerRemoveQueueItem } from '../src/tools/removeQueueItem.ts';
import { registerSetMonitoring } from '../src/tools/setMonitoring.ts';
import { registerUpdateMedia } from '../src/tools/updateMedia.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const transmissionConfig: CredentialServiceConfig = {
    url: 'http://192.0.2.10:9091',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const tiered = (safe_write: boolean, destructive: boolean): AnyServiceConfig =>
    ({ ...keyed(7878), permissions: { safe_write, destructive } }) as AnyServiceConfig;

/**
 * Records method, path, query and body. For a destructive write the exact query
 * string *is* the behaviour — `deleteFiles=false` and an omitted `deleteFiles`
 * are different outcomes on disk.
 */
function recordingFetch(routes: Record<string, unknown>, opts: { emptyBody?: boolean } = {}) {
    const sent: { path: string; search: string; method: string; body: unknown }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({
            path: url.pathname,
            search: url.search,
            method,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        });

        if (method === 'DELETE' || method === 'PUT') {
            // What Radarr and Sonarr actually answer: 200 with nothing in it.
            // Every PUT this adapter issues discards the body, same as DELETE.
            return opts.emptyBody === false ? jsonResponse({}) : new Response('', { status: 200 });
        }
        if (url.pathname in routes) return jsonResponse(routes[url.pathname]);
        if (`${url.pathname}${url.search}` in routes) return jsonResponse(routes[`${url.pathname}${url.search}`]);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

const MOVIE = { id: 412, title: 'Alien', year: 1979, monitored: true, hasFile: true, movieFile: { size: 25_900_000_000 } };
const SERIES = { id: 7, title: 'Alien: Earth', year: 2025, monitored: true, statistics: { sizeOnDisk: 3_000_000_000, episodeFileCount: 8 } };

const SERIES_FULL = {
    id: 7,
    title: 'Alien: Earth',
    monitored: true,
    seasons: [
        { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8 } },
        { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 2 } }
    ]
};

const ARR_QUEUE = {
    records: [{ id: 91, title: 'Alien.1979.2160p-GROUP', status: 'stalled', size: 1000, sizeleft: 900 }]
};
/** A Lidarr row is an album release, keyed to an artist. */
const LIDARR_QUEUE = {
    records: [
        {
            id: 91,
            title: 'Some.Artist-First-FLAC-2024-GROUP',
            status: 'downloading',
            trackedDownloadState: 'downloading',
            downloadId: 'nzo-91',
            size: 1000,
            sizeleft: 900,
            artistId: 3,
            albumId: 5
        }
    ]
};

// --- adapters ------------------------------------------------------------

describe('deleting media', () => {
    it('sends both flags explicitly rather than relying on Radarr defaults', async () => {
        const { impl, sent } = recordingFetch({});
        await new RadarrAdapter(keyed(7878), impl).deleteMedia('412', {
            deleteFiles: false,
            addImportExclusion: false
        });

        const del = sent.find(s => s.method === 'DELETE');
        expect(del?.path).toBe('/api/v3/movie/412');
        expect(del?.search).toContain('deleteFiles=false');
        expect(del?.search).toContain('addImportExclusion=false');
    });

    it('deletes files when asked', async () => {
        const { impl, sent } = recordingFetch({});
        await new RadarrAdapter(keyed(7878), impl).deleteMedia('412', {
            deleteFiles: true,
            addImportExclusion: true
        });

        const del = sent.find(s => s.method === 'DELETE');
        expect(del?.search).toContain('deleteFiles=true');
        expect(del?.search).toContain('addImportExclusion=true');
    });

    it('uses series, not movie, on Sonarr', async () => {
        const { impl, sent } = recordingFetch({});
        await new SonarrAdapter(keyed(8989), impl).deleteMedia('7', { deleteFiles: true, addImportExclusion: false });
        expect(sent.find(s => s.method === 'DELETE')?.path).toBe('/api/v3/series/7');
    });

    // The two services spell the exclusion flag differently, and ASP.NET drops
    // a query parameter it cannot bind rather than refusing the request — so
    // Radarr's name sent to Sonarr deletes the series with the exclusion
    // silently defaulted to false, and the tool still reports success. The
    // user then watches their import list put it straight back.
    it("uses Sonarr's own name for the exclusion flag, which is not Radarr's", async () => {
        const { impl, sent } = recordingFetch({});
        await new SonarrAdapter(keyed(8989), impl).deleteMedia('7', { deleteFiles: true, addImportExclusion: true });

        const del = sent.find(s => s.method === 'DELETE');
        expect(del?.search).toContain('addImportListExclusion=true');
        expect(del?.search).not.toContain('addImportExclusion=');
    });

    it('uses series on Whisparr too, same as Sonarr', async () => {
        const { impl, sent } = recordingFetch({});
        await new WhisparrAdapter(keyed(6969), impl).deleteMedia('7', { deleteFiles: true, addImportExclusion: false });
        expect(sent.find(s => s.method === 'DELETE')?.path).toBe('/api/v3/series/7');
    });

    // The empty-body case: routing a delete through the JSON parse would turn
    // every successful deletion into "response was not valid JSON".
    it('succeeds on the empty 200 the arrs actually return', async () => {
        const { impl } = recordingFetch({});
        await expect(
            new RadarrAdapter(keyed(7878), impl).deleteMedia('412', { deleteFiles: false, addImportExclusion: false })
        ).resolves.toBeUndefined();
    });

    it('refuses a non-numeric id rather than issuing a delete into the dark', async () => {
        const { impl, sent } = recordingFetch({});
        await expect(
            new RadarrAdapter(keyed(7878), impl).deleteMedia('Alien', { deleteFiles: true, addImportExclusion: false })
        ).rejects.toThrow(ServiceError);
        expect(sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
    });
});

describe('removing a queue item', () => {
    it('sends removeFromClient explicitly, because Radarr defaults it to true', async () => {
        const { impl, sent } = recordingFetch({});
        await new RadarrAdapter(keyed(7878), impl).removeQueueItem('91', {
            removeFromClient: false,
            blocklist: false
        });

        const del = sent.find(s => s.method === 'DELETE');
        expect(del?.path).toBe('/api/v3/queue/91');
        expect(del?.search).toContain('removeFromClient=false');
        expect(del?.search).toContain('blocklist=false');
    });

    it('blocklists when asked, on Sonarr too', async () => {
        const { impl, sent } = recordingFetch({});
        await new SonarrAdapter(keyed(8989), impl).removeQueueItem('91', {
            removeFromClient: true,
            blocklist: true
        });
        expect(sent.find(s => s.method === 'DELETE')?.search).toContain('blocklist=true');
    });

    it('deletes from SABnzbd by nzo_id, on the mode/name query SABnzbd expects', async () => {
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            seen.push(new URL(input instanceof Request ? input.url : String(input)).search);
            return jsonResponse({ status: true });
        }) as unknown as typeof fetch;

        await new SabnzbdAdapter(keyed(8080), impl).removeQueueItem('SABnzbd_nzo_ab12', {
            removeFromClient: true,
            blocklist: false
        });

        expect(seen[0]).toContain('mode=queue');
        expect(seen[0]).toContain('name=delete');
        expect(seen[0]).toContain('value=SABnzbd_nzo_ab12');
        // del_files is what actually removes the partial download.
        expect(seen[0]).toContain('del_files=1');
    });

    it('never re-sends the SABnzbd delete on a timeout', async () => {
        // SABnzbd's whole API is GET, so its one destructive call travels over
        // the verb the transport retries. A delete that timed out *after*
        // SABnzbd processed it would be sent again, and the second one answers
        // `{"status": false}` for an nzo_id that is already gone — reporting a
        // refusal for a deletion that succeeded.
        let calls = 0;
        const impl = (async () => {
            calls += 1;
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }) as unknown as typeof fetch;

        await expect(
            new SabnzbdAdapter(keyed(8080), impl).removeQueueItem('SABnzbd_nzo_ab12', {
                removeFromClient: true,
                blocklist: false
            })
        ).rejects.toThrow(/timed out/);
        expect(calls).toBe(1);
    });

    it('leaves SABnzbd partial data alone when removeFromClient is false', async () => {
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            seen.push(new URL(input instanceof Request ? input.url : String(input)).search);
            return jsonResponse({ status: true });
        }) as unknown as typeof fetch;

        await new SabnzbdAdapter(keyed(8080), impl).removeQueueItem('SABnzbd_nzo_ab12', {
            removeFromClient: false,
            blocklist: false
        });
        expect(seen[0]).toContain('del_files=0');
    });

    // SABnzbd answers 200 with {"status": false} for an id it does not have.
    // Trusting the status line would report a deletion that never happened.
    it('treats SABnzbd status:false as a failure, not a success', async () => {
        const impl = (async () =>
            jsonResponse({ status: false, error: 'nzo_id not found' })) as unknown as typeof fetch;

        await expect(
            new SabnzbdAdapter(keyed(8080), impl).removeQueueItem('nope', {
                removeFromClient: true,
                blocklist: false
            })
        ).rejects.toThrow(/refused/);
    });

    it('accepts SABnzbd status:true', async () => {
        const impl = (async () => jsonResponse({ status: true })) as unknown as typeof fetch;
        await expect(
            new SabnzbdAdapter(keyed(8080), impl).removeQueueItem('SABnzbd_nzo_ab12', {
                removeFromClient: true,
                blocklist: false
            })
        ).resolves.toBeUndefined();
    });

    it('maps removeFromClient to Transmission delete-local-data', async () => {
        const { impl, sent } = recordingFetch({});
        // The adapter checks the torrent exists before removing it, so the
        // torrent-get leg has to answer before torrent-remove is reached.
        const impl2 = (async (input: string | URL | Request, init?: RequestInit) => {
            await impl(input, init);
            const body = JSON.parse((init?.body as string) ?? '{}') as { method?: string };
            if (body.method === 'torrent-get') {
                return jsonResponse({ result: 'success', arguments: { torrents: [{ id: 3 }] } });
            }
            return jsonResponse({ result: 'success' });
        }) as unknown as typeof fetch;

        await new TransmissionAdapter(transmissionConfig, impl2).removeQueueItem('3', {
            removeFromClient: true,
            blocklist: false
        });

        const rpc = sent.find(
            s => s.method === 'POST' && (s.body as { method?: string })?.method === 'torrent-remove'
        )?.body as {
            method: string;
            arguments: Record<string, unknown>;
        };
        expect(rpc.method).toBe('torrent-remove');
        expect(rpc.arguments).toEqual({ ids: [3], 'delete-local-data': true });
    });

    // Transmission reports failure as HTTP 200 with a non-success result.
    it('treats a non-success Transmission result as a failure', async () => {
        const impl = (async (_i: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse((init?.body as string) ?? '{}') as { method?: string };
            if (body.method === 'torrent-get') {
                return jsonResponse({ result: 'success', arguments: { torrents: [{ id: 3 }] } });
            }
            return jsonResponse({ result: 'invalid argument' });
        }) as unknown as typeof fetch;
        await expect(
            new TransmissionAdapter(transmissionConfig, impl).removeQueueItem('3', {
                removeFromClient: true,
                blocklist: false
            })
        ).rejects.toThrow(/torrent-remove failed/);
    });
});

describe('Sonarr.setMonitoring', () => {
    it('unmonitors a whole series', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/series/7': SERIES_FULL });
        await new SonarrAdapter(keyed(8989), impl).setMonitoring('7', { monitored: false });

        const put = sent.find(s => s.method === 'PUT');
        expect(put?.path).toBe('/api/v3/series/7');
        expect(put?.body).toMatchObject({ id: 7, monitored: false });
    });

    it('unmonitors one season and leaves the others alone', async () => {
        const { impl, sent } = recordingFetch({ '/api/v3/series/7': SERIES_FULL });
        await new SonarrAdapter(keyed(8989), impl).setMonitoring('7', { monitored: false, season: 2 });

        const put = sent.find(s => s.method === 'PUT');
        expect(put?.path).toBe('/api/v3/series/7');
        // Season 1 untouched is the assertion that matters — a PUT that
        // rewrites every season would silently unmonitor the whole show.
        expect((put?.body as { seasons: unknown[] }).seasons).toEqual([
            { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8 } },
            { seasonNumber: 2, monitored: false, statistics: { episodeFileCount: 2 } }
        ]);
        expect((put?.body as { monitored: boolean }).monitored).toBe(true);
    });

    it('uses the episode endpoint for episode ids, not the series one', async () => {
        const { impl, sent } = recordingFetch({});
        await new SonarrAdapter(keyed(8989), impl).setMonitoring('7', {
            monitored: false,
            episodeIds: ['11', '12']
        });

        const put = sent.find(s => s.method === 'PUT');
        expect(put?.path).toBe('/api/v3/episode/monitor');
        expect(put?.body).toEqual({ episodeIds: [11, 12], monitored: false });
        // No series read at all on this path.
        expect(sent.filter(s => s.path === '/api/v3/series/7')).toHaveLength(0);
    });

    it('refuses a non-numeric series id rather than issuing a write into the dark', async () => {
        const { impl, sent } = recordingFetch({});
        await expect(
            new SonarrAdapter(keyed(8989), impl).setMonitoring('Severance', { monitored: false })
        ).rejects.toThrow(ServiceError);
        expect(sent.filter(s => s.method === 'PUT')).toHaveLength(0);
    });

    it('refuses a non-numeric episode id the same way', async () => {
        const { impl, sent } = recordingFetch({});
        await expect(
            new SonarrAdapter(keyed(8989), impl).setMonitoring('7', { monitored: false, episodeIds: ['x'] })
        ).rejects.toThrow(ServiceError);
        expect(sent.filter(s => s.method === 'PUT')).toHaveLength(0);
    });
});

it('reports per-season monitoring, which the write tools gate on', async () => {
    const { impl } = recordingFetch({ '/api/v3/series/7': SERIES_FULL });
    const details = await new SonarrAdapter(keyed(8989), impl).getMediaDetails('7', {
        includeEpisodes: false,
        episodeLimit: 0
    });
    expect(details.seasons).toEqual([
        { season: 1, monitored: true },
        { season: 2, monitored: true }
    ]);
});

const EPISODE_FILES = [
    { id: 101, seriesId: 7, seasonNumber: 1, size: 3_000_000_000 },
    { id: 102, seriesId: 7, seasonNumber: 2, size: 4_000_000_000 },
    { id: 103, seriesId: 7, seasonNumber: 2, size: 5_000_000_000 }
];

/**
 * Season 2's two episodes, monitored, holding the two season-2 files above.
 * Both write tools read the episode list now — set_monitoring to validate the
 * ids it was given, delete_episode_files to decide whether the re-download
 * warning is true — so a season case needs episodes as well as files.
 */
const EPISODES_S2 = [
    { id: 11, seasonNumber: 2, episodeNumber: 1, title: 'Ep1', hasFile: true, monitored: true, episodeFileId: 102 },
    { id: 12, seasonNumber: 2, episodeNumber: 2, title: 'Ep2', hasFile: true, monitored: true, episodeFileId: 103 }
];

describe('Sonarr episode files', () => {
    it('lists them with season and size, which is what a preview needs', async () => {
        const { impl } = recordingFetch({ '/api/v3/episodefile?seriesId=7': EPISODE_FILES });
        const files = await new SonarrAdapter(keyed(8989), impl).listEpisodeFiles('7');
        expect(files).toEqual([
            { id: 101, season: 1, sizeBytes: 3_000_000_000 },
            { id: 102, season: 2, sizeBytes: 4_000_000_000 },
            { id: 103, season: 2, sizeBytes: 5_000_000_000 }
        ]);
    });

    it('omits a size Sonarr did not report rather than calling it zero', async () => {
        const { impl } = recordingFetch({
            '/api/v3/episodefile?seriesId=7': [{ id: 101, seasonNumber: 1 }]
        });
        const [file] = await new SonarrAdapter(keyed(8989), impl).listEpisodeFiles('7');
        expect(file).not.toHaveProperty('sizeBytes');
    });

    it('deletes in bulk, in one call', async () => {
        const { impl, sent } = recordingFetch({});
        await new SonarrAdapter(keyed(8989), impl).deleteEpisodeFiles([102, 103]);
        const del = sent.find(s => s.method === 'DELETE');
        expect(del?.path).toBe('/api/v3/episodefile/bulk');
        expect(del?.body).toEqual({ episodeFileIds: [102, 103] });
    });

    it('does nothing at all for an empty id list', async () => {
        // A bulk delete with no ids is a request with no purpose; Sonarr's
        // behaviour for it is not worth discovering in production.
        const { impl, sent } = recordingFetch({});
        await new SonarrAdapter(keyed(8989), impl).deleteEpisodeFiles([]);
        expect(sent).toHaveLength(0);
    });

    it('refuses a non-numeric series id', async () => {
        const { impl, sent } = recordingFetch({});
        await expect(new SonarrAdapter(keyed(8989), impl).listEpisodeFiles('Severance')).rejects.toThrow(
            ServiceError
        );
        expect(sent).toHaveLength(0);
    });
});

// --- the tools -----------------------------------------------------------

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

// `instancesOf` (test/helpers/instances.ts) deliberately ignores `name` — this
// file's tests are almost all a single unnamed instance per service. This
// reads it when present, so a config built as `{ ...keyed(port), name: 'spare' }`
// produces the qualified id its adapter actually carries, without growing that
// shared helper to cover a case it was written to skip.
function harness(
    register: typeof registerDeleteMedia,
    opts: {
        permissions?: Partial<Record<ServiceId, AnyServiceConfig>>;
        adapters?: ServiceAdapter[];
        crossChecks?: CrossChecker;
    } = {}
) {
    const radarr = recordingFetch({ '/api/v3/movie/412': MOVIE, '/api/v3/queue': ARR_QUEUE });
    const sonarr = recordingFetch({ '/api/v3/series/7': SERIES, '/api/v3/queue': ARR_QUEUE });
    const whisparr = recordingFetch({ '/api/v3/series/7': SERIES, '/api/v3/queue': ARR_QUEUE });
    const lidarr = recordingFetch({ '/api/v1/queue': LIDARR_QUEUE, '/api/v1/history': { records: [{ eventType: 'grabbed', downloadId: 'nzo-91' }] } });

    const adapters = opts.adapters ?? [
        new RadarrAdapter(keyed(7878), radarr.impl),
        new SonarrAdapter(keyed(8989), sonarr.impl),
        new WhisparrAdapter(keyed(6969), whisparr.impl),
        new LidarrAdapter(keyed(8686), lidarr.impl)
    ];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const invalidate = vi.fn();
    const audit = WriteAudit.ephemeral();
    register(
        server as never,
        {
            permissions: permissionSourceFrom(
                instancesOf(
                    opts.permissions ?? {
                        radarr: tiered(false, true),
                        sonarr: tiered(false, true),
                        whisparr: tiered(false, true),
                        lidarr: tiered(false, true)
                    }
                )
            ),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate } as unknown as LibraryLoader,
            ...(opts.crossChecks === undefined ? {} : { crossChecks: opts.crossChecks })
        },
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a), radarr, sonarr, whisparr, lidarr, audit, invalidate };
}

describe('delete_media', () => {
    it('names the film and the size on disk, not the id', async () => {
        const h = harness(registerDeleteMedia);
        const { structuredContent } = await h.call({ service: 'radarr', id: '412', delete_files: true, dry_run: true });

        expect(structuredContent.summary).toContain('Alien');
        expect(structuredContent.summary).toContain('24.1 GB');
        expect(structuredContent.tier).toBe('destructive');
    });

    it('names the instance in the summary, not only the service', async () => {
        const namedRadarr = { ...tiered(false, true), name: '4k' } as never;
        const fetched = recordingFetch({ '/api/v3/movie/412': MOVIE, '/api/v3/queue': ARR_QUEUE });
        const h = harness(registerDeleteMedia, { adapters: [new RadarrAdapter(namedRadarr, fetched.impl)], permissions: { radarr: namedRadarr } });
        const { structuredContent } = await h.call({ service: 'radarr', instance: '4k', id: '412', dry_run: true });

        expect(structuredContent.summary).toMatch(/ from radarr\/4k, leaving its files on disk\.$/);
    });

    it('says plainly that files stay when delete_files is false', async () => {
        const h = harness(registerDeleteMedia);
        const { structuredContent } = await h.call({ service: 'radarr', id: '412', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('Leaves the files on disk');
    });

    it('warns that a Sonarr delete takes the whole series', async () => {
        const h = harness(registerDeleteMedia);
        const { structuredContent } = await h.call({ service: 'sonarr', id: '7', delete_files: true, dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('every episode');
    });

    it('warns that a Whisparr delete takes the whole site, in Whisparr\'s own words', async () => {
        const h = harness(registerDeleteMedia);
        const { structuredContent } = await h.call({ service: 'whisparr', id: '7', delete_files: true, dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('every scene');
    });

    it('deletes nothing on a dry run', async () => {
        const h = harness(registerDeleteMedia);
        await h.call({ service: 'radarr', id: '412', delete_files: true, dry_run: true });
        expect(h.radarr.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
    });

    it('deletes nothing on an unconfirmed call', async () => {
        const h = harness(registerDeleteMedia);
        const first = await h.call({ service: 'radarr', id: '412', delete_files: true });
        expect(first.structuredContent.applied).toBe(false);
        expect(h.radarr.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
    });

    it('deletes once confirmed', async () => {
        const h = harness(registerDeleteMedia);
        const first = await h.call({ service: 'radarr', id: '412', delete_files: true });
        const second = await h.call({
            service: 'radarr',
            id: '412',
            delete_files: true,
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        expect(h.radarr.sent.find(s => s.method === 'DELETE')?.search).toContain('deleteFiles=true');
        expect(h.invalidate).toHaveBeenCalledTimes(1);
    });

    // The token commits to the flags, so escalating after the preview fails.
    it('will not let a token previewed without delete_files be used to wipe the disk', async () => {
        const h = harness(registerDeleteMedia);
        const preview = await h.call({ service: 'radarr', id: '412', delete_files: false });

        const escalated = await h.call({
            service: 'radarr',
            id: '412',
            delete_files: true,
            confirm: preview.structuredContent.confirm_token
        });

        expect(escalated.structuredContent.applied).toBe(false);
        expect(escalated.structuredContent.confirm_error).toContain('different operation');
        expect(h.radarr.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
    });

    // safe_write must not reach a destructive tool.
    it('is refused by safe_write alone', async () => {
        const h = harness(registerDeleteMedia, { permissions: { radarr: tiered(true, false) } });
        await expect(h.call({ service: 'radarr', id: '412' })).rejects.toThrow(
            /services\.radarr\.permissions\.destructive: true/
        );
        expect(h.radarr.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);
    });

    it('records the deletion in the audit trail with its arguments', async () => {
        const h = harness(registerDeleteMedia);
        const first = await h.call({ service: 'radarr', id: '412', delete_files: true });
        await h.call({
            service: 'radarr',
            id: '412',
            delete_files: true,
            confirm: first.structuredContent.confirm_token
        });

        const rows = h.audit.recent() as { outcome: string; target: string; args: string }[];
        expect(rows[0]?.outcome).toBe('applied');
        expect(rows[0]?.target).toBe('radarr:412');
        expect(JSON.parse(rows[0]?.args ?? '{}')).toMatchObject({ deleteFiles: true });
    });
});

describe('delete_media cross-checks', () => {
    const quiet = () => vi.fn<CrossChecker>(async () => ({ warnings: [], unchecked: [] }));

    it('asks the delete checks about the film it resolved', async () => {
        const crossChecks = quiet();
        const radarr = recordingFetch({ '/api/v3/movie/412': { ...MOVIE, tmdbId: 348 } });
        const h = harness(registerDeleteMedia, { adapters: [new RadarrAdapter(keyed(7878), radarr.impl)], crossChecks });

        await h.call({ service: 'radarr', id: '412', dry_run: true });

        expect(crossChecks).toHaveBeenCalledTimes(1);
        const [subject, profile] = crossChecks.mock.calls[0] ?? [];
        expect(profile).toBe('delete');
        expect(subject).toMatchObject({ kind: 'movie', ids: { tmdb: 348 }, acquisition: { service: 'radarr', id: '412' } });
        expect(subject?.label).toContain('Alien');
        expect(subject?.seasons).toBeUndefined();
    });

    it('says the files stay unless delete_files is true', async () => {
        const crossChecks = quiet();
        const h = harness(registerDeleteMedia, { crossChecks });

        await h.call({ service: 'radarr', id: '412', dry_run: true });
        await h.call({ service: 'radarr', id: '412', delete_files: false, dry_run: true });
        await h.call({ service: 'radarr', id: '412', delete_files: true, dry_run: true });

        expect(crossChecks.mock.calls.map(c => c[0].filesStay)).toEqual([true, true, undefined]);
    });

    it('asks as a series for Sonarr', async () => {
        const crossChecks = quiet();
        const sonarr = recordingFetch({ '/api/v3/series/7': { ...SERIES, tvdbId: 424207 } });
        const h = harness(registerDeleteMedia, { adapters: [new SonarrAdapter(keyed(8989), sonarr.impl)], crossChecks });

        await h.call({ service: 'sonarr', id: '7', dry_run: true });

        expect(crossChecks.mock.calls[0]?.[0]).toMatchObject({ kind: 'series', ids: { tvdb: 424207 } });
    });

    // Whisparr keeps its own scene id in the TVDB field, so a Seerr match on it would be false.
    it('does not ask about a Whisparr site', async () => {
        const crossChecks = quiet();
        const whisparr = recordingFetch({ '/api/v3/series/7': { ...SERIES, tvdbId: 1001 } });
        const h = harness(registerDeleteMedia, { adapters: [new WhisparrAdapter(keyed(6969), whisparr.impl)], crossChecks });

        const { structuredContent } = await h.call({ service: 'whisparr', id: '7', dry_run: true });

        expect(structuredContent.summary).toContain('Alien');
        expect(crossChecks).not.toHaveBeenCalled();
    });

    // A subject folded into the token would break it when the title changes in between.
    it('asks only on the preview, and a title that changed does not void the token', async () => {
        const crossChecks = quiet();
        const routes: Record<string, unknown> = { '/api/v3/movie/412': { ...MOVIE, tmdbId: 348 } };
        const h = harness(registerDeleteMedia, {
            adapters: [new RadarrAdapter(keyed(7878), recordingFetch(routes).impl)],
            crossChecks
        });

        const first = await h.call({ service: 'radarr', id: '412' });
        routes['/api/v3/movie/412'] = { ...MOVIE, title: 'Renamed', tmdbId: 349 };
        const second = await h.call({ service: 'radarr', id: '412', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(crossChecks).toHaveBeenCalledTimes(1);
    });
});

describe('remove_queue_item', () => {
    it('names the release and its current status', async () => {
        const h = harness(registerRemoveQueueItem);
        const { structuredContent } = await h.call({ service: 'radarr', id: '91', dry_run: true });

        expect(structuredContent.summary).toContain('Alien.1979.2160p-GROUP');
        expect(structuredContent.summary).toContain('stalled');
    });

    it('fails legibly when the id is no longer in the queue', async () => {
        const h = harness(registerRemoveQueueItem);
        await expect(h.call({ service: 'radarr', id: '999', dry_run: true })).rejects.toThrow(
            /nothing in radarr's queue has id/
        );
    });

    it('removes once confirmed, deleting partial data by default', async () => {
        const h = harness(registerRemoveQueueItem);
        const first = await h.call({ service: 'radarr', id: '91' });
        await h.call({ service: 'radarr', id: '91', confirm: first.structuredContent.confirm_token });

        const del = h.radarr.sent.find(s => s.method === 'DELETE');
        expect(del?.path).toBe('/api/v3/queue/91');
        expect(del?.search).toContain('removeFromClient=true');
    });

    it('removes a Lidarr download on /api/v1, blocklisting it when asked', async () => {
        const h = harness(registerRemoveQueueItem);
        const first = await h.call({ service: 'lidarr', id: '91', blocklist: true });

        expect(first.structuredContent.summary).toContain('Some.Artist-First-FLAC-2024-GROUP');
        expect(first.structuredContent.effects.join(' ')).toContain('Blocklists this release');
        expect(first.structuredContent.effects.join(' ')).not.toContain('has no blocklist');
        expect(h.lidarr.sent.filter(s => s.method === 'DELETE')).toEqual([]);

        await h.call({ service: 'lidarr', id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });

        const del = h.lidarr.sent.find(s => s.method === 'DELETE');
        expect(del?.path).toBe('/api/v1/queue/91');
        expect(del?.search).toContain('removeFromClient=true');
        expect(del?.search).toContain('blocklist=true');
    });

    it('says the blocklist flag is ignored on a service that has none', async () => {
        const sabQueue = {
            queue: { slots: [{ nzo_id: 'SABnzbd_nzo_ab12', filename: 'Alien.1979-GROUP', status: 'Downloading' }] }
        };
        const sab = recordingFetch({});
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            await sab.impl(input, init);
            return jsonResponse(sabQueue);
        }) as unknown as typeof fetch;

        const h = harness(registerRemoveQueueItem, {
            adapters: [new SabnzbdAdapter(keyed(8080), impl)],
            permissions: { sabnzbd: tiered(false, true) }
        });

        const { structuredContent } = await h.call({
            service: 'sabnzbd',
            id: 'SABnzbd_nzo_ab12',
            blocklist: true,
            dry_run: true
        });

        expect(structuredContent.effects.join(' ')).toContain('has no blocklist of its own');
    });

    // A row Radarr still has its film for, and the grab record its blocklist goes through.
    const KNOWN = { ...ARR_QUEUE.records[0], movieId: 412, downloadId: 'nzo-91' };
    const GRABBED = { records: [{ eventType: 'grabbed', downloadId: 'nzo-91' }] };
    const HISTORY_READ = '?downloadId=nzo-91&eventType=1&page=1&pageSize=50&sortKey=date&sortDirection=descending';
    const radarrWith = (routes: Record<string, unknown>) => {
        const radarr = recordingFetch(routes);
        const h = harness(registerRemoveQueueItem, { adapters: [new RadarrAdapter(keyed(7878), radarr.impl)], permissions: { radarr: tiered(false, true) } });
        return { h, radarr, reads: () => radarr.sent.filter(s => s.path === '/api/v3/history') };
    };
    const KEPT_ALONE = 'Nothing was changed: a torrent keeps seeding, and the row stays. To delete the download too, leave out remove_from_client.';
    const ORPHAN_REFUSAL = `radarr not found: radarr matched nothing in its library to this download, so it cannot leave the download alone and drop the row. ${KEPT_ALONE}`;
    const ORPHAN = { ...KNOWN, movieId: undefined };

    // The four blocklist a download through its grab record, which usually goes
    // with the film, series or artist. An orphaned row is read all the same.
    it('reads an orphaned row\'s grab record too, and sends blocklist=false without one', async () => {
        const { h, radarr, reads } = radarrWith({ '/api/v3/queue': { records: [ORPHAN] }, '/api/v3/history': { records: [] } });
        const first = await h.call({ service: 'radarr', id: '91', blocklist: true });
        expect(first.structuredContent.effects).toEqual([
            'Removes it from radarr and deletes any partial data already downloaded.',
            'Not blocklisted: radarr lists no grab of this download.'
        ]);
        await h.call({ service: 'radarr', id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });
        expect(reads().map(s => s.search)).toEqual([HISTORY_READ, HISTORY_READ]);
        expect(radarr.sent.filter(s => s.method === 'DELETE').map(s => s.search)).toEqual(['?removeFromClient=true&blocklist=false']);
    });

    // A grab the service could not map back to its film keeps its record. Failed
    // by the blocklist, the download is not tracked again, so it can stay.
    it('blocklists an orphaned row that still has its grab record, and keeps its download when asked', async () => {
        const { h, radarr } = radarrWith({ '/api/v3/queue': { records: [ORPHAN] }, '/api/v3/history': GRABBED });
        const first = await h.call({ service: 'radarr', id: '91', blocklist: true, remove_from_client: false });
        expect(first.structuredContent.effects).toEqual([
            "Removes it from radarr's queue but leaves the download itself alone.",
            'Blocklists this release (remove_blocklist_item undoes it); radarr may still delete it from the client, and search for a replacement.'
        ]);
        await h.call({ service: 'radarr', id: '91', blocklist: true, remove_from_client: false, confirm: first.structuredContent.confirm_token });
        expect(radarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=false&blocklist=true');
    });

    // With nothing to record an ignore against, the row would only be untracked until the next refresh.
    it('refuses to keep an orphaned row\'s download, with or without blocklist, before any delete', async () => {
        const h = harness(registerRemoveQueueItem);
        for (const blocklist of [false, true]) {
            for (const dry_run of [false, true]) {
                await expect(h.call({ service: 'radarr', id: '91', remove_from_client: false, blocklist, dry_run })).rejects.toMatchObject({
                    kind: 'NotFound',
                    message: ORPHAN_REFUSAL
                });
            }
        }
        expect(h.radarr.sent.filter(s => s.method === 'DELETE')).toEqual([]);
        // With a download id the record is read first; without one there is nothing to blocklist.
        const { h: read, radarr, reads } = radarrWith({ '/api/v3/queue': { records: [ORPHAN] }, '/api/v3/history': { records: [] } });
        await expect(read.call({ service: 'radarr', id: '91', remove_from_client: false, blocklist: true })).rejects.toMatchObject({ message: ORPHAN_REFUSAL });
        expect(reads().map(s => s.search)).toEqual([HISTORY_READ]);
        expect(radarr.sent.filter(s => s.method === 'DELETE')).toEqual([]);
    });

    // Lidarr also needs the row's albums to ignore a download (`IgnoredDownloadService`).
    it('refuses to keep a Lidarr download whose row names no album, and keeps one that does', async () => {
        for (const albumId of [null, undefined]) {
            const lidarr = recordingFetch({ '/api/v1/queue': { records: [{ ...LIDARR_QUEUE.records[0], albumId }] } });
            const h = harness(registerRemoveQueueItem, { adapters: [new LidarrAdapter(keyed(8686), lidarr.impl)], permissions: { lidarr: tiered(false, true) } });
            await expect(h.call({ service: 'lidarr', id: '91', remove_from_client: false, dry_run: true })).rejects.toMatchObject({
                kind: 'NotFound',
                message: `lidarr not found: lidarr matched no album to this download, so it cannot leave the download alone and drop the row. ${KEPT_ALONE}`
            });
            expect(lidarr.sent.filter(s => s.method === 'DELETE')).toEqual([]);
        }
        const h = harness(registerRemoveQueueItem);
        const first = await h.call({ service: 'lidarr', id: '91', remove_from_client: false });
        expect(first.structuredContent.effects).toEqual(["Removes it from lidarr's queue but leaves the download itself alone."]);
        await h.call({ service: 'lidarr', id: '91', remove_from_client: false, confirm: first.structuredContent.confirm_token });
        expect(h.lidarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=false&blocklist=false');
        // Blocklisted, a row with no album is failed rather than ignored, so it can be kept.
        const lidarr = recordingFetch({ '/api/v1/queue': { records: [{ ...LIDARR_QUEUE.records[0], albumId: null }] }, '/api/v1/history': GRABBED });
        const hb = harness(registerRemoveQueueItem, { adapters: [new LidarrAdapter(keyed(8686), lidarr.impl)], permissions: { lidarr: tiered(false, true) } });
        const kept = await hb.call({ service: 'lidarr', id: '91', remove_from_client: false, blocklist: true });
        expect(kept.structuredContent.effects[1]).toBe('Blocklists this release (remove_blocklist_item undoes it); lidarr may still delete it from the client, and search for a replacement.');
        await hb.call({ service: 'lidarr', id: '91', remove_from_client: false, blocklist: true, confirm: kept.structuredContent.confirm_token });
        expect(lidarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=false&blocklist=true');
    });

    it('blocklists nothing for a Lidarr row whose artist is gone and whose grab record went with it', async () => {
        const lidarr = recordingFetch({ '/api/v1/queue': { records: [{ ...LIDARR_QUEUE.records[0], artistId: undefined }] }, '/api/v1/history': { records: [] } });
        const h = harness(registerRemoveQueueItem, { adapters: [new LidarrAdapter(keyed(8686), lidarr.impl)], permissions: { lidarr: tiered(false, true) } });
        const first = await h.call({ service: 'lidarr', id: '91', blocklist: true });
        expect(first.structuredContent.effects.join(' ')).toContain('Not blocklisted: lidarr lists no grab of this download.');
        await h.call({ service: 'lidarr', id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });
        expect(lidarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=true&blocklist=false');
        expect(lidarr.sent.filter(s => s.path === '/api/v1/history').map(s => s.search)).toEqual([HISTORY_READ, HISTORY_READ]);
    });

    // Without the record Radarr blocklists nothing, and from Sonarr 5.0.0.2569 the
    // DELETE fails after removing the download. Each plan reads the record once.
    it('blocklists a tracked row only when its service has the grab record, on all four', async () => {
        const cases = [
            { service: 'radarr', root: '/api/v3', make: (f: typeof fetch) => new RadarrAdapter(keyed(7878), f), row: KNOWN },
            {
                service: 'sonarr',
                root: '/api/v3',
                make: (f: typeof fetch) => new SonarrAdapter(keyed(8989), f),
                row: { id: 91, title: 'Some.Show.S01E01-GROUP', status: 'downloading', seriesId: 7, downloadId: 'nzo-91' }
            },
            {
                service: 'whisparr',
                root: '/api/v3',
                make: (f: typeof fetch) => new WhisparrAdapter(keyed(6969), f),
                row: { id: 91, title: 'Scene.1.1080p.WEB-DL.x264-GROUP', status: 'downloading', seriesId: 7, downloadId: 'nzo-91' }
            },
            { service: 'lidarr', root: '/api/v1', make: (f: typeof fetch) => new LidarrAdapter(keyed(8686), f), row: LIDARR_QUEUE.records[0] }
        ];
        for (const c of cases) {
            for (const recorded of [true, false]) {
                const service = recordingFetch({ [`${c.root}/queue`]: { records: [c.row] }, [`${c.root}/history`]: recorded ? GRABBED : { records: [] } });
                const h = harness(registerRemoveQueueItem, { adapters: [c.make(service.impl)], permissions: { [c.service]: tiered(false, true) } });
                const first = await h.call({ service: c.service, id: '91', blocklist: true });
                expect(first.structuredContent.effects[1]).toBe(
                    recorded
                        ? `Blocklists this release (remove_blocklist_item undoes it); ${c.service} may also search for a replacement.`
                        : `Not blocklisted: ${c.service} lists no grab of this download.`
                );
                await h.call({ service: c.service, id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });
                expect(service.sent.filter(s => s.path === `${c.root}/history`).map(s => s.search)).toEqual([HISTORY_READ, HISTORY_READ]);
                expect(service.sent.find(s => s.method === 'DELETE')?.search).toBe(`?removeFromClient=true&blocklist=${String(recorded)}`);
            }
        }
    });

    // Only a grab of this very download counts. An answer that lists other
    // downloads was not filtered, so it is not read as no record.
    it('counts only a grab of this very download, and refuses an answer that lists other downloads', async () => {
        const same = [{ eventType: 'downloadFailed', downloadId: 'nzo-91' }, null];
        const without = recordingFetch({ '/api/v3/history': { records: same } });
        expect(await new RadarrAdapter(keyed(7878), without.impl).grabRecorded('nzo-91')).toBe(false);
        const withIt = recordingFetch({ '/api/v1/history': { records: [...same, ...GRABBED.records] } });
        expect(await new LidarrAdapter(keyed(8686), withIt.impl).grabRecorded('nzo-91')).toBe(true);
        for (const other of [{ eventType: 'grabbed', downloadId: 'nzo-9' }, { eventType: 'grabbed' }]) {
            const unfiltered = recordingFetch({ '/api/v3/history': { records: [other, ...GRABBED.records] } });
            await expect(new SonarrAdapter(keyed(8989), unfiltered.impl).grabRecorded('nzo-91')).rejects.toMatchObject({
                kind: 'UpstreamError',
                message:
                    'sonarr upstream error: its history was not filtered to download nzo-91, so whether that grab is recorded is unknown. Leave out blocklist to remove it without one.'
            });
        }
    });

    // The token covers the blocklist the preview resolved: a record that has gone since needs a new preview.
    it('rejects a confirm once the grab record has changed since the preview', async () => {
        const routes: Record<string, unknown> = { '/api/v3/queue': { records: [KNOWN] }, '/api/v3/history': GRABBED };
        const { h, radarr } = radarrWith(routes);
        const first = await h.call({ service: 'radarr', id: '91', blocklist: true });
        routes['/api/v3/history'] = { records: [] };
        const again = await h.call({ service: 'radarr', id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });
        expect(again.structuredContent.confirm_error).toBeDefined();
        expect(again.structuredContent.effects[1]).toBe('Not blocklisted: radarr lists no grab of this download.');
        expect(radarr.sent.filter(s => s.method === 'DELETE')).toEqual([]);
    });

    // The service skips the filter for an empty id, so there is nothing to ask it.
    it('blocklists nothing for a row with no download id, or an empty one, reading no history', async () => {
        for (const downloadId of [undefined, ' ']) {
            const { h, radarr, reads } = radarrWith({ '/api/v3/queue': { records: [{ ...ARR_QUEUE.records[0], movieId: 412, downloadId }] } });
            const first = await h.call({ service: 'radarr', id: '91', blocklist: true });
            expect(first.structuredContent.effects[1]).toBe('Not blocklisted: radarr lists no grab of this download.');
            await h.call({ service: 'radarr', id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });
            expect(radarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=true&blocklist=false');
            expect(reads()).toEqual([]);
        }
    });

    // The read comes before the refusal, so an unfiltered answer is what an orphaned row kept with a blocklist meets first.
    it('fails the preview on an unfiltered answer before refusing to keep an orphaned row', async () => {
        const { h, radarr } = radarrWith({ '/api/v3/queue': { records: [ORPHAN] }, '/api/v3/history': { records: [{ eventType: 'grabbed', downloadId: 'nzo-9' }] } });
        await expect(h.call({ service: 'radarr', id: '91', blocklist: true, remove_from_client: false })).rejects.toMatchObject({
            kind: 'UpstreamError',
            message: expect.stringContaining('radarr upstream error: its history was not filtered to download nzo-91')
        });
        expect(radarr.sent.filter(s => s.method === 'DELETE')).toEqual([]);
    });

    it('fails the preview when the grab record cannot be read, rather than guess either way', async () => {
        const { h, radarr } = radarrWith({ '/api/v3/queue': { records: [KNOWN] } });
        await expect(h.call({ service: 'radarr', id: '91', blocklist: true })).rejects.toMatchObject({ kind: 'NotFound', message: expect.stringContaining('radarr not found: HTTP 404 at /api/v3/history') });
        expect(radarr.sent.map(s => s.path)).toEqual(['/api/v3/queue', '/api/v3/history']);
    });

    // A blocklist marks the download failed, and Radarr's Remove Failed may then delete it after all.
    it('keeps a known row\'s download when asked, and says a blocklist may delete it after all', async () => {
        const { h, radarr } = radarrWith({ '/api/v3/queue': { records: [KNOWN] }, '/api/v3/history': GRABBED });
        const first = await h.call({ service: 'radarr', id: '91', blocklist: true, remove_from_client: false });
        expect(first.structuredContent.effects).toEqual([
            "Removes it from radarr's queue but leaves the download itself alone.",
            'Blocklists this release (remove_blocklist_item undoes it); radarr may still delete it from the client, and search for a replacement.'
        ]);
        await h.call({ service: 'radarr', id: '91', blocklist: true, remove_from_client: false, confirm: first.structuredContent.confirm_token });
        expect(radarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=false&blocklist=true');
    });

    // Sent with `blocklist=false`, the DELETE ignores the download instead, which keeps it out of the queue.
    it('keeps a known row without its grab record by ignoring it, not blocklisting it', async () => {
        const { h, radarr } = radarrWith({ '/api/v3/queue': { records: [KNOWN] }, '/api/v3/history': { records: [] } });
        const first = await h.call({ service: 'radarr', id: '91', blocklist: true, remove_from_client: false });
        expect(first.structuredContent.effects).toEqual([
            "Removes it from radarr's queue but leaves the download itself alone.",
            'Not blocklisted: radarr lists no grab of this download.'
        ]);
        await h.call({ service: 'radarr', id: '91', blocklist: true, remove_from_client: false, confirm: first.structuredContent.confirm_token });
        expect(radarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=false&blocklist=false');
    });

    it('reads no history when no blocklist is asked for', async () => {
        const { h, radarr, reads } = radarrWith({ '/api/v3/queue': { records: [KNOWN] }, '/api/v3/history': GRABBED });
        for (const remove_from_client of [true, false]) {
            const first = await h.call({ service: 'radarr', id: '91', remove_from_client });
            await h.call({ service: 'radarr', id: '91', remove_from_client, confirm: first.structuredContent.confirm_token });
        }
        expect(reads()).toEqual([]);
        expect(radarr.sent.filter(s => s.method === 'DELETE').map(s => s.search)).toEqual([
            '?removeFromClient=true&blocklist=false',
            '?removeFromClient=false&blocklist=false'
        ]);
    });

    // A release the service is holding back is blocklisted directly: no grab yet, and no search after.
    it('blocklists a pending release without reading history, and says nothing was sent to a client', async () => {
        for (const status of ['delay', 'downloadClientUnavailable', 'fallback']) {
            const { h, radarr, reads } = radarrWith({ '/api/v3/queue': { records: [{ ...ARR_QUEUE.records[0], status, movieId: 412 }] } });
            const first = await h.call({ service: 'radarr', id: '91', blocklist: true });
            expect(first.structuredContent.effects).toEqual([
                'Drops this pending release from radarr; nothing has gone to a download client yet.',
                'Blocklists this release (remove_blocklist_item undoes it).'
            ]);
            await h.call({ service: 'radarr', id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });
            expect(radarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=true&blocklist=true');
            expect(reads()).toEqual([]);
        }
        // Lidarr sends the reason through FirstCharToLower, an album row as its own shape.
        const lidarr = recordingFetch({ '/api/v1/queue': { records: [{ ...LIDARR_QUEUE.records[0], status: 'delay' }] } });
        const h = harness(registerRemoveQueueItem, { adapters: [new LidarrAdapter(keyed(8686), lidarr.impl)], permissions: { lidarr: tiered(false, true) } });
        const first = await h.call({ service: 'lidarr', id: '91', blocklist: true });
        expect(first.structuredContent.effects).toEqual([
            'Drops this pending release from lidarr; nothing has gone to a download client yet.',
            'Blocklists this release (remove_blocklist_item undoes it).'
        ]);
        await h.call({ service: 'lidarr', id: '91', blocklist: true, confirm: first.structuredContent.confirm_token });
        expect(lidarr.sent.find(s => s.method === 'DELETE')?.search).toBe('?removeFromClient=true&blocklist=true');
        expect(lidarr.sent.filter(s => s.path === '/api/v1/history')).toEqual([]);
    });

    it('records the instance in the audit target, not the bare service', async () => {
        const spare = { ...tiered(false, true), name: 'spare' } as never;
        const sabQueue = {
            queue: { slots: [{ nzo_id: 'SABnzbd_nzo_ab12', filename: 'Alien.1979-GROUP', status: 'Downloading' }] }
        };
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.search.includes('name=delete')) return jsonResponse({ status: true });
            return jsonResponse(sabQueue);
        }) as unknown as typeof fetch;

        const h = harness(registerRemoveQueueItem, {
            adapters: [new SabnzbdAdapter(spare, impl)],
            permissions: { sabnzbd: spare }
        });

        const first = await h.call({ service: 'sabnzbd', instance: 'spare', id: 'SABnzbd_nzo_ab12' });
        await h.call({
            service: 'sabnzbd',
            instance: 'spare',
            id: 'SABnzbd_nzo_ab12',
            confirm: first.structuredContent.confirm_token
        });

        expect(h.audit.recent(10)[0]?.target).toBe('sabnzbd/spare:SABnzbd_nzo_ab12');
    });

    it('is refused by safe_write alone', async () => {
        const h = harness(registerRemoveQueueItem, { permissions: { radarr: tiered(true, false) } });
        await expect(h.call({ service: 'radarr', id: '91' })).rejects.toThrow(
            /services\.radarr\.permissions\.destructive: true/
        );
    });
});

describe('set_monitoring', () => {
    const routes = { '/api/v3/series/7': SERIES_FULL };

    it('is a safe-tier write, allowed by safe_write alone', async () => {
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch(routes).impl)]
        });
        const first = await call({ service: 'sonarr', id: '7', monitored: false, season: 2 });
        expect(first.structuredContent.tier).toBe('safe');
        expect(first.structuredContent.permission.allowed).toBe(true);
    });

    it('names the target in the preview rather than an id', async () => {
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch(routes).impl)]
        });
        const preview = await call({ service: 'sonarr', id: '7', monitored: false, season: 2 });
        expect(preview.structuredContent.summary).toContain('season 2');
        expect(preview.structuredContent.summary).toContain('Alien: Earth');
        expect(preview.structuredContent.applied).toBe(false);
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('does not call a season a no-op when its episodes disagree with the aggregate', async () => {
        // `seasons[].monitored` is a UI aggregate over the episode flags —
        // delete_episode_files.ts says so at length. This tool's own episode
        // form writes episode flags without touching the aggregate, so a
        // season can read `monitored: false` while its episodes are monitored.
        // Trusting the aggregate then answers "no change was made" to a
        // request to unmonitor, writes nothing, and leaves Sonarr downloading
        // exactly what the caller went on to delete.
        const disagreeing = {
            ...SERIES_FULL,
            seasons: [
                { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8 } },
                { seasonNumber: 2, monitored: false, statistics: { episodeFileCount: 2 } }
            ]
        };
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [
                new SonarrAdapter(
                    keyed(8989),
                    recordingFetch({ '/api/v3/series/7': disagreeing, '/api/v3/episode?seriesId=7': EPISODES_S2 }).impl
                )
            ]
        });

        const preview = await call({ service: 'sonarr', id: '7', monitored: false, season: 2 });
        expect(preview.structuredContent.noop).not.toBe(true);
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('is a no-op when the whole series is already in the requested state', async () => {
        // The series' own `monitored` is a value Sonarr actually holds, so the
        // claim is sound here — unlike the per-season aggregate. A confirmation
        // prompt for a genuine no-op trains a model to confirm reflexively.
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch(routes).impl)]
        });
        const result = await call({ service: 'sonarr', id: '7', monitored: true });
        expect(result.structuredContent.noop).toBe(true);
        expect(result.structuredContent).not.toHaveProperty('confirm_token');
    });

    it('refuses season and episodes together instead of picking one', async () => {
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch(routes).impl)]
        });
        await expect(
            call({ service: 'sonarr', id: '7', monitored: false, season: 2, episodes: ['11'] })
        ).rejects.toThrow(/both/i);
    });

    it('refuses a service that cannot monitor', async () => {
        const { call } = harness(registerSetMonitoring, {
            permissions: { radarr: tiered(true, false) },
            adapters: [new RadarrAdapter(keyed(7878), recordingFetch({}).impl)]
        });
        await expect(call({ service: 'radarr', id: '412', monitored: false })).rejects.toThrow(ServiceError);
    });

    // Previously: a season the series does not have produced no noop, planned
    // happily, and made Sonarr PUT the series back unchanged — `applied: true`
    // for a write that provably did nothing, after which a caller believing
    // the season is unmonitored goes on to delete its files.
    it('refuses a season the series does not have, naming the ones it does', async () => {
        const recorder = recordingFetch(routes);
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });
        await expect(call({ service: 'sonarr', id: '7', monitored: false, season: 9 })).rejects.toThrow(/season 9/);
        await expect(call({ service: 'sonarr', id: '7', monitored: false, season: 9 })).rejects.toThrow(/1, 2/);
        expect(recorder.sent.filter(s => s.method === 'PUT')).toHaveLength(0);
    });

    // The episode list was already being fetched and then thrown away, so an
    // id that does not exist reached Sonarr as an unvalidated PUT.
    it('refuses an episode id it could not find rather than PUTting it blind', async () => {
        const recorder = recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': EPISODES_S2 });
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });
        await expect(call({ service: 'sonarr', id: '7', monitored: false, episodes: ['11', '999'] })).rejects.toThrow(
            /999/
        );
        expect(recorder.sent.filter(s => s.method === 'PUT')).toHaveLength(0);
    });

    // The four tests below are the mutating path: a confirm-token round trip
    // for each of the three targets, asserting the actual outgoing PUT rather
    // than just the tool's own report of success. TypeScript catches a wrong
    // field name on `episodeIds`; it does not catch an inverted mapping, a
    // wrong value, or `season` leaking into the episode call.

    it('applies to a whole series once confirmed', async () => {
        const recorder = recordingFetch(routes);
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });
        const first = await call({ service: 'sonarr', id: '7', monitored: false });
        const second = await call({
            service: 'sonarr',
            id: '7',
            monitored: false,
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        const put = recorder.sent.find(s => s.method === 'PUT');
        expect(put?.path).toBe('/api/v3/series/7');
        expect((put?.body as { monitored: boolean }).monitored).toBe(false);
    });

    it('applies to one season and leaves the other alone once confirmed', async () => {
        const recorder = recordingFetch(routes);
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });
        const first = await call({ service: 'sonarr', id: '7', monitored: false, season: 2 });
        const second = await call({
            service: 'sonarr',
            id: '7',
            monitored: false,
            season: 2,
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        const put = recorder.sent.find(s => s.method === 'PUT');
        expect(put?.path).toBe('/api/v3/series/7');
        // Season 1 untouched is the assertion that matters — a PUT that
        // rewrites every season would silently unmonitor the whole show.
        expect((put?.body as { seasons: unknown[] }).seasons).toEqual([
            { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8 } },
            { seasonNumber: 2, monitored: false, statistics: { episodeFileCount: 2 } }
        ]);
    });

    it('applies to specific episodes, on the episode endpoint, once confirmed', async () => {
        // The preview reads episodes (includeEpisodes: true) and now validates
        // the requested ids against them, so the episode list endpoint needs a
        // route carrying the ids being asked for.
        const recorder = recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': EPISODES_S2 });
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });
        const first = await call({ service: 'sonarr', id: '7', monitored: false, episodes: ['11', '12'] });
        const second = await call({
            service: 'sonarr',
            id: '7',
            monitored: false,
            episodes: ['11', '12'],
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        const put = recorder.sent.find(s => s.method === 'PUT');
        expect(put?.path).toBe('/api/v3/episode/monitor');
        // The tool's `episodes` (strings) becoming the adapter's `episodeIds`
        // (numbers) is the one translation the brief singles out — a mapping
        // TypeScript would not catch if it were inverted or dropped a value.
        expect(put?.body).toEqual({ episodeIds: [11, 12], monitored: false });
        expect(recorder.sent.filter(s => s.path === '/api/v3/series/7' && s.method === 'PUT')).toHaveLength(0);
    });

    // `plan` throws before `write.ts` ever reaches its dry-run branch, so a
    // dry run does not bypass the both-given refusal. Correct today; this pins it.
    it('refuses season and episodes together even on a dry run', async () => {
        const { call } = harness(registerSetMonitoring, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch(routes).impl)]
        });
        await expect(
            call({ service: 'sonarr', id: '7', monitored: false, season: 2, episodes: ['11'], dry_run: true })
        ).rejects.toThrow(/both/i);
    });
});

describe('delete_episode_files', () => {
    const routes = {
        '/api/v3/series/7': SERIES_FULL,
        '/api/v3/episode?seriesId=7': EPISODES_S2,
        '/api/v3/episodefile?seriesId=7': EPISODE_FILES
    };
    const sonarrWith = () => new SonarrAdapter(keyed(8989), recordingFetch(routes).impl);

    it('is destructive tier — safe_write alone is refused', async () => {
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(true, false) },
            adapters: [sonarrWith()]
        });
        await expect(call({ service: 'sonarr', id: '7', season: 2 })).rejects.toThrow(ServiceError);
    });

    it('names the file count and the size in the preview', async () => {
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [sonarrWith()]
        });
        const preview = await call({ service: 'sonarr', id: '7', season: 2 });
        expect(preview.structuredContent.summary).toContain('2 episode file');
        expect(preview.structuredContent.summary).toContain('8.4 GB');
    });

    it('warns that a monitored season will be re-downloaded', async () => {
        // The whole reason two primitives are safe to ship separately.
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [sonarrWith()]
        });
        const preview = await call({ service: 'sonarr', id: '7', season: 2 });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/still monitored.*re-download/i);
    });

    it('does not warn when nothing in the season is monitored', async () => {
        // A warning that always fires is noise nobody reads. The season
        // aggregate is left at `monitored: true` on purpose: the episodes are
        // what Sonarr searches on, so a stale aggregate must not manufacture a
        // warning any more than it may suppress one.
        const unmonitored = EPISODES_S2.map(e => ({ ...e, monitored: false }));
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [
                new SonarrAdapter(
                    keyed(8989),
                    recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': unmonitored }).impl
                )
            ]
        });
        const preview = await call({ service: 'sonarr', id: '7', season: 2 });
        expect(preview.structuredContent.effects.join(' ')).not.toMatch(/re-download/i);
    });

    // The state this branch itself creates: `set_monitoring { episodes }`
    // writes episode flags and never touches the season aggregate, so a season
    // can read `monitored: false` while its episodes are monitored. Reading the
    // aggregate left the preview silent while Sonarr re-downloaded everything
    // just deleted — the one thing the two-primitive design leans on.
    it('warns from the episode flags even when the season aggregate says unmonitored', async () => {
        const staleAggregate = {
            ...SERIES_FULL,
            seasons: [
                { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8 } },
                { seasonNumber: 2, monitored: false, statistics: { episodeFileCount: 2 } }
            ]
        };
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [
                new SonarrAdapter(
                    keyed(8989),
                    recordingFetch({ ...routes, '/api/v3/series/7': staleAggregate }).impl
                )
            ]
        });
        const preview = await call({ service: 'sonarr', id: '7', season: 2 });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/still monitored.*re-download/i);
    });

    // The episode read is capped at 500 and sliced in Sonarr's own order, so on
    // a series longer than that the targeted season's episodes can fall outside
    // the window entirely: `stillMonitored` comes back empty for a season that
    // really is monitored, and the warning — the whole mitigation for shipping
    // two primitives rather than one cleanup_season — would simply not fire.
    // The delete itself stays exact, because the file ids come from
    // `listEpisodeFiles`, which is not truncated; only the advisory has a hole.
    it('says the monitoring state could not be checked when the episode list was truncated', async () => {
        // 500 season-1 episodes fill the window; season 2's two, both
        // monitored, sit past it and are never fetched.
        const LONG = [
            ...Array.from({ length: 500 }, (_, i) => ({
                id: 1000 + i,
                seasonNumber: 1,
                episodeNumber: i + 1,
                title: `Ep${i + 1}`,
                hasFile: true,
                monitored: false,
                episodeFileId: 101
            })),
            ...EPISODES_S2
        ];
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [
                new SonarrAdapter(keyed(8989), recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': LONG }).impl)
            ]
        });

        const preview = await call({ service: 'sonarr', id: '7', season: 2 });
        const effects = preview.structuredContent.effects.join(' ');
        // A gap in what could be checked, said as one — not silence, which
        // reads as "nothing is monitored".
        expect(effects).toMatch(/could not be established/i);
        expect(effects).toMatch(/truncated at 500/i);
        // Still a preview of a real delete, not a refusal.
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('does not add the truncation caveat when the whole episode list was seen', async () => {
        // Otherwise the caveat becomes permanent noise on every ordinary
        // series, which is how a warning stops being read.
        const unmonitored = EPISODES_S2.map(e => ({ ...e, monitored: false }));
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [
                new SonarrAdapter(
                    keyed(8989),
                    recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': unmonitored }).impl
                )
            ]
        });
        const preview = await call({ service: 'sonarr', id: '7', season: 2 });
        expect(preview.structuredContent.effects.join(' ')).not.toMatch(/could not be established|truncated/i);
    });

    it('names the instance in the summary, for a delete and for a no-op', async () => {
        const named = { ...tiered(false, true), name: '4k' } as never;
        const call = (files: unknown) =>
            harness(registerDeleteEpisodeFiles, {
                permissions: { sonarr: named },
                adapters: [new SonarrAdapter(named, recordingFetch({ ...routes, '/api/v3/episodefile?seriesId=7': files }).impl)]
            }).call;

        const preview = await call(EPISODE_FILES)({ service: 'sonarr', instance: '4k', id: '7', season: 2 });
        expect(preview.structuredContent.summary).toMatch(/^Delete 2 episode file\(s\) from season 2 of .* in sonarr\/4k, 8\.4 GB from disk\.$/);
        const empty = await call(EPISODE_FILES.filter(f => f.seasonNumber !== 1))({ service: 'sonarr', instance: '4k', id: '7', season: 1 });
        expect(empty.structuredContent.noop).toBe(true);
        expect(empty.structuredContent.summary).toMatch(/^season 1 of .* in sonarr\/4k has no files on disk\.$/);
    });

    it('counts the episodes it looked at in a no-op for episodes with no file', async () => {
        const noFiles = EPISODES_S2.map(e => ({ ...e, hasFile: false, episodeFileId: 0 }));
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': noFiles }).impl)]
        });

        const both = await call({ service: 'sonarr', id: '7', episodes: ['11', '12'] });
        expect(both.structuredContent.noop).toBe(true);
        expect(both.structuredContent.summary).toMatch(/^2 episode\(s\) of .* in sonarr have no files on disk\.$/);
        const one = await call({ service: 'sonarr', id: '7', episodes: ['11'] });
        expect(one.structuredContent.summary).toMatch(/^1 episode\(s\) of .* in sonarr has no files on disk\.$/);
    });

    it('is a no-op for a season with no files on disk', async () => {
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [
                new SonarrAdapter(
                    keyed(8989),
                    recordingFetch({
                        ...routes,
                        '/api/v3/episodefile?seriesId=7': EPISODE_FILES.filter(f => f.seasonNumber !== 1)
                    }).impl
                )
            ]
        });
        const result = await call({ service: 'sonarr', id: '7', season: 1 });
        expect(result.structuredContent.noop).toBe(true);
        expect(result.structuredContent).not.toHaveProperty('confirm_token');
    });

    it('refuses a season the series does not have, naming the ones it does', async () => {
        // Not a no-op: "season 5 has no files on disk" claims a season was
        // looked at. On Whisparr a season is a release year, so `season: 1`
        // is the likeliest wrong input and must not read as "looked, empty".
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [sonarrWith()]
        });
        await expect(call({ service: 'sonarr', id: '7', season: 5 })).rejects.toThrow(/has no season 5/);
        await expect(call({ service: 'sonarr', id: '7', season: 5 })).rejects.toMatchObject({
            remedy: expect.stringContaining('1, 2')
        });
    });

    // The token binds the *resolved fileIds*, not the season number, and
    // `write.ts` (the shared harness) always re-resolves `plan` fresh — on the
    // preview call and on the confirm call alike — then verifies the presented
    // token against whatever that fresh resolution just produced. So binding
    // `season: 2` instead would let a file that lands in the season between
    // preview and confirm ride along into the delete on the *original* token,
    // silently swept up. Binding the concrete ids instead means that same
    // scenario makes the token's signature stop matching, and the harness
    // refuses rather than applying a delete nobody previewed. The write is not
    // lost — refusing hands back a fresh token, and confirming *that* one
    // correctly captures the file that had landed.
    it('refuses a stale token rather than sweeping a newly-imported file into the delete', async () => {
        const files = [...EPISODE_FILES];
        const recorder = recordingFetch({
            '/api/v3/series/7': SERIES_FULL,
            '/api/v3/episode?seriesId=7': EPISODES_S2,
            '/api/v3/episodefile?seriesId=7': files
        });
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });

        const preview = await call({ service: 'sonarr', id: '7', season: 2 });
        const staleToken = preview.structuredContent.confirm_token;
        expect(preview.structuredContent.target).toBe('sonarr:7:s2');

        // A new file lands in season 2 after the preview was taken.
        files.push({ id: 104, seriesId: 7, seasonNumber: 2, size: 1_000_000_000 });

        const rejected = await call({ service: 'sonarr', id: '7', season: 2, confirm: staleToken });
        expect(rejected.structuredContent.applied).toBe(false);
        expect(rejected.structuredContent.confirm_error).toBeDefined();
        expect(recorder.sent.filter(s => s.method === 'DELETE')).toHaveLength(0);

        // Confirming the *fresh* token the refusal handed back applies against
        // the now-current, correctly-resolved set — including the new file.
        const freshToken = rejected.structuredContent.confirm_token;
        await call({ service: 'sonarr', id: '7', season: 2, confirm: freshToken });
        const del = recorder.sent.find(s => s.method === 'DELETE');
        expect(del?.body).toEqual({ episodeFileIds: [102, 103, 104] });
    });

    // Not in the brief, but the mutating path for the `episodes` target needs
    // the same confirm-token-to-apply coverage the season target got above —
    // an earlier task on this branch shipped with its mutating path untested
    // and had to be sent back for exactly this gap.
    it('deletes only the files behind the given episode ids, through apply', async () => {
        const RAW_EPISODES = [
            { id: 11, seasonNumber: 2, episodeNumber: 1, title: 'Ep1', hasFile: true, monitored: true, episodeFileId: 102 },
            { id: 12, seasonNumber: 2, episodeNumber: 2, title: 'Ep2', hasFile: true, monitored: true, episodeFileId: 103 }
        ];
        const recorder = recordingFetch({
            '/api/v3/series/7': SERIES_FULL,
            '/api/v3/episode?seriesId=7': RAW_EPISODES,
            '/api/v3/episodefile?seriesId=7': EPISODE_FILES
        });
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });

        const preview = await call({ service: 'sonarr', id: '7', episodes: ['11', '12'] });
        expect(preview.structuredContent.applied).toBe(false);
        const token = preview.structuredContent.confirm_token;

        const applied = await call({ service: 'sonarr', id: '7', episodes: ['11', '12'], confirm: token });
        expect(applied.structuredContent.applied).toBe(true);

        // The assertion that matters: the outgoing DELETE body carries the
        // *file* ids resolved from the episode ids, not the episode ids
        // themselves, and not season 1's file (101).
        const del = recorder.sent.find(s => s.method === 'DELETE');
        expect(del?.path).toBe('/api/v3/episodefile/bulk');
        expect(del?.body).toEqual({ episodeFileIds: [102, 103] });
    });

    it('refuses season and episodes together', async () => {
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [sonarrWith()]
        });
        await expect(
            call({ service: 'sonarr', id: '7', season: 2, episodes: ['11'] })
        ).rejects.toThrow(/both/i);
    });

    // Review round 2: three findings on the `episodes` path specifically.

    it('warns that a monitored targeted episode will be re-downloaded', async () => {
        // The episodes-target counterpart to the season warning above — the
        // whole mitigation has a hole if only one of the two targets warns.
        const RAW = [
            { id: 11, seasonNumber: 2, episodeNumber: 1, title: 'Ep1', hasFile: true, monitored: true, episodeFileId: 102 }
        ];
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': RAW }).impl)]
        });
        const preview = await call({ service: 'sonarr', id: '7', episodes: ['11'] });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/still monitored.*re-download/i);
    });

    it('does not warn when the targeted episode is already unmonitored', async () => {
        const RAW = [
            { id: 11, seasonNumber: 2, episodeNumber: 1, title: 'Ep1', hasFile: true, monitored: false, episodeFileId: 102 }
        ];
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': RAW }).impl)]
        });
        const preview = await call({ service: 'sonarr', id: '7', episodes: ['11'] });
        expect(preview.structuredContent.effects.join(' ')).not.toMatch(/re-download/i);
    });

    it('refuses rather than silently dropping an episode id it could not find', async () => {
        // Previously: an id past the episode cap, or simply wrong, vanished
        // from `fileIds` with nothing said — a 700-episode series asking for
        // an id past the 500-episode cap got told "nothing to delete" about
        // files that exist. The truth is "I could not see that episode".
        const RAW = [
            { id: 11, seasonNumber: 2, episodeNumber: 1, title: 'Ep1', hasFile: true, monitored: false, episodeFileId: 102 }
        ];
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': RAW }).impl)]
        });
        await expect(call({ service: 'sonarr', id: '7', episodes: ['11', '999'] })).rejects.toThrow(/999/);
    });

    it('names a collateral episode that shares a file with the one actually requested', async () => {
        // Sonarr stores a double episode as one `episodefile`. Targeting only
        // episode 11 still takes episode 12's file with it — the preview must
        // say so, not silently delete an episode nobody named.
        const DOUBLE = [
            { id: 11, seasonNumber: 2, episodeNumber: 1, title: 'Double A', hasFile: true, monitored: false, episodeFileId: 102 },
            { id: 12, seasonNumber: 2, episodeNumber: 2, title: 'Double B', hasFile: true, monitored: false, episodeFileId: 102 }
        ];
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': DOUBLE }).impl)]
        });
        const preview = await call({ service: 'sonarr', id: '7', episodes: ['11'] });
        expect(preview.structuredContent.effects.join(' ')).toContain('S2E2');
        // One file, but two episodes actually lose one — the preview's episode
        // count must reflect that, not just the one id that was named.
        expect(preview.structuredContent.summary).toContain('2 episode(s)');
    });

    it('dedupes a file shared by two requested episodes in the outgoing delete', async () => {
        // Previously: requesting both halves of a double episode put the same
        // file id in the DELETE body twice ([102, 102]) and the preview's
        // count read "2 episode file(s)" for what is really one file.
        const DOUBLE = [
            { id: 11, seasonNumber: 2, episodeNumber: 1, title: 'Double A', hasFile: true, monitored: false, episodeFileId: 102 },
            { id: 12, seasonNumber: 2, episodeNumber: 2, title: 'Double B', hasFile: true, monitored: false, episodeFileId: 102 }
        ];
        const recorder = recordingFetch({ ...routes, '/api/v3/episode?seriesId=7': DOUBLE });
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recorder.impl)]
        });

        const preview = await call({ service: 'sonarr', id: '7', episodes: ['11', '12'] });
        expect(preview.structuredContent.summary).toContain('1 episode file(s)');
        // Both requested — no collateral to name.
        expect(preview.structuredContent.effects.join(' ')).not.toContain('share');

        const token = preview.structuredContent.confirm_token;
        await call({ service: 'sonarr', id: '7', episodes: ['11', '12'], confirm: token });
        const del = recorder.sent.find(s => s.method === 'DELETE');
        expect(del?.body).toEqual({ episodeFileIds: [102] });
    });
});

describe('delete_episode_files cross-checks', () => {
    const quiet = () => vi.fn<CrossChecker>(async () => ({ warnings: [], unchecked: [] }));
    const routes = {
        '/api/v3/series/7': { ...SERIES_FULL, tvdbId: 424207 },
        '/api/v3/episode?seriesId=7': EPISODES_S2,
        '/api/v3/episodefile?seriesId=7': EPISODE_FILES
    };
    const sonarrHarness = (crossChecks: CrossChecker) =>
        harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch(routes).impl)],
            crossChecks
        });

    it('never says the files stay, since it always deletes them', async () => {
        const crossChecks = quiet();
        await sonarrHarness(crossChecks).call({ service: 'sonarr', id: '7', season: 2, dry_run: true });

        expect(crossChecks.mock.calls[0]?.[0].filesStay).toBeUndefined();
    });

    it('names the season being deleted', async () => {
        const crossChecks = quiet();
        await sonarrHarness(crossChecks).call({ service: 'sonarr', id: '7', season: 2, dry_run: true });

        const [subject, profile] = crossChecks.mock.calls[0] ?? [];
        expect(profile).toBe('delete');
        expect(subject).toMatchObject({
            kind: 'series',
            ids: { tvdb: 424207 },
            acquisition: { service: 'sonarr', id: '7' },
            seasons: [2]
        });
    });

    // The series flag says nothing about one episode, so an empty list (not an absent one) turns the watch warning off.
    it('asks about part of the series, with no season, when episodes were named', async () => {
        const crossChecks = quiet();
        await sonarrHarness(crossChecks).call({ service: 'sonarr', id: '7', episodes: ['11'], dry_run: true });

        expect(crossChecks.mock.calls[0]?.[0].seasons).toEqual([]);
    });

    it('does not ask when there is nothing to delete', async () => {
        const crossChecks = quiet();
        const h = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [
                new SonarrAdapter(keyed(8989), recordingFetch({ ...routes, '/api/v3/episodefile?seriesId=7': [] }).impl)
            ],
            crossChecks
        });
        await h.call({ service: 'sonarr', id: '7', season: 2, dry_run: true });

        expect(crossChecks).not.toHaveBeenCalled();
    });

    it('does not ask about a Whisparr site', async () => {
        const crossChecks = quiet();
        const h = harness(registerDeleteEpisodeFiles, {
            permissions: { whisparr: tiered(false, true) },
            adapters: [new WhisparrAdapter(keyed(6969), recordingFetch(routes).impl)],
            crossChecks
        });
        const { structuredContent } = await h.call({ service: 'whisparr', id: '7', season: 2, dry_run: true });

        expect(structuredContent.summary).toContain('episode file');
        expect(crossChecks).not.toHaveBeenCalled();
    });

    // A subject folded into the token would break it when the title changes in between.
    it('asks only on the preview, and a title that changed does not void the token', async () => {
        const crossChecks = quiet();
        const live: Record<string, unknown> = { ...routes };
        const h = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [new SonarrAdapter(keyed(8989), recordingFetch(live).impl)],
            crossChecks
        });

        const first = await h.call({ service: 'sonarr', id: '7', season: 2 });
        live['/api/v3/series/7'] = { ...SERIES_FULL, title: 'Renamed', tvdbId: 1 };
        const second = await h.call({ service: 'sonarr', id: '7', season: 2, confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(crossChecks).toHaveBeenCalledTimes(1);
    });
});

describe('qBittorrent queue removal', () => {
    const qbittorrentConfig: CredentialServiceConfig = {
        url: 'http://192.0.2.10:8081',
        timeout_ms: 10_000,
        permissions: { safe_write: false, destructive: false }
    };

    const HASH = 'a'.repeat(40);

    /** Form-encoded, so the shared `recordingFetch` (which JSON-parses bodies) does not fit. */
    function formRecorder(existing: unknown[]) {
        const sent: { path: string; method: string; fields: Record<string, string> }[] = [];
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            sent.push({
                path: url.pathname,
                method: init?.method ?? 'GET',
                fields: Object.fromEntries(new URLSearchParams((init?.body as string) ?? ''))
            });
            if (url.pathname.endsWith('/torrents/info')) return jsonResponse(existing);
            return new Response('', { status: 200 });
        }) as unknown as typeof fetch;
        return { impl, sent };
    }

    it('maps removeFromClient to deleteFiles, form-encoded', async () => {
        const { impl, sent } = formRecorder([{ hash: HASH }]);
        await new QbittorrentAdapter(qbittorrentConfig, impl).removeQueueItem(HASH, {
            removeFromClient: true,
            blocklist: false
        });

        const del = sent.find(s => s.method === 'POST');
        expect(del?.path).toBe('/api/v2/torrents/delete');
        expect(del?.fields).toEqual({ hashes: HASH, deleteFiles: 'true' });
    });

    it('keeps downloaded data when removeFromClient is false', async () => {
        const { impl, sent } = formRecorder([{ hash: HASH }]);
        await new QbittorrentAdapter(qbittorrentConfig, impl).removeQueueItem(HASH, {
            removeFromClient: false,
            blocklist: false
        });
        expect(sent.find(s => s.method === 'POST')?.fields.deleteFiles).toBe('false');
    });

    // qBittorrent answers 200 for a hash it has never seen, so without the
    // existence check a typo reports a successful removal of nothing.
    it('refuses an unknown hash rather than reporting a phantom removal', async () => {
        const { impl, sent } = formRecorder([]);
        await expect(
            new QbittorrentAdapter(qbittorrentConfig, impl).removeQueueItem('deadbeef', {
                removeFromClient: true,
                blocklist: false
            })
        ).rejects.toThrow(/not found/i);
        expect(sent.some(s => s.method === 'POST')).toBe(false);
    });
});

/**
 * #201 item 1. Seven write tools built their audit target from the bare
 * `service` string the caller passed rather than the resolved adapter, so with
 * a `radarr/hd` plus `radarr/4k` pair an audit row said `radarr:412` and could
 * not say which library was written to. That had been true since the first
 * multi-instance release, and no test covered it — which is why it survived
 * the fix that corrected the same defect in the queue tools.
 */
describe('audit targets name the instance', () => {
    const namedRadarr = { ...tiered(false, true), name: '4k' } as never;

    const withNamedRadarr = (register: Parameters<typeof harness>[0]) =>
        harness(register, {
            adapters: [
                new RadarrAdapter(
                    namedRadarr,
                    recordingFetch({ '/api/v3/movie/412': MOVIE, '/api/v3/queue': ARR_QUEUE }).impl
                )
            ],
            permissions: { radarr: namedRadarr }
        });

    const applied = async (h: ReturnType<typeof harness>, args: Record<string, unknown>) => {
        const first = await h.call({ ...args, instance: '4k' });
        await h.call({ ...args, instance: '4k', confirm: first.structuredContent.confirm_token });
        return h.audit.recent(10);
    };

    it('delete_media records radarr/4k, not radarr', async () => {
        const h = withNamedRadarr(registerDeleteMedia);
        const rows = await applied(h, { service: 'radarr', id: '412', delete_files: false });

        expect(rows[0]?.target).toBe('radarr/4k:412');
    });

    /** The preview carries the same target, because the confirmation token
     *  binds to it — a token issued against one instance must not spend on
     *  another. */
    it('binds the preview target to the instance too', async () => {
        const h = withNamedRadarr(registerDeleteMedia);
        const { structuredContent } = await h.call({
            service: 'radarr',
            instance: '4k',
            id: '412',
            delete_files: false,
            dry_run: true
        });

        expect(structuredContent.target).toBe('radarr/4k:412');
    });
});

/**
 * M9. `update_media` builds its target the same way the seven tools #201 named
 * did, and the issue's own list missed it. Found by review, not by the sweep
 * that produced the list.
 */
describe('update_media names the instance too', () => {
    it('records radarr/4k, not radarr', async () => {
        const namedRadarr = { ...tiered(false, true), name: '4k' } as never;
        const h = harness(registerUpdateMedia, {
            adapters: [
                new RadarrAdapter(
                    namedRadarr,
                    recordingFetch({ '/api/v3/movie/412': MOVIE, '/api/v3/queue': ARR_QUEUE }).impl
                )
            ],
            permissions: { radarr: namedRadarr }
        });

        const { structuredContent } = await h.call({
            service: 'radarr',
            instance: '4k',
            id: '412',
            monitored: false,
            dry_run: true
        });

        expect(structuredContent.target).toBe('radarr/4k:412');
    });
});
