import type { ServiceId, CredentialServiceConfig } from '../config/schema.ts';
import { transmissionRpc } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type PauseCapable,
    type PauseState,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RemoveQueueOptions,
    type MagnetAdded,
    type MagnetAddCapable,
    type ServiceAdapter,
    type SpeedLimit,
    type SpeedLimitCapable
} from './types.ts';

const RPC_PATH = '/transmission/rpc';

type RpcResponse<T> = { result?: string; arguments?: T };
type RawSession = {
    version?: string;
    'download-dir'?: string;
    'download-dir-free-space'?: number;
    /** KB/s, and only applied when the `-enabled` flag is set. */
    'speed-limit-down'?: number;
    'speed-limit-down-enabled'?: boolean;
};

/**
 * Hand-written: Transmission speaks POST-only JSON-RPC against a single
 * endpoint, with an `X-Transmission-Session-Id` handshake that the auth
 * strategy owns. Confirmed against a live 4.1.3.
 */
type RawTorrent = {
    id?: number;
    name?: string;
    status?: number;
    totalSize?: number;
    leftUntilDone?: number;
    eta?: number;
    errorString?: string;
};

/** Transmission reports status as an integer; these are the RPC spec's values. */
const TORRENT_STATUS: Record<number, string> = {
    0: 'stopped',
    1: 'queued to verify',
    2: 'verifying',
    3: 'queued',
    4: 'downloading',
    5: 'queued to seed',
    6: 'seeding'
};

export class TransmissionAdapter
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        QueueCapable,
        QueueRemoveCapable,
        PauseCapable,
        SpeedLimitCapable,
        MagnetAddCapable
{
    readonly type: ServiceId = 'transmission';
    readonly id: string = 'transmission';
    readonly #http: ServiceHttp;

    constructor(config: CredentialServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(
            'transmission',
            config,
            transmissionRpc({
                ...(config.username === undefined ? {} : { username: config.username }),
                ...(config.password === undefined ? {} : { password: config.password })
            }),
            fetchImpl
        );
    }

    async getVersion(): Promise<string> {
        const session = await this.#session();
        if (!session.version) {
            throw new ServiceError('UpstreamError', this.id, 'session-get returned no version field');
        }
        return session.version;
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        const session = await this.#session();
        const free = session['download-dir-free-space'];
        if (typeof free !== 'number') return [];

        const path = session['download-dir'] ?? 'download-dir';
        return [
            {
                service: this.id,
                path,
                label: 'Transmission download-dir',
                freeSpace: free
                // No totalSpace: Transmission reports free space only.
            }
        ];
    }

    async getQueue(): Promise<QueueItem[]> {
        const body = await this.#http.post<RpcResponse<{ torrents?: RawTorrent[] }>>(RPC_PATH, {
            method: 'torrent-get',
            arguments: { fields: ['id', 'name', 'status', 'totalSize', 'leftUntilDone', 'eta', 'errorString'] }
        });
        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `torrent-get failed: ${body.result ?? 'no result field'}`);
        }

        return (body.arguments?.torrents ?? [])
            .filter((t): t is RawTorrent & { id: number } => typeof t.id === 'number')
            .map(t => ({
                service: this.id,
                id: String(t.id),
                title: fenceText(t.name ?? '', { service: this.id, field: 'name' }),
                status: TORRENT_STATUS[t.status ?? -1] ?? 'unknown',
                protocol: 'torrent',
                ...(t.totalSize === undefined ? {} : { sizeBytes: t.totalSize }),
                ...(t.leftUntilDone === undefined ? {} : { remainingBytes: t.leftUntilDone }),
                // Transmission uses negative eta values to mean "unknown".
                ...(t.eta === undefined || t.eta < 0 ? {} : { etaSeconds: t.eta }),
                ...(t.errorString
                    ? { errorMessage: fenceText(t.errorString, { service: this.id, field: 'errorString' }) }
                    : {})
            }));
    }

    /** Transmission has no blocklist of grabbed releases — that is an *arr concept. */
    readonly supportsBlocklist = false;

    /**
     * `delete-local-data` is the destructive half, and it maps to
     * `removeFromClient`: leaving it false removes the torrent but keeps what
     * has already downloaded, which is the recoverable choice.
     *
     * Like every Transmission call, a failure arrives as HTTP 200 with a
     * `result` other than "success", so the body is what says whether the
     * torrent was actually removed.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        const torrentId = Number(id);
        if (!Number.isInteger(torrentId)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Transmission torrent id`, {
                remedy: 'Transmission torrent ids are integers. Take one from get_queue.'
            });
        }

        // Not redundant: `torrent-remove` ignores an id it has never seen and
        // still answers "success", so without this a stale id reported a
        // successful removal of nothing. qBittorrent's adapter pre-checks for
        // the same reason, and SABnzbd reads its own status flag.
        const found = await this.#http.post<RpcResponse<{ torrents?: { id?: number }[] }>>(RPC_PATH, {
            method: 'torrent-get',
            arguments: { ids: [torrentId], fields: ['id'] }
        });
        if (found.result !== 'success' || (found.arguments?.torrents ?? []).length === 0) {
            throw new ServiceError('NotFound', this.id, `no torrent with id "${id}"`, {
                remedy: 'Transmission torrent ids are integers. Take one from get_queue.'
            });
        }

        const body = await this.#http.post<RpcResponse<unknown>>(RPC_PATH, {
            method: 'torrent-remove',
            arguments: { ids: [torrentId], 'delete-local-data': opts.removeFromClient }
        });

        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `torrent-remove failed: ${body.result ?? 'no result field'}`);
        }
    }

    /**
     * "Stopped" is Transmission's word for paused, and it is per-torrent —
     * there is no client-wide flag. So the whole client counts as paused only
     * when every torrent is stopped, and an empty client counts as *not*
     * paused: nothing to pause is not the same state as everything paused, and
     * reporting it as a no-op would refuse a legitimate call.
     */
    async readPauseState(id?: string): Promise<PauseState> {
        const torrents = await this.#torrents(id);
        const stopped = torrents.filter(t => t.status === 0).length;

        if (id !== undefined) {
            return { paused: stopped === torrents.length && torrents.length > 0, scope: `torrent ${id}` };
        }
        return {
            paused: torrents.length > 0 && stopped === torrents.length,
            scope: torrents.length === 1 ? '1 torrent' : `${torrents.length} torrents`
        };
    }

    async setPaused(paused: boolean, id?: string): Promise<void> {
        // The same pre-check `removeQueueItem` makes, for the same reason:
        // probed live, `torrent-stop` for an id Transmission has never seen
        // answers `result: "success"` and does nothing.
        if (id !== undefined && (await this.#torrents(id)).length === 0) {
            throw new ServiceError('NotFound', this.id, `no torrent with id "${id}"`, {
                remedy: 'Transmission torrent ids are integers. Take one from get_queue.'
            });
        }

        const body = await this.#http.post<RpcResponse<unknown>>(RPC_PATH, {
            method: paused ? 'torrent-stop' : 'torrent-start',
            ...(id === undefined ? {} : { arguments: { ids: [this.#torrentId(id)] } })
        });

        if (body.result !== 'success') {
            throw new ServiceError(
                'UpstreamError',
                this.id,
                `${paused ? 'torrent-stop' : 'torrent-start'} failed: ${body.result ?? 'no result field'}`
            );
        }
    }

    /**
     * Transmission's session speeds are **KB/s**, which is what this boundary
     * speaks — no conversion, only the enabled flag, which is what actually
     * decides whether the number is applied.
     */
    async readSpeedLimit(): Promise<SpeedLimit> {
        const session = await this.#session();
        const limit = session['speed-limit-down'];
        if (session['speed-limit-down-enabled'] !== true || typeof limit !== 'number' || limit <= 0) {
            return { service: this.id };
        }
        return { service: this.id, kbps: limit };
    }

    async setSpeedLimit(kbps: number | undefined): Promise<void> {
        const clearing = kbps === undefined || kbps <= 0;
        const body = await this.#http.post<RpcResponse<unknown>>(RPC_PATH, {
            method: 'session-set',
            arguments: {
                'speed-limit-down-enabled': !clearing,
                // Sent even when clearing: Transmission keeps the number
                // behind the flag, and leaving a stale 50 KB/s there is how a
                // later "pause and resume" comes back throttled.
                'speed-limit-down': clearing ? 0 : Math.round(kbps)
            }
        });

        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `session-set failed: ${body.result ?? 'no result field'}`);
        }
    }

    /**
     * `torrent-add` answers with `torrent-added` for a new torrent and
     * `torrent-duplicate` for one the client already has — a 200 either way,
     * so the arguments are what say which happened. A duplicate is reported,
     * not thrown: it is the state the caller asked for.
     */
    async addMagnet(uri: string): Promise<MagnetAdded> {
        const body = await this.#http.post<
            RpcResponse<{
                'torrent-added'?: { id?: number; name?: string };
                'torrent-duplicate'?: { id?: number; name?: string };
            }>
        >(RPC_PATH, { method: 'torrent-add', arguments: { filename: uri } });

        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `torrent-add failed: ${body.result ?? 'no result field'}`, {
                remedy: 'Transmission refused the magnet. Check the link is complete and the client can reach a tracker.'
            });
        }

        const added = body.arguments?.['torrent-added'];
        const duplicate = body.arguments?.['torrent-duplicate'];
        const row = added ?? duplicate;

        return {
            ...(row?.id === undefined ? {} : { id: String(row.id) }),
            ...(row?.name === undefined
                ? {}
                : { title: fenceText(row.name, { service: this.id, field: 'name' }) }),
            duplicate: added === undefined && duplicate !== undefined
        };
    }

    #torrentId(id: string): number {
        const torrentId = Number(id);
        if (!Number.isInteger(torrentId)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Transmission torrent id`, {
                remedy: 'Transmission torrent ids are integers. Take one from get_queue.'
            });
        }
        return torrentId;
    }

    /** Id and status only — enough to answer "is it stopped", without the
     *  whole queue payload `getQueue` needs. */
    async #torrents(id?: string): Promise<{ id?: number; status?: number }[]> {
        const body = await this.#http.post<RpcResponse<{ torrents?: { id?: number; status?: number }[] }>>(RPC_PATH, {
            method: 'torrent-get',
            arguments: {
                ...(id === undefined ? {} : { ids: [this.#torrentId(id)] }),
                fields: ['id', 'status']
            }
        });
        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `torrent-get failed: ${body.result ?? 'no result field'}`);
        }
        return body.arguments?.torrents ?? [];
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    /**
     * Transmission answers RPC failures with HTTP 200 and a `result` other than
     * "success", so checking the status line alone would report a broken call
     * as healthy.
     */
    async #session(): Promise<RawSession> {
        const body = await this.#http.post<RpcResponse<RawSession>>(RPC_PATH, { method: 'session-get' });
        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `session-get failed: ${body.result ?? 'no result field'}`);
        }
        return body.arguments ?? {};
    }
}
