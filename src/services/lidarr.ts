import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceHttp } from '../core/http.ts';
import { arrVersion } from './arrSystem.ts';
import { diagnoseConnection, type ConnectionDiagnosis } from './types.ts';

/**
 * Lidarr. It claims no capability, so `stack_health` gets a version probe and
 * nothing else. `CONTRIBUTING.md` lists the API traps for the adapter that adds
 * one, and the endpoints still waiting on a library with real activity.
 */
export class LidarrAdapter {
    readonly type: ServiceId = 'lidarr';
    readonly instance: string | undefined = undefined;
    readonly id: string = 'lidarr';

    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['lidarr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl, '/api/v1');
    }

    async getVersion(): Promise<string> {
        return arrVersion(this.#http, this.id);
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
