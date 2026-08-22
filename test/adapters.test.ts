import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig, MultiUserServiceConfig, CredentialServiceConfig } from '../src/config/schema.ts';
import { BazarrAdapter } from '../src/services/bazarr.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { ProwlarrAdapter } from '../src/services/prowlarr.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { SeerrAdapter } from '../src/services/seerr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import {
    hasDiskSpace,
    hasHealthChecks,
    hasScanState,
    hasUserDirectory,
    type ServiceAdapter
} from '../src/services/types.ts';
import { jsonResponse, serving, servingModes } from './helpers/serve.ts';

/**
 * These drive the adapters off the **recorded fixtures**, not off shapes
 * invented in a plan. That is the whole point of the capture gate: if upstream
 * changes, the fixture changes and these fail.
 */
const fixture = (path: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', path), 'utf8'));

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const multiUser = (port: number): MultiUserServiceConfig => ({
    ...keyed(port),
    allow_other_users: false
});

const transmissionConfig: CredentialServiceConfig = {
    url: 'http://192.0.2.10:9091',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const qbittorrentConfig: CredentialServiceConfig = {
    url: 'http://192.0.2.10:8081',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const unauthorized = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;

/** Every adapter must diagnose rather than throw — design spec §6/§14. */
const expectsAuthDiagnosis = (adapter: ServiceAdapter) =>
    it(`${adapter.id} diagnoses a bad key as AuthFailed rather than throwing`, async () => {
        const d = await adapter.testConnection();
        expect(d.ok).toBe(false);
        expect(d.service).toBe(adapter.id);
        expect(d.error?.kind).toBe('AuthFailed');
    });

describe('SonarrAdapter', () => {
    const routes = {
        '/api/v3/system/status': fixture('sonarr/system-status.json'),
        '/api/v3/diskspace': fixture('sonarr/diskspace.json'),
        '/api/v3/health': fixture('sonarr/health.json'),
        '/api/v3/system/task': fixture('sonarr/system-task.json')
    };
    const adapter = new SonarrAdapter(keyed(8989), serving(routes));

    it('reads the version from the recorded status response', async () => {
        expect(await adapter.getVersion()).toMatch(/^\d+\.\d+/);
    });

    it('stamps disk rows with sonarr and keeps the real numbers', async () => {
        const disks = await adapter.getDiskSpace();
        expect(disks.length).toBeGreaterThan(0);
        expect(disks.every(d => d.service === 'sonarr')).toBe(true);
        expect(disks.every(d => typeof d.freeSpace === 'number')).toBe(true);
    });

    it('reports RefreshSeries, not the every-minute download poll', async () => {
        const state = await adapter.getScanState();
        const tasks = fixture('sonarr/system-task.json') as { taskName?: string; lastExecution?: string }[];
        const scan = tasks.find(t => t.taskName === 'RefreshSeries');
        const poll = tasks.find(t => t.taskName === 'RefreshMonitoredDownloads');

        expect(state.lastCompleted).toBe(scan?.lastExecution);
        expect(state.lastCompleted).not.toBe(poll?.lastExecution);
    });

    it('advertises disk, health and scan capabilities', () => {
        expect([hasDiskSpace(adapter), hasHealthChecks(adapter), hasScanState(adapter)]).toEqual([true, true, true]);
    });

    expectsAuthDiagnosis(new SonarrAdapter(keyed(8989), unauthorized));
});

describe('ProwlarrAdapter', () => {
    const adapter = new ProwlarrAdapter(
        keyed(9696),
        serving({
            '/api/v1/system/status': fixture('prowlarr/system-status.json'),
            '/api/v1/health': fixture('prowlarr/health.json')
        })
    );

    it('reads the version from the v1 api', async () => {
        expect(await adapter.getVersion()).toMatch(/^\d+\.\d+/);
    });

    it('uses v1, not v3 — Prowlarr never had a v3', async () => {
        const wrongVersion = new ProwlarrAdapter(
            keyed(9696),
            serving({ '/api/v3/system/status': fixture('prowlarr/system-status.json') })
        );
        await expect(wrongVersion.getVersion()).rejects.toThrow(/not found/i);
    });

    it('is health-capable but deliberately not disk-capable', () => {
        // /api/v1/diskspace returned 404 during the capture run.
        expect([hasHealthChecks(adapter), hasDiskSpace(adapter)]).toEqual([true, false]);
    });

    expectsAuthDiagnosis(new ProwlarrAdapter(keyed(9696), unauthorized));
});

describe('JellyfinAdapter', () => {
    const routes = {
        '/System/Info': fixture('jellyfin/system-info.json'),
        '/Users': fixture('jellyfin/users.json'),
        '/ScheduledTasks': fixture('jellyfin/scheduled-tasks.json')
    };
    const adapter = new JellyfinAdapter(multiUser(8096), serving(routes));

    it('sends the MediaBrowser token header rather than X-Api-Key', async () => {
        let seen: Headers | undefined;
        const probe = (async (_i: string, init?: RequestInit) => {
            seen = new Headers(init?.headers);
            return jsonResponse({ Version: '10.11.11' });
        }) as unknown as typeof fetch;

        await new JellyfinAdapter(multiUser(8096), probe).getVersion();
        expect(seen?.get('Authorization')).toBe('MediaBrowser Token="k"');
        expect(seen?.get('X-Api-Key')).toBeNull();
    });

    it('reads the version from System/Info', async () => {
        expect(await adapter.getVersion()).toMatch(/^\d+\.\d+/);
    });

    it('lists every user as an id and name pair', async () => {
        const users = await adapter.listUsers();
        const raw = fixture('jellyfin/users.json') as unknown[];
        expect(users).toHaveLength(raw.length);
        expect(users.every(u => u.id.length > 0 && u.name.length > 0)).toBe(true);
    });

    it('keys the scan task on Key, because Name is localised', async () => {
        const state = await adapter.getScanState();
        const tasks = fixture('jellyfin/scheduled-tasks.json') as {
            Key?: string;
            Name?: string;
            LastExecutionResult?: { EndTimeUtc?: string };
        }[];
        const scan = tasks.find(t => t.Key === 'RefreshLibrary');

        expect(state.lastCompleted).toBe(scan?.LastExecutionResult?.EndTimeUtc);
        // The recorded server is Dutch; matching on Name would find nothing.
        expect(scan?.Name).not.toBe('Scan Media Library');
    });

    it('advertises scan state and a user directory, but not disk space', () => {
        expect([hasScanState(adapter), hasUserDirectory(adapter), hasDiskSpace(adapter)]).toEqual([true, true, false]);
    });

    expectsAuthDiagnosis(new JellyfinAdapter(multiUser(8096), unauthorized));
});

describe('SeerrAdapter', () => {
    const adapter = new SeerrAdapter(
        multiUser(5055),
        serving({
            '/api/v1/status': fixture('seerr/status.json'),
            '/api/v1/user': fixture('seerr/user.json')
        })
    );

    it('reads the version from the status endpoint', async () => {
        expect(await adapter.getVersion()).toMatch(/^\d+\.\d+/);
    });

    it('unwraps the paginated results envelope', async () => {
        const users = await adapter.listUsers();
        const page = fixture('seerr/user.json') as { results: unknown[] };
        expect(users).toHaveLength(page.results.length);
        expect(users.every(u => u.id.length > 0 && u.name.length > 0)).toBe(true);
    });

    it('falls back to the email local part when a user has no display name', async () => {
        const bare = new SeerrAdapter(
            multiUser(5055),
            serving({ '/api/v1/user': { results: [{ id: 3, email: 'nodisplay@example.test' }] } })
        );
        expect(await bare.listUsers()).toEqual([{ id: '3', name: 'nodisplay' }]);
    });

    it('advertises a user directory', () => {
        expect(hasUserDirectory(adapter)).toBe(true);
    });

    // Seerr paginates /user at 10 by default. A household that lost its 11th
    // user got "that user doesn't exist" rather than a truncation.
    it('pages past the first page of users', async () => {
        const users = (from: number, count: number) =>
            Array.from({ length: count }, (_, i) => ({ id: from + i, displayName: `User ${from + i}` }));

        const paged = new SeerrAdapter(
            multiUser(5055),
            serving({
                '/api/v1/user?take=100&skip=0': { pageInfo: { results: 101 }, results: users(1, 100) },
                '/api/v1/user?take=100&skip=100': { pageInfo: { results: 101 }, results: users(101, 1) }
            })
        );

        const found = await paged.listUsers();
        expect(found).toHaveLength(101);
        expect(found.at(-1)?.name).toBe('User 101');
    });

    it('pages past the first page of requests', async () => {
        const requests = (from: number, count: number) =>
            Array.from({ length: count }, (_, i) => ({
                id: from + i,
                status: 1,
                media: { tmdbId: from + i, mediaType: 'movie', title: `Film ${from + i}` },
                requestedBy: { id: 1, displayName: 'Someone' }
            }));

        const paged = new SeerrAdapter(
            multiUser(5055),
            serving({
                '/api/v1/request?take=100&skip=0': { pageInfo: { results: 101 }, results: requests(1, 100) },
                '/api/v1/request?take=100&skip=100': { pageInfo: { results: 101 }, results: requests(101, 1) }
            })
        );

        expect(await paged.getRequests({})).toHaveLength(101);
    });

    // The recorded fixture holds 2 person rows beside 14 movies and 4 tv, so
    // this is the real shape, not an invented one.
    it('drops the person rows in the recorded search fixture', async () => {
        const real = new SeerrAdapter(multiUser(5055), serving({ '/api/v1/search': fixture('seerr/search.json') }));
        const page = fixture('seerr/search.json') as { results: { mediaType?: string }[] };
        const titles = page.results.filter(r => r.mediaType === 'movie' || r.mediaType === 'tv').length;

        const hits = await real.search('anything', 'discover');
        expect(page.results.length).toBeGreaterThan(titles); // the premise: people are in there
        expect(hits).toHaveLength(titles);
    });

    // /api/v1/search is a TMDB multi-search: it returns people alongside
    // titles, and a person id is not a movie id in any namespace.
    it('drops person results rather than calling them films', async () => {
        const multi = new SeerrAdapter(
            multiUser(5055),
            serving({
                '/api/v1/search': {
                    results: [
                        { id: 31, mediaType: 'person', name: 'Tom Hanks' },
                        { id: 13, mediaType: 'movie', title: 'Forrest Gump' },
                        { id: 1396, mediaType: 'tv', name: 'Breaking Bad' }
                    ]
                }
            })
        );

        const hits = await multi.search('tom hanks', 'discover');
        expect(hits.map(h => h.ids.tmdb)).toEqual([13, 1396]);
        expect(hits.map(h => h.kind)).toEqual(['movie', 'series']);
    });

    expectsAuthDiagnosis(new SeerrAdapter(multiUser(5055), unauthorized));
});

describe('BazarrAdapter', () => {
    const adapter = new BazarrAdapter(
        keyed(6767),
        serving({
            '/api/system/status': fixture('bazarr/system-status.json'),
            '/api/system/health': fixture('bazarr/system-health.json')
        })
    );

    it('sends X-API-KEY, spelled differently from every *arr', async () => {
        let seen: Headers | undefined;
        const probe = (async (_i: string, init?: RequestInit) => {
            seen = new Headers(init?.headers);
            return jsonResponse({ data: { bazarr_version: '1.6.0' } });
        }) as unknown as typeof fetch;

        await new BazarrAdapter(keyed(6767), probe).getVersion();
        expect(seen?.get('X-API-KEY')).toBe('k');
    });

    it('unwraps the data envelope to read bazarr_version', async () => {
        expect(await adapter.getVersion()).toMatch(/^\d+\.\d+/);
    });

    it('fails loudly when the envelope itself is missing rather than reading undefined', async () => {
        const empty = new BazarrAdapter(keyed(6767), serving({ '/api/system/status': {} }));
        await expect(empty.getVersion()).rejects.toThrow(/no version/i);
    });

    it('maps health entries into the shared shape', async () => {
        const withIssue = new BazarrAdapter(
            keyed(6767),
            serving({ '/api/system/health': { data: [{ object: 'Sonarr', issue: 'Cannot connect' }] } })
        );
        expect(await withIssue.getFailedHealthChecks()).toEqual([
            { service: 'bazarr', source: 'Sonarr', type: 'warning', message: 'Cannot connect' }
        ]);
    });

    it('reports no failures for the recorded healthy instance', async () => {
        expect(await adapter.getFailedHealthChecks()).toEqual([]);
    });

    // The wanted list is the only place the series id is offered, and the
    // episode subtitle endpoint is keyed on it.
    it('carries the series id an episode subtitle search needs', async () => {
        const wanted = new BazarrAdapter(
            keyed(6767),
            serving({
                '/api/movies/wanted': { data: [] },
                '/api/episodes/wanted': fixture('bazarr/episodes-wanted.json')
            })
        );
        const gaps = await wanted.getMissingSubtitles();
        expect(gaps[0]).toMatchObject({ kind: 'episode', id: 5169, seriesId: 67 });
    });

    describe('triggerSubtitleSearch', () => {
        const probe = () => {
            const seen: { url: string; method?: string }[] = [];
            const impl = (async (input: string, init?: RequestInit) => {
                seen.push({ url: String(input), ...(init?.method === undefined ? {} : { method: init.method }) });
                return new Response(null, { status: 204 });
            }) as unknown as typeof fetch;
            return { adapter: new BazarrAdapter(keyed(6767), impl), seen };
        };

        it('patches the movie endpoint with the radarr id and language', async () => {
            const { adapter: a, seen } = probe();
            await a.triggerSubtitleSearch({ kind: 'movie', id: 1445, language: 'nl', forced: false, hearingImpaired: false });
            expect(seen[0]?.method).toBe('PATCH');
            const url = new URL(seen[0]?.url ?? '');
            expect(url.pathname).toBe('/api/movies/subtitles');
            expect(Object.fromEntries(url.searchParams)).toMatchObject({
                radarrid: '1445',
                language: 'nl',
                forced: 'false',
                hi: 'false'
            });
        });

        // Both ids, or Bazarr answers 404 for an episode it plainly has.
        it('patches the episode endpoint with both ids', async () => {
            const { adapter: a, seen } = probe();
            await a.triggerSubtitleSearch({
                kind: 'episode',
                id: 5169,
                seriesId: 67,
                language: 'nl',
                forced: false,
                hearingImpaired: false
            });
            const url = new URL(seen[0]?.url ?? '');
            expect(url.pathname).toBe('/api/episodes/subtitles');
            expect(Object.fromEntries(url.searchParams)).toMatchObject({
                seriesid: '67',
                episodeid: '5169',
                language: 'nl'
            });
        });

        it('refuses an episode search with no series id rather than calling without one', async () => {
            const { adapter: a, seen } = probe();
            await expect(
                a.triggerSubtitleSearch({ kind: 'episode', id: 5169, language: 'nl', forced: false, hearingImpaired: false })
            ).rejects.toThrow(/series id/i);
            expect(seen).toHaveLength(0);
        });

        it('passes forced and hearing-impaired through as Bazarr spells them', async () => {
            const { adapter: a, seen } = probe();
            await a.triggerSubtitleSearch({ kind: 'movie', id: 1, language: 'en', forced: true, hearingImpaired: true });
            const url = new URL(seen[0]?.url ?? '');
            expect(url.searchParams.get('forced')).toBe('true');
            expect(url.searchParams.get('hi')).toBe('true');
        });
    });

    expectsAuthDiagnosis(new BazarrAdapter(keyed(6767), unauthorized));
});

describe('SabnzbdAdapter', () => {
    const adapter = new SabnzbdAdapter(
        keyed(8080),
        servingModes({
            version: fixture('sabnzbd/version.json'),
            queue: fixture('sabnzbd/queue.json')
        })
    );

    it('puts the api key in the query string, because SABnzbd has no header auth', async () => {
        let seen = '';
        const probe = (async (input: string) => {
            seen = String(input);
            return jsonResponse({ version: '5.0.4' });
        }) as unknown as typeof fetch;

        await new SabnzbdAdapter(keyed(8080), probe).getVersion();
        expect(new URL(seen).searchParams.get('apikey')).toBe('k');
        expect(new URL(seen).searchParams.get('output')).toBe('json');
    });

    it('reads the version from mode=version', async () => {
        expect(await adapter.getVersion()).toMatch(/^\d+\.\d+/);
    });

    it('converts the gigabyte strings in the queue payload into bytes', async () => {
        const disks = await adapter.getDiskSpace();
        const queue = (fixture('sabnzbd/queue.json') as { queue: { diskspace1: string } }).queue;

        expect(disks.length).toBeGreaterThan(0);
        expect(disks[0]?.freeSpace).toBe(Math.round(Number(queue.diskspace1) * 1024 ** 3));
        expect(disks[0]?.service).toBe('sabnzbd');
    });

    it('returns no rows rather than NaN when the fields are not numeric', async () => {
        const weird = new SabnzbdAdapter(
            keyed(8080),
            servingModes({ queue: { queue: { diskspace1: 'unknown', diskspacetotal1: '1.0' } } })
        );
        expect(await weird.getDiskSpace()).toEqual([]);
    });

    it('advertises disk space but not health checks', () => {
        expect([hasDiskSpace(adapter), hasHealthChecks(adapter)]).toEqual([true, false]);
    });

    expectsAuthDiagnosis(new SabnzbdAdapter(keyed(8080), unauthorized));
});

describe('TransmissionAdapter', () => {
    const session = fixture('transmission/session-get.json');
    const adapter = new TransmissionAdapter(transmissionConfig, (async () =>
        jsonResponse(session)) as unknown as typeof fetch);

    it('posts a session-get RPC call rather than issuing a GET', async () => {
        let method: string | undefined;
        let payload: string | undefined;
        const probe = (async (_i: string, init?: RequestInit) => {
            method = init?.method;
            payload = init?.body as string;
            return jsonResponse(session);
        }) as unknown as typeof fetch;

        await new TransmissionAdapter(transmissionConfig, probe).getVersion();
        expect(method).toBe('POST');
        expect(JSON.parse(payload ?? '{}')).toEqual({ method: 'session-get' });
    });

    it('completes the 409 session handshake transparently', async () => {
        let calls = 0;
        const handshaking = (async () => {
            calls += 1;
            if (calls === 1) {
                return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': 'sid-1' } });
            }
            return jsonResponse(session);
        }) as unknown as typeof fetch;

        expect(await new TransmissionAdapter(transmissionConfig, handshaking).getVersion()).toMatch(/^\d+\.\d+/);
        expect(calls).toBe(2);
    });

    it('treats an RPC-level error as upstream even though HTTP was 200', async () => {
        const failing = new TransmissionAdapter(transmissionConfig, (async () =>
            jsonResponse({ result: 'method not allowed' })) as unknown as typeof fetch);
        await expect(failing.getVersion()).rejects.toThrow(/method not allowed/);
    });

    it('reports free space with no total, because Transmission does not report one', async () => {
        const disks = await adapter.getDiskSpace();
        expect(disks).toHaveLength(1);
        expect(disks[0]?.service).toBe('transmission');
        expect(disks[0]?.totalSpace).toBeUndefined();
        expect(disks[0]?.freeSpace).toBeGreaterThan(0);
    });

    it('returns no disk rows when free space is absent', async () => {
        const bare = new TransmissionAdapter(transmissionConfig, (async () =>
            jsonResponse({ result: 'success', arguments: { version: '4.1.3' } })) as unknown as typeof fetch);
        expect(await bare.getDiskSpace()).toEqual([]);
    });

    expectsAuthDiagnosis(new TransmissionAdapter(transmissionConfig, unauthorized));
});

describe('version floors', () => {
    it('reports a below-floor service as VersionUnsupported rather than healthy', async () => {
        const ancient = (async () => jsonResponse({ appName: 'Radarr', version: '3.0.0.1234' })) as unknown as typeof fetch;
        const d = await new RadarrAdapter(keyed(7878), ancient).testConnection();

        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('VersionUnsupported');
        expect(d.error?.remedy).toMatch(/upgrade/i);
    });

    it('still reports a supported version as healthy', async () => {
        const current = (async () => jsonResponse({ appName: 'Radarr', version: '6.3.0.10514' })) as unknown as typeof fetch;
        const d = await new RadarrAdapter(keyed(7878), current).testConnection();

        expect(d.ok).toBe(true);
        expect(d.version).toBe('6.3.0.10514');
    });
});

/**
 * `added` is the only source of an added date in this stack. Driven off the
 * recorded fixture rather than a hand-written shape, so the day Radarr renames
 * the field this fails here instead of silently emptying `sort: 'added'`.
 */
describe('when a service added something', () => {
    it('carries the date Radarr reported, verbatim', async () => {
        const radarr = new RadarrAdapter(
            keyed(7878),
            serving({ '/api/v3/movie': fixture('radarr/movie.json') })
        );

        const items = await radarr.listLibrary();
        expect(items[0]?.acquisition?.addedAt).toBe('2021-09-24T16:04:10Z');
    });

    it('omits it rather than inventing one when the service did not say', async () => {
        const radarr = new RadarrAdapter(
            keyed(7878),
            serving({ '/api/v3/movie': [{ id: 1, title: 'No Date', tmdbId: 1, monitored: true, hasFile: true }] })
        );

        const items = await radarr.listLibrary();
        expect(items[0]?.acquisition?.addedAt).toBeUndefined();
    });
});

describe('QbittorrentAdapter', () => {
    const routes = {
        '/api/v2/app/version': (fixture('qbittorrent/version.json') as { version: string }).version,
        '/api/v2/app/preferences': fixture('qbittorrent/preferences.json'),
        '/api/v2/sync/maindata': fixture('qbittorrent/maindata.json'),
        '/api/v2/torrents/info': fixture('qbittorrent/torrents-info.json')
    };
    const adapter = new QbittorrentAdapter(qbittorrentConfig, serving(routes));

    it('reads the version from a bare string body rather than JSON', async () => {
        expect(await adapter.getVersion()).toMatch(/^v?\d+\.\d+/);
    });

    it('reports free space with no total, naming the disk from the save path', async () => {
        const disks = await adapter.getDiskSpace();
        expect(disks).toHaveLength(1);
        expect(disks[0]?.service).toBe('qbittorrent');
        expect(disks[0]?.path).toBe('/downloads');
        expect(disks[0]?.totalSpace).toBeUndefined();
        expect(disks[0]?.freeSpace).toBeGreaterThan(0);
    });

    it('returns no disk rows when free space is absent', async () => {
        const bare = new QbittorrentAdapter(
            qbittorrentConfig,
            serving({ ...routes, '/api/v2/sync/maindata': { server_state: {} } })
        );
        expect(await bare.getDiskSpace()).toEqual([]);
    });

    it('maps qBittorrent states onto readable ones and fences the release name', async () => {
        const items = await adapter.getQueue();
        expect(items).toHaveLength(2);
        expect(items[0]?.status).toBe('downloading');
        expect(items[1]?.status).toBe('seeding (no peers)');
        expect(items[0]?.protocol).toBe('torrent');
        expect(items[0]?.title).toContain('<<untrusted:qbittorrent.name>>');
    });

    it('keys queue items on the info hash, which is what delete takes', async () => {
        const items = await adapter.getQueue();
        expect(items[0]?.id).toMatch(/^[0-9a-f]{40}$/);
    });

    it('drops the 100-day placeholder rather than promising a finish date', async () => {
        const items = await adapter.getQueue();
        expect(items[0]?.etaSeconds).toBe(614);
        expect(items[1]?.etaSeconds).toBeUndefined();
    });

    it('reports an unrecognised state as unknown rather than guessing', async () => {
        const odd = new QbittorrentAdapter(
            qbittorrentConfig,
            serving({ ...routes, '/api/v2/torrents/info': [{ hash: 'a'.repeat(40), name: 'x', state: 'newState' }] })
        );
        expect((await odd.getQueue())[0]?.status).toBe('unknown');
    });

    expectsAuthDiagnosis(new QbittorrentAdapter(qbittorrentConfig, unauthorized));
});
