import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type ServiceAdapter } from './types.ts';

export const CLEANUPARR_API = '/api';

type RawStatus = { application?: { version?: string } };

/**
 * Hand-written against the source at tag v2.10.9: Cleanuparr publishes no
 * API reference, and minor releases may break this contract.
 */
export class CleanuparrAdapter implements ServiceAdapter {
    readonly type: ServiceId = 'cleanuparr';
    readonly id = 'cleanuparr';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['cleanuparr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    /** Reported as `2.10.9.0`; the fourth part is a build number. */
    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>(`${CLEANUPARR_API}/status`);
        const raw = status.application?.version;
        if (!raw) throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        return raw.split('.').slice(0, 3).join('.');
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
