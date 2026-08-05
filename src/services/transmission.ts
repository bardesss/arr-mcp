import type { ServiceId, TransmissionServiceConfig } from '../config/schema.ts';
import { transmissionRpc } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
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
export class TransmissionAdapter implements ServiceAdapter, DiskSpaceCapable {
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
