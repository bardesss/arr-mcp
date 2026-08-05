import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type ServiceAdapter,
    type ServiceUser,
    type UserDirectoryCapable
} from './types.ts';

type RawStatus = { version?: string; commitTag?: string };
type RawUser = { id?: number; displayName?: string; username?: string; email?: string };
type RawUserPage = { results?: RawUser[] };

/**
 * Seerr users may have no display name. The email local part is the fallback
 * its own UI shows, so matching that avoids presenting a name the user has
 * never seen anywhere else.
 */
const nameOf = (u: RawUser): string | undefined => u.displayName ?? u.username ?? u.email?.split('@')[0];

export class SeerrAdapter implements ServiceAdapter, UserDirectoryCapable {
    readonly id: ServiceId = 'seerr';
    readonly #http: ServiceHttp;

    constructor(config: MultiUserServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('seerr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        }
        return status.version;
    }

    async listUsers(): Promise<ServiceUser[]> {
        const page = await this.#http.get<RawUserPage>('/api/v1/user');
        return (page.results ?? [])
            .map(u => ({ id: u.id, name: nameOf(u) }))
            .filter((u): u is { id: number; name: string } => u.id !== undefined && u.name !== undefined)
            .map(u => ({ id: String(u.id), name: u.name }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
