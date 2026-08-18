import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId, CredentialServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerDeleteEpisodeFiles } from '../src/tools/deleteEpisodeFiles.ts';
import { registerDeleteMedia } from '../src/tools/deleteMedia.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerRemoveQueueItem } from '../src/tools/removeQueueItem.ts';
import { registerSetMonitoring } from '../src/tools/setMonitoring.ts';
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
        const impl2 = (async (input: string | URL | Request, init?: RequestInit) => {
            await impl(input, init);
            return jsonResponse({ result: 'success' });
        }) as unknown as typeof fetch;

        await new TransmissionAdapter(transmissionConfig, impl2).removeQueueItem('3', {
            removeFromClient: true,
            blocklist: false
        });

        const rpc = sent.find(s => s.method === 'POST')?.body as {
            method: string;
            arguments: Record<string, unknown>;
        };
        expect(rpc.method).toBe('torrent-remove');
        expect(rpc.arguments).toEqual({ ids: [3], 'delete-local-data': true });
    });

    // Transmission reports failure as HTTP 200 with a non-success result.
    it('treats a non-success Transmission result as a failure', async () => {
        const impl = (async () => jsonResponse({ result: 'invalid argument' })) as unknown as typeof fetch;
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

function harness(
    register: typeof registerDeleteMedia,
    opts: { permissions?: Partial<Record<ServiceId, AnyServiceConfig>>; adapters?: ServiceAdapter[] } = {}
) {
    const radarr = recordingFetch({ '/api/v3/movie/412': MOVIE, '/api/v3/queue': ARR_QUEUE });
    const sonarr = recordingFetch({ '/api/v3/series/7': SERIES, '/api/v3/queue': ARR_QUEUE });

    const adapters = opts.adapters ?? [
        new RadarrAdapter(keyed(7878), radarr.impl),
        new SonarrAdapter(keyed(8989), sonarr.impl)
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
                instancesOf(opts.permissions ?? { radarr: tiered(false, true), sonarr: tiered(false, true) })
            ),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a), radarr, sonarr, audit, invalidate };
}

describe('delete_media', () => {
    it('names the film and the size on disk, not the id', async () => {
        const h = harness(registerDeleteMedia);
        const { structuredContent } = await h.call({ service: 'radarr', id: '412', delete_files: true, dry_run: true });

        expect(structuredContent.summary).toContain('Alien');
        expect(structuredContent.summary).toContain('24.1 GB');
        expect(structuredContent.tier).toBe('destructive');
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

    it('is a no-op for a season with no files on disk', async () => {
        const { call } = harness(registerDeleteEpisodeFiles, {
            permissions: { sonarr: tiered(false, true) },
            adapters: [sonarrWith()]
        });
        const result = await call({ service: 'sonarr', id: '7', season: 5 });
        expect(result.structuredContent.noop).toBe(true);
        expect(result.structuredContent).not.toHaveProperty('confirm_token');
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
