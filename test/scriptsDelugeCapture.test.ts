import { describe, expect, it } from 'vitest';
import { anonymiseDelugeTorrents, anonymiseFreeSpace, anonymiseHostIds, DELUGE_ENDPOINTS, HOST_ID } from '../scripts/lib/delugeCapture.ts';
import type { ServiceHttp } from '../src/core/http.ts';

const envelope = (result: unknown) => ({ result, error: null, id: 1 });

/** Answers each JSON-RPC method from `answers`, and records what was asked. */
const web = (answers: Record<string, unknown>) => {
    const asked: string[] = [];
    const http = {
        post: async (_path: string, body: { method: string }) => {
            asked.push(body.method);
            return envelope(answers[body.method]);
        }
    } as unknown as ServiceHttp;
    return { http, asked };
};

const endpoint = (name: string) => {
    const e = DELUGE_ENDPOINTS.find(x => x.name === name);
    if (e?.fetch === undefined) throw new Error(`no fetched endpoint ${name}`);
    return e.fetch;
};

describe('anonymiseDelugeTorrents', () => {
    const row = (over: Record<string, unknown>) => ({
        name: 'Real.Release.Name',
        state: 'Seeding',
        paused: false,
        is_finished: true,
        label: 'my-label',
        download_location: '/data/torrents',
        trackers: [{ url: 'udp://tracker.real.example:6969/announce?passkey=secret', tier: 0, message: 'Welcome back, someone', endpoints: [{ local_address: ['198.51.100.7', 6881] }] }],
        ...over
    });

    it('replaces the hashes, names, labels, tracker hosts and error messages, keeping one torrent per state and flags', () => {
        const out = anonymiseDelugeTorrents(
            envelope({
                ['c'.repeat(40)]: row({}),
                ['d'.repeat(40)]: row({ name: 'Another.Seed' }),
                ['e'.repeat(40)]: row({ state: 'Paused', paused: true }),
                // A tracker entry that is not an object is dropped, passkey and all.
                ['f'.repeat(40)]: row({ state: 'Downloading', is_finished: false, trackers: [{ url: 'https://other.real.example/announce' }, 'udp://loose.real.example/announce?passkey=secret'] }),
                ['0'.repeat(40)]: row({ state: 'Error', paused: true, message: 'Failed to move download folder: /srv/someone/films' })
            })
        ) as { result: Record<string, Record<string, unknown>> };

        expect(Object.keys(out.result)).toEqual(['1'.repeat(40), '2'.repeat(40), '3'.repeat(40), '4'.repeat(40)]);
        expect(Object.values(out.result).map(t => t.message)).toEqual([undefined, undefined, undefined, 'Missing or invalid torrent data!']);
        expect(Object.values(out.result).map(t => [t.state, t.name, t.label, t.download_location])).toEqual([
            ['Seeding', 'Release.Name.1.1080p.WEB-DL.x264-GROUP', 'category', '/data/torrents'],
            ['Paused', 'Release.Name.2.1080p.WEB-DL.x264-GROUP', 'category', '/data/torrents'],
            ['Downloading', 'Release.Name.3.1080p.WEB-DL.x264-GROUP', 'category', '/data/torrents'],
            ['Error', 'Release.Name.4.1080p.WEB-DL.x264-GROUP', 'category', '/data/torrents']
        ]);
        expect(Object.values(out.result).map(t => t.trackers)).toEqual([
            [{ url: 'https://tracker-1.example.test/announce', tier: 0 }],
            [{ url: 'https://tracker-1.example.test/announce', tier: 0 }],
            [{ url: 'https://tracker-2.example.test/announce' }],
            [{ url: 'https://tracker-1.example.test/announce', tier: 0 }]
        ]);
        expect(JSON.stringify(out)).not.toMatch(/real\.example|secret|Real\.Release|my-label|c{40}|someone|198\.51\.100\.7|srv/);
    });

    it('replaces the sizes and ratios by rank, keeping zero, -1 and the bytes left below the size', () => {
        const out = anonymiseDelugeTorrents(
            envelope({
                ['c'.repeat(40)]: row({ total_size: 5000, total_remaining: 0, ratio: 0.7 }),
                ['e'.repeat(40)]: row({ state: 'Paused', paused: true, total_size: 900, total_remaining: 0, ratio: -1 }),
                ['f'.repeat(40)]: row({ state: 'Downloading', is_finished: false, total_size: 3000, total_remaining: 40, ratio: 0 })
            })
        ) as { result: Record<string, Record<string, unknown>> };
        const GIB = 2 ** 30;
        expect(Object.values(out.result).map(t => [t.total_size, t.total_remaining, t.ratio])).toEqual([
            [4 * GIB, 0, 0.25],
            [2 * GIB, 0, -1],
            [3 * GIB, GIB, 0]
        ]);
    });

    it('keeps at most five, and leaves an answer that is not a torrent list alone', () => {
        const many = Object.fromEntries(
            ['Allocating', 'Checking', 'Downloading', 'Seeding', 'Moving', 'Error'].map((state, i) => [String(i).repeat(40), row({ state })])
        );
        expect(Object.keys((anonymiseDelugeTorrents(envelope(many)) as { result: object }).result)).toHaveLength(5);
        const failed = { result: null, error: { message: 'Unknown method', code: 2 }, id: 1 };
        expect(anonymiseDelugeTorrents(failed)).toBe(failed);
    });
});

describe('anonymiseFreeSpace', () => {
    it('gives free space one stand-in, and keeps -1 for a folder that does not exist', () => {
        expect(anonymiseFreeSpace(envelope(123_456_789))).toEqual(envelope(2 * 2 ** 40));
        expect(anonymiseFreeSpace(envelope(-1))).toEqual(envelope(-1));
    });
});

describe('anonymiseHostIds', () => {
    it('gives every host id one stand-in, in the host list and in a host status, and every listed address and account', () => {
        const id = 'fedcba9876543210fedcba9876543210';
        expect(anonymiseHostIds(envelope([[id, '203.0.113.7', 58846, 'someone']]))).toEqual(envelope([[HOST_ID, '192.0.2.10', 58846, 'localclient']]));
        expect(anonymiseHostIds(envelope([id, 'Online', '2.2.0']))).toEqual(envelope([HOST_ID, 'Online', '2.2.0']));
        // A host list carried over from Deluge 1.3 keeps its 40-character ids.
        const old = '0123456789abcdef0123456789abcdef01234567';
        expect(anonymiseHostIds(envelope([[old, '203.0.113.7', 58846, 'someone']]))).toEqual(envelope([[HOST_ID, '192.0.2.10', 58846, 'localclient']]));
        expect(anonymiseHostIds(envelope([old, 'Online', '2.2.0']))).toEqual(envelope([HOST_ID, 'Online', '2.2.0']));
    });
});

describe('the Deluge endpoints', () => {
    it('make no daemon call while the Web UI has no daemon behind it', async () => {
        const { http, asked } = web({ 'web.connected': false });
        expect(await endpoint('torrents-status')(http)).toBeUndefined();
        expect(asked).toEqual(['web.connected']);
    });

    it('write a session-pause answer only in that state', async () => {
        const running = web({ 'web.connected': true, 'core.is_session_paused': false, 'core.get_torrents_status': {} });
        expect(await endpoint('torrents-status-session-paused')(running.http)).toBeUndefined();
        expect(await endpoint('torrents-status')(running.http)).toEqual({ path: '/json', body: envelope({}) });
    });

    it('write an error answer only for the call that is meant to fail', async () => {
        const failing = {
            post: async (_path: string, body: { method: string }) =>
                body.method === 'web.connected' ? envelope(true) : { result: null, error: { message: 'Failure: [Failure instance: Traceback: /srv/someone/deluge.py]', code: 3 }, id: 1 }
        } as unknown as ServiceHttp;
        expect(await endpoint('daemon-version')(failing)).toBeUndefined();
        expect(await endpoint('unknown-method')(failing)).toMatchObject({ path: '/json', body: { error: { code: 3 } } });
    });

    it('write web.connected and a host status under the name of the answer they gave', async () => {
        const down = web({ 'web.connected': false, 'web.get_hosts': [['h', '127.0.0.1', 58846, 'localclient']], 'web.get_host_status': ['h', 'Offline', ''] });
        expect(await endpoint('web-connected')(down.http)).toBeUndefined();
        expect(await endpoint('web-disconnected')(down.http)).toEqual({ path: '/json', body: envelope(false) });
        expect(await endpoint('host-status-online')(down.http)).toBeUndefined();
        expect(await endpoint('host-status-offline')(down.http)).toEqual({ path: '/json', body: envelope(['h', 'Offline', '']) });
    });
});
