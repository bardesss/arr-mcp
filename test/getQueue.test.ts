import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig, CredentialServiceConfig } from '../src/config/schema.ts';
import { parseTimeleft } from '../src/services/arrQueue.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildGetQueue } from '../src/tools/getQueue.ts';
import { repeat } from './helpers/bigFixture.ts';
import { expectWithinBudget } from './helpers/budget.ts';
import { jsonResponse, serving, servingModes } from './helpers/serve.ts';

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

const qbittorrentConfig: CredentialServiceConfig = {
    url: 'http://192.0.2.10:8081',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const RADARR_QUEUE = {
    records: [
        {
            id: 5,
            title: 'Some.Film.2026.2160p-GROUP',
            status: 'downloading',
            movieId: 1689,
            protocol: 'usenet',
            size: 60_000_000_000,
            sizeleft: 15_000_000_000,
            timeleft: '00:12:30',
            errorMessage: 'Sample check failed'
        }
    ]
};

const SAB_QUEUE = {
    queue: {
        slots: [
            {
                nzo_id: 'SABnzbd_nzo_ab12',
                filename: 'Some.Show.S01E01-GROUP',
                status: 'Downloading',
                mb: '4096.0',
                mbleft: '1024.0',
                timeleft: '0:05:00'
            }
        ]
    }
};

const TRANSMISSION_TORRENTS = {
    result: 'success',
    arguments: {
        torrents: [
            {
                id: 7,
                name: 'Some.Film.2026-GROUP',
                status: 4,
                totalSize: 20_000_000_000,
                leftUntilDone: 5_000_000_000,
                eta: 900,
                errorString: ''
            }
        ]
    }
};

const radarr = (body: unknown = RADARR_QUEUE) => new RadarrAdapter(keyed(7878), serving({ '/api/v3/queue': body }));
const sabnzbd = () => new SabnzbdAdapter(keyed(8080), servingModes({ queue: SAB_QUEUE }));
const QBITTORRENT_TORRENTS = [
    {
        hash: 'b'.repeat(40),
        name: 'Some.Show.S02E04-GROUP',
        state: 'downloading',
        size: 8_000_000_000,
        amount_left: 2_000_000_000,
        eta: 300
    }
];

const transmission = () =>
    new TransmissionAdapter(transmissionConfig, (async () => jsonResponse(TRANSMISSION_TORRENTS)) as unknown as typeof fetch);
const qbittorrent = () =>
    new QbittorrentAdapter(qbittorrentConfig, serving({ '/api/v2/torrents/info': QBITTORRENT_TORRENTS }));

const opts = { detail: 'full' as const, limit: 50 };

/**
 * Radarr and Sonarr page their queue and default `pageSize` to 10 when the
 * caller sends none — which is why the captured fixture echoes `"pageSize": 10`.
 * This fake enforces that default, so a request that omits the parameter sees
 * exactly what a real instance would return.
 */
const pagingQueue = (total: number): typeof fetch =>
    (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/api/v3/queue') return jsonResponse({ message: 'not found' }, 404);
        const pageSize = Number(url.searchParams.get('pageSize') ?? 10);
        const page = Number(url.searchParams.get('page') ?? 1);
        const start = (page - 1) * pageSize;
        const records = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => ({
            id: start + i + 1,
            title: `Film.${start + i + 1}-GROUP`,
            status: 'downloading'
        }));
        return jsonResponse({ page, pageSize, totalRecords: total, records });
    }) as unknown as typeof fetch;

describe('parseTimeleft', () => {
    it('reads a TimeSpan carrying fractional seconds', () => {
        // .NET's "c" format is `[d.]hh:mm:ss[.fffffff]` and emits the fraction
        // whenever it is non-zero, so this is the common shape, not the exotic
        // one. Splitting on the first dot read the whole clock as a day count.
        expect(parseTimeleft('00:04:32.1234567')).toBe(272);
    });

    it('reads a TimeSpan carrying both a day count and a fraction', () => {
        expect(parseTimeleft('1.02:03:04.5000000')).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
    });

    it('still reads the plain and day-prefixed forms', () => {
        expect(parseTimeleft('00:12:30')).toBe(750);
        expect(parseTimeleft('1.02:03:04')).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
    });

    it('returns undefined for something that is not a TimeSpan', () => {
        expect(parseTimeleft('soon')).toBeUndefined();
        expect(parseTimeleft(undefined)).toBeUndefined();
    });
});

describe('unknown queue items', () => {
    const askedFor = async (adapter: { getQueue(): Promise<unknown> }, impl: { seen: string[] }) => {
        await adapter.getQueue();
        return impl.seen;
    };

    const recording = (records: unknown[]) => {
        const seen: string[] = [];
        const impl = (async (input: string) => {
            seen.push(String(input));
            return jsonResponse({ records, totalRecords: records.length });
        }) as unknown as typeof fetch;
        return { impl, seen };
    };

    it('asks Radarr for unknown movie items', async () => {
        const { impl, seen } = recording([]);
        const urls = await askedFor(new RadarrAdapter(keyed(7878), impl), { seen });
        expect(urls[0]).toContain('includeUnknownMovieItems=true');
    });

    it('asks Sonarr for unknown series items, which it spells differently', async () => {
        const { impl, seen } = recording([]);
        const urls = await askedFor(new SonarrAdapter(keyed(8989), impl), { seen });
        expect(urls[0]).toContain('includeUnknownSeriesItems=true');
        expect(urls[0]).not.toContain('includeUnknownMovieItems');
    });

    /** The id the *arr knows the download client's item by — what a manual
     *  import is addressed with, and nothing surfaced it. */
    it('carries the download client id', async () => {
        const { impl } = recording([
            { id: 1, title: 'Heat', status: 'completed', movieId: 15, downloadId: 'SABnzbd_nzo_abc' }
        ]);
        const [item] = await new RadarrAdapter(keyed(7878), impl).getQueue();
        expect(item?.downloadId).toBe('SABnzbd_nzo_abc');
    });

    it('omits the download client id when the *arr did not report one', async () => {
        const { impl } = recording([{ id: 1, title: 'Heat', status: 'completed', movieId: 15 }]);
        const [item] = await new RadarrAdapter(keyed(7878), impl).getQueue();
        expect(item?.downloadId).toBeUndefined();
    });

    it('marks an item with no movie as orphaned, and carries the import state', async () => {
        const { impl } = recording([
            {
                id: 693439963,
                title: 'Good.Boy.2025.1080p-SPHD',
                status: 'completed',
                trackedDownloadState: 'importBlocked',
                trackedDownloadStatus: 'warning'
            }
        ]);
        const [item] = await new RadarrAdapter(keyed(7878), impl).getQueue();
        expect(item).toMatchObject({ id: '693439963', orphaned: true, importState: 'importBlocked' });
    });

    // The generated spec types movieId as `number | null`, so a build that
    // serialises the null rather than omitting the key must not hide the row.
    it('marks an item whose movieId is null, not just absent', async () => {
        const { impl } = recording([
            {
                id: 42,
                title: 'Orphan.2025.1080p-GROUP',
                status: 'completed',
                movieId: null,
                trackedDownloadState: 'importBlocked',
                trackedDownloadStatus: 'warning'
            }
        ]);
        const [item] = await new RadarrAdapter(keyed(7878), impl).getQueue();
        expect(item?.orphaned).toBe(true);
    });

    it('does not mark an item that still has its movie', async () => {
        const { impl } = recording([
            { id: 5, title: 'Some.Film-GROUP', status: 'downloading', movieId: 1689, trackedDownloadState: 'downloading' }
        ]);
        const [item] = await new RadarrAdapter(keyed(7878), impl).getQueue();
        expect(item?.orphaned).toBeUndefined();
    });

    // The live Sonarr had exactly this: unlinked and mid-transfer.
    it('marks an unlinked item orphaned even while it is still downloading', async () => {
        const { impl } = recording([
            { id: 731469873, title: 'Lawless.2012-CHD', status: 'downloading', trackedDownloadState: 'downloading' }
        ]);
        const [item] = await new SonarrAdapter(keyed(8989), impl).getQueue();
        expect(item?.orphaned).toBe(true);
        expect(item?.importState).toBeUndefined();
    });
});

describe('get_queue', () => {
    it('merges three services into one list', async () => {
        const result = await buildGetQueue([radarr(), sabnzbd(), transmission()], opts);
        expect(result.items.map(i => i.service).sort()).toEqual(['radarr', 'sabnzbd', 'transmission']);
        expect(result.total).toBe(3);
    });

    it('reads the whole queue rather than the server default first page', async () => {
        // 25 downloads against a server that hands out 10 unless asked
        // otherwise. Reporting 10 as the queue is not a truncation the caller
        // can see — `truncated` is decided by applyLimit, which only ever sees
        // the rows that arrived.
        const result = await buildGetQueue([new RadarrAdapter(keyed(7878), pagingQueue(25))], { detail: 'full', limit: 100 });
        expect(result.total).toBe(25);
        expect(result.items.map(i => i.id)).toContain('25');
    });

    it('normalises Radarr sizes, which arrive as bytes', async () => {
        const result = await buildGetQueue([radarr()], opts);
        expect(result.items[0]).toMatchObject({
            service: 'radarr',
            id: '5',
            status: 'downloading',
            protocol: 'usenet',
            sizeBytes: 60_000_000_000,
            remainingBytes: 15_000_000_000,
            etaSeconds: 750
        });
    });

    it('normalises SABnzbd sizes, which arrive as megabytes in strings', async () => {
        const result = await buildGetQueue([sabnzbd()], opts);
        expect(result.items[0]).toMatchObject({
            service: 'sabnzbd',
            id: 'SABnzbd_nzo_ab12',
            sizeBytes: Math.round(4096 * 1024 ** 2),
            remainingBytes: Math.round(1024 * 1024 ** 2),
            etaSeconds: 300
        });
    });

    it('translates Transmission numeric status codes into words', async () => {
        const result = await buildGetQueue([transmission()], opts);
        expect(result.items[0]).toMatchObject({ service: 'transmission', id: '7', status: 'downloading', etaSeconds: 900 });
    });

    it('omits an empty Transmission error string rather than reporting a blank error', async () => {
        const result = await buildGetQueue([transmission()], opts);
        expect(result.items[0]?.errorMessage).toBeUndefined();
    });

    it('fences every title, because they are release names', async () => {
        const result = await buildGetQueue([radarr(), sabnzbd(), transmission()], opts);
        expect(result.items.every(i => i.title.startsWith('<<untrusted:'))).toBe(true);
    });

    it('fences error messages too', async () => {
        const result = await buildGetQueue([radarr()], opts);
        expect(result.items[0]?.errorMessage).toBe('<<untrusted:radarr.errorMessage>>Sample check failed<</untrusted>>');
    });

    it('returns the other services worth of queue when one is down', async () => {
        const broken = new SabnzbdAdapter(
            keyed(8080),
            (async () => {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }) as unknown as typeof fetch
        );
        const result = await buildGetQueue([radarr(), broken, transmission()], opts);

        expect(result.items).toHaveLength(2);
        expect(result.degraded).toEqual(['sabnzbd']);
    });

    it('ignores adapters that have no queue at all', async () => {
        const bare: ServiceAdapter = {
            id: 'prowlarr',
            type: 'prowlarr',
            getVersion: async () => '2.0.0',
            testConnection: async () => ({ ok: true, service: 'prowlarr', latency_ms: 1 })
        };
        const result = await buildGetQueue([radarr(), bare], opts);

        expect(result.total).toBe(1);
        expect(result.degraded).toEqual([]);
    });

    it('sorts soonest-finishing first so truncation drops the least urgent', async () => {
        const staggered = {
            records: [
                { ...RADARR_QUEUE.records[0]!, id: 1, timeleft: '02:00:00' },
                { ...RADARR_QUEUE.records[0]!, id: 2, timeleft: '00:01:00' }
            ]
        };
        const result = await buildGetQueue([radarr(staggered)], opts);
        expect(result.items.map(i => i.id)).toEqual(['2', '1']);
    });

    it('sorts an unknown ETA last rather than first', async () => {
        const mixed = {
            records: [
                { ...RADARR_QUEUE.records[0]!, id: 1, timeleft: undefined },
                { ...RADARR_QUEUE.records[0]!, id: 2, timeleft: '01:00:00' }
            ]
        };
        const result = await buildGetQueue([radarr(mixed)], opts);
        expect(result.items.map(i => i.id)).toEqual(['2', '1']);
    });

    it('says what each service contributed even when truncation drops one entirely', async () => {
        // 60 Radarr items all finishing sooner than the single Transmission one,
        // at limit 50: Transmission is pushed out of `items` completely. Without
        // `counts` the model reads this as "nothing in Transmission".
        const many = { records: repeat(RADARR_QUEUE.records[0]!, 60) };
        const result = await buildGetQueue([radarr(many), transmission()], { detail: 'standard', limit: 50 });

        expect(result.items.some(i => i.service === 'transmission')).toBe(false);
        expect(result.counts).toEqual({ radarr: 60, transmission: 1 });
    });

    it('reports truncation honestly across merged services', async () => {
        const many = { records: repeat(RADARR_QUEUE.records[0]!, 300) };
        const result = await buildGetQueue([radarr(many)], { detail: 'standard', limit: 50 });
        expect(result).toMatchObject({ total: 300, returned: 50, truncated: true });
    });

    it('returns title and status only at detail: minimal', async () => {
        const result = await buildGetQueue([radarr()], { detail: 'minimal', limit: 50 });
        expect(Object.keys(result.items[0] ?? {}).sort()).toEqual(['id', 'service', 'status', 'title']);
    });

    it('returns an empty result with no adapters configured', async () => {
        expect(await buildGetQueue([], opts)).toMatchObject({ items: [], total: 0, degraded: [], counts: {} });
    });

    it('stays within its token budget at the absolute maximum', async () => {
        const many = { records: repeat(RADARR_QUEUE.records[0]!, 500) };
        const result = await buildGetQueue([radarr(many)], { detail: 'full', limit: 500 });
        expectWithinBudget(result, 40_000);
    });
});

// Two torrent clients at once is a supported setup, not a misconfiguration.
describe('both torrent clients configured', () => {
    it('merges them and counts each under its own id', async () => {
        const result = await buildGetQueue([transmission(), qbittorrent()], opts);

        expect(result.counts).toEqual({ transmission: 1, qbittorrent: 1 });
        expect(result.items.map(i => i.service).sort()).toEqual(['qbittorrent', 'transmission']);
    });

    it('sorts across both by ETA rather than by adapter order', async () => {
        const result = await buildGetQueue([transmission(), qbittorrent()], opts);
        expect(result.items.map(i => i.etaSeconds)).toEqual([300, 900]);
    });
});
