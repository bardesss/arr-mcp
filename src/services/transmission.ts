import type { ServiceId, TransmissionServiceConfig } from '../config/schema.ts';
import { transmissionRpc } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type QueueCapable,
    type QueueItem,
    type ServiceAdapter
} from './types.ts';

const RPC_PATH = '/transmission/rpc';

type RpcResponse<T> = { result?: string; arguments?: T };
type RawSession = {
    version?: string;
    'download-dir'?: string;
    'download-dir-free-space'?: number;
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

export class TransmissionAdapter implements ServiceAdapter, DiskSpaceCapable, QueueCapable {
    readonly id: ServiceId = 'transmission';
    readonly #http: ServiceHttp;

    constructor(config: TransmissionServiceConfig, fetchImpl: typeof fetch = fetch) {
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

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
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
