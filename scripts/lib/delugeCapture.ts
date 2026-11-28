/**
 * Deluge's endpoints for `capture-fixtures.ts`, split out so they can be unit
 * tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 *
 * Deluge's Web UI answers every call with HTTP 200 at one JSON-RPC endpoint,
 * and a daemon call made while it has no daemon behind it never answers. So a
 * daemon call is made only once `web.connected` says there is one, and an
 * answer that shows a state is written only in that state. Run
 * `npm run capture -- deluge` with the daemon connected, again with the
 * session paused, with the Web UI disconnected from the daemon, and with the
 * daemon stopped: each run writes what its state shows and skips the rest.
 */
import { DELUGE_RPC_PATH } from '../../src/core/auth.ts';
import type { ServiceHttp } from '../../src/core/http.ts';
import { CONFIG_KEYS, QUEUE_KEYS } from '../../src/services/deluge.ts';
import { fakeTrackerHosts, isRow, ranks, replaceIfString, type Row } from './redact.ts';

type Captured = { path: string; body: unknown } | undefined;

type DelugeEndpoint = {
    name: string;
    path?: string;
    body?: unknown;
    anonymise?: (body: unknown) => unknown;
    fetch?: (http: ServiceHttp) => Promise<Captured>;
};

const call = (http: ServiceHttp, method: string, params: unknown[] = []): Promise<unknown> =>
    http.post<unknown>(DELUGE_RPC_PATH, { method, params, id: 1 });

const resultOf = (body: unknown): unknown => (isRow(body) ? body.result : undefined);

/** `web.connected`, written only when it gives this answer. */
const connectedAs = (name: string, connected: boolean): DelugeEndpoint => ({
    name,
    fetch: async http => {
        const body = await call(http, 'web.connected');
        return resultOf(body) === connected ? { path: DELUGE_RPC_PATH, body } : undefined;
    }
});

/**
 * A daemon call, made only while the Web UI has a daemon behind it and, when
 * `paused` is given, only while the session is paused or running as it says.
 * An error answer is written only where it is the point (`error`): any other
 * is the call failing, and its message, a traceback for an exception, can
 * name the machine's paths.
 */
const daemonCall = (
    name: string,
    method: string,
    params: unknown[] = [],
    opts: { paused?: boolean; anonymise?: (body: unknown) => unknown; error?: true } = {}
): DelugeEndpoint => ({
    name,
    ...(opts.anonymise === undefined ? {} : { anonymise: opts.anonymise }),
    fetch: async http => {
        if (resultOf(await call(http, 'web.connected')) !== true) return undefined;
        if (opts.paused !== undefined && (resultOf(await call(http, 'core.is_session_paused')) === true) !== opts.paused) return undefined;
        const body = await call(http, method, params);
        if (opts.error !== true && isRow(body) && body.error != null) return undefined;
        return { path: DELUGE_RPC_PATH, body };
    }
});

/** A host id is random per install. One stand-in for every id keeps the fixtures agreeing with each other. */
export const HOST_ID = '0123456789abcdef0123456789abcdef';

/**
 * Replaces the host ids in `web.get_hosts` and `web.get_host_status` answers,
 * and each listed daemon's address, which can be a public one, and the
 * account the Web UI logs in to it with, which becomes Deluge's own
 * `localclient`.
 */
export function anonymiseHostIds(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.result)) return body;
    // Any id: one carried over from Deluge 1.3's host list is 40 hex characters (`migrate_hostlist`).
    const swap = (entry: unknown, i: number): unknown => (i === 0 && typeof entry === 'string' ? HOST_ID : entry);
    const STAND_IN: Readonly<Record<number, string>> = { 1: '192.0.2.10', 3: 'localclient' };
    const host = (entry: unknown, i: number): unknown => (typeof entry === 'string' && STAND_IN[i] !== undefined ? STAND_IN[i] : swap(entry, i));
    const result = (body.result as unknown[]).map((item, i) => (Array.isArray(item) ? item.map(host) : swap(item, i)));
    return { ...body, result };
}

/** The first host's status, written only in the state it is named for. */
const hostStatus = (name: string, state: 'Connected' | 'Online' | 'Offline'): DelugeEndpoint => ({
    name,
    anonymise: anonymiseHostIds,
    fetch: async http => {
        const hosts = resultOf(await call(http, 'web.get_hosts'));
        const first: unknown = Array.isArray(hosts) ? (hosts as unknown[])[0] : undefined;
        const id: unknown = Array.isArray(first) ? (first as unknown[])[0] : undefined;
        if (typeof id !== 'string') return undefined;
        const body = await call(http, 'web.get_host_status', [id]);
        const status = resultOf(body);
        return Array.isArray(status) && status[1] === state ? { path: DELUGE_RPC_PATH, body } : undefined;
    }
});

/**
 * The torrents come keyed by info hash, so the keys are replaced with the
 * rows: a name is a release name and a hash identifies the release exactly.
 * One torrent per distinct state, pause flag and finished flag, at most five,
 * as for qBittorrent: the adapter's mapping needs each combination seen once.
 * A label is a category the user named, and a tracker URL can carry a
 * passkey; of a tracker only its URL and tier are kept, since its other
 * fields can carry the client's own addresses and the tracker's messages. A
 * torrent's message is "OK" or its error, which can name a path, so an error
 * becomes Deluge's own "Missing or invalid torrent data!".
 * `download_location` is the folder, without the release's name in it, so it
 * is kept, as mount paths are.
 *
 * The sizes and the ratio are the client's own and would say which releases
 * it holds, so they become synthetic too, keeping what the adapter reads:
 * zero and -1 stay, and the order holds, a torrent's bytes left below its
 * size included. A size is a whole number of GiB by its rank among the sizes
 * and bytes left, and a ratio a quarter by its rank among the ratios.
 */
export function anonymiseDelugeTorrents(body: unknown): unknown {
    if (!isRow(body) || !isRow(body.result)) return body;
    const seen = new Set<string>();
    const kept = Object.values(body.result)
        .filter(isRow)
        .filter(row => {
            const key = `${String(row.state)}|${String(row.paused)}|${String(row.is_finished)}`;
            return !seen.has(key) && seen.add(key);
        })
        .slice(0, 5);
    const positive = (keys: readonly string[]): number[] =>
        kept.flatMap(row => keys.map(key => row[key]).filter((v): v is number => typeof v === 'number' && v > 0));
    const synthetic = (keys: readonly string[], unit: number) => {
        const rank = ranks(positive(keys));
        return (row: Row): Row =>
            Object.fromEntries(Object.entries(row).map(([key, v]) => [key, keys.includes(key) && typeof v === 'number' && v > 0 ? (rank.get(v) ?? 0) * unit : v]));
    };
    const bytes = synthetic(['total_size', 'total_remaining'], 2 ** 30);
    const ratio = synthetic(['ratio'], 0.25);
    const trackerHost = fakeTrackerHosts();
    const result = Object.fromEntries(
        kept.map((row, i): [string, Row] => {
            const n = i + 1;
            return [
                String(n).repeat(40),
                {
                    ...ratio(bytes(row)),
                    name: replaceIfString(row.name, `Release.Name.${n}.1080p.WEB-DL.x264-GROUP`),
                    label: replaceIfString(row.label, 'category'),
                    ...(typeof row.message === 'string' && row.message !== 'OK' ? { message: 'Missing or invalid torrent data!' } : {}),
                    ...(Array.isArray(row.trackers)
                        ? { trackers: (row.trackers as unknown[]).flatMap(t => (isRow(t) ? [{ url: replaceIfString(t.url, `https://${trackerHost(t.url)}/announce`), tier: t.tier }] : [])) }
                        : {})
                }
            ];
        })
    );
    return { ...body, result };
}

/**
 * Free space describes the machine Deluge runs on: a positive answer becomes
 * 2 TiB. -1, Deluge's answer for a folder that does not exist, stays.
 */
export function anonymiseFreeSpace(body: unknown): unknown {
    return isRow(body) && typeof body.result === 'number' && body.result > 0 ? { ...body, result: 2 * 2 ** 40 } : body;
}

export const DELUGE_ENDPOINTS: DelugeEndpoint[] = [
    connectedAs('web-connected', true),
    connectedAs('web-disconnected', false),
    { name: 'hosts', path: DELUGE_RPC_PATH, body: { method: 'web.get_hosts', params: [], id: 1 }, anonymise: anonymiseHostIds },
    hostStatus('host-status', 'Connected'),
    hostStatus('host-status-online', 'Online'),
    hostStatus('host-status-offline', 'Offline'),
    daemonCall('daemon-version', 'daemon.get_version'),
    daemonCall('config-values', 'core.get_config_values', [CONFIG_KEYS]),
    daemonCall('free-space', 'core.get_free_space', [], { anonymise: anonymiseFreeSpace }),
    daemonCall('session-running', 'core.is_session_paused', [], { paused: false }),
    daemonCall('session-paused', 'core.is_session_paused', [], { paused: true }),
    daemonCall('torrents-status', 'core.get_torrents_status', [{}, QUEUE_KEYS], { paused: false, anonymise: anonymiseDelugeTorrents }),
    daemonCall('torrents-status-session-paused', 'core.get_torrents_status', [{}, QUEUE_KEYS], {
        paused: true,
        anonymise: anonymiseDelugeTorrents
    }),
    daemonCall('torrent-status-unknown', 'core.get_torrent_status', ['0'.repeat(40), ['name']]),
    daemonCall('unknown-method', 'core.no_such_method', [], { error: true }),
    // A wrong password is `result: false` with no error, and the session
    // the request carries is left as it was.
    { name: 'login-refused', path: DELUGE_RPC_PATH, body: { method: 'auth.login', params: ['not-the-password'], id: 1 } }
];
