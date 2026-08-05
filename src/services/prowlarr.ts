import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import type { components } from './generated/prowlarr.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type ServiceAdapter
} from './types.ts';

type RawStatus = components['schemas']['SystemResource'];
type RawHealthCheck = components['schemas']['HealthResource'];

/**
 * Prowlarr manages indexers, not files, and exposes no diskspace endpoint —
 * `/api/v1/diskspace` returns 404, confirmed against a live instance during the
 * Phase 2a capture run. It is therefore deliberately not `DiskSpaceCapable`:
 * a method with no fixture is a method stack_health would call and nothing
 * would have tested.
 *
 * It is also API v1, not v3 — Prowlarr never had a v3 like its siblings.
 */
export class ProwlarrAdapter implements ServiceAdapter, HealthCheckCapable {
    readonly id: ServiceId = 'prowlarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('prowlarr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/system/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return status.version;
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const all = await this.#http.get<RawHealthCheck[]>('/api/v1/health');
        return all
            .filter(c => c.type !== 'ok')
            .map(c => ({
                service: this.id,
                source: c.source ?? 'unknown',
                type: String(c.type ?? 'warning'),
                message: c.message ?? ''
            }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
