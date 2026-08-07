import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig, TransmissionServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
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

const transmissionConfig: TransmissionServiceConfig = {
    url: 'http://192.0.2.10:9091',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const RADARR_QUEUE = {
    records: [
        {
            id: 5,
            title: 'Some.Film.2026.2160p-GROUP',
            status: 'downloading',
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
const transmission = () =>
    new TransmissionAdapter(transmissionConfig, (async () => jsonResponse(TRANSMISSION_TORRENTS)) as unknown as typeof fetch);

const opts = { detail: 'full' as const, limit: 50 };

describe('get_queue', () => {
    it('merges three services into one list', async () => {
        const result = await buildGetQueue([radarr(), sabnzbd(), transmission()], opts);
        expect(result.items.map(i => i.service).sort()).toEqual(['radarr', 'sabnzbd', 'transmission']);
        expect(result.total).toBe(3);
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
