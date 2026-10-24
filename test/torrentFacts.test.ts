import { describe, expect, it } from 'vitest';
import type { CredentialServiceConfig } from '../src/config/schema.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import { hasTorrentEndpoint } from '../src/services/types.ts';
import { jsonResponse, serving } from './helpers/serve.ts';

const config = (url: string): CredentialServiceConfig => ({
    url,
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const transmission = (torrent: Record<string, unknown>) =>
    new TransmissionAdapter(config('http://transmission.example:9091'), (async (_i: unknown, init?: RequestInit) => {
        const method = (JSON.parse(String(init?.body ?? '{}')) as { method?: string }).method;
        if (method === 'session-get') return jsonResponse({ result: 'success', arguments: {} });
        return jsonResponse({ result: 'success', arguments: { torrents: [{ id: 1, name: 'x', ...torrent }] } });
    }) as unknown as typeof fetch);

const qbit = (torrent: Record<string, unknown>) =>
    new QbittorrentAdapter(
        config('http://qbit.example:8081'),
        serving({ '/api/v2/torrents/info': [{ hash: 'ABCDEF', name: 'x', ...torrent }] })
    );

describe('Transmission torrent facts', () => {
    const base = {
        hashString: 'ABCDEF',
        downloadDir: '/data/downloads/complete/',
        labels: ['x'],
        trackers: [{ announce: 'https://tracker.example.org:443/announce' }],
        status: 6,
        leftUntilDone: 0,
        isPrivate: true
    };

    it('reads hash, category, tags, trackers and state', async () => {
        const adapter = transmission(base);
        const [row] = await adapter.getQueue();

        expect(row?.torrent).toEqual({
            hash: 'abcdef',
            category: 'complete',
            tags: ['x'],
            trackerDomains: ['tracker.example.org'],
            private: true,
            stopped: false,
            seeding: true
        });
        expect(adapter.endpoint).toBe('transmission.example:9091');
        expect(hasTorrentEndpoint(adapter)).toBe(true);
    });

    it('reads the category from a Windows download dir too', async () => {
        const dir = ['D:', 'Downloads', 'tv', ''].join(String.fromCharCode(92));
        const [row] = await transmission({ ...base, downloadDir: dir }).getQueue();
        expect(row?.torrent?.category).toBe('tv');
    });

    it('counts a finished stopped torrent as seeding, and a downloading one as not', async () => {
        const [stopped] = await transmission({ ...base, status: 0 }).getQueue();
        expect(stopped?.torrent).toMatchObject({ stopped: true, seeding: true });

        const [downloading] = await transmission({ ...base, status: 4 }).getQueue();
        expect(downloading?.torrent).toMatchObject({ stopped: false, seeding: false });
    });
});

describe('qBittorrent torrent facts', () => {
    const base = {
        category: 'tv',
        tags: 'a, b',
        tracker: 'https://tracker.example.org/announce',
        state: 'stoppedUP',
        amount_left: 0,
        private: false
    };

    it('reads hash, category, tags, tracker and state', async () => {
        const adapter = qbit(base);
        const [row] = await adapter.getQueue();

        expect(row?.torrent).toEqual({
            hash: 'abcdef',
            category: 'tv',
            tags: ['a', 'b'],
            trackerDomains: ['tracker.example.org'],
            private: false,
            stopped: true,
            seeding: true
        });
        expect(adapter.endpoint).toBe('qbit.example:8081');
        expect(hasTorrentEndpoint(adapter)).toBe(true);
    });

    it('gives no tracker domains when the tracker is empty', async () => {
        const [row] = await qbit({ ...base, tracker: '' }).getQueue();
        expect(row?.torrent?.trackerDomains).toEqual([]);
    });
});
