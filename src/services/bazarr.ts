import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type ServiceAdapter
} from './types.ts';

/**
 * Hand-written: Bazarr publishes no OpenAPI document (design spec §21.1), so
 * these shapes come from recorded fixtures and the contract test checks them
 * against those fixtures rather than against a spec.
 *
 * Confirmed against a live Bazarr 1.6.0: every payload is wrapped in
 * `{ data: … }`, and the version field is `bazarr_version`.
 */
type Envelope<T> = { data?: T };
type RawStatus = { bazarr_version?: string };
type RawHealth = { object?: string; issue?: string };

export class BazarrAdapter implements ServiceAdapter, HealthCheckCapable {
    readonly id: ServiceId = 'bazarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        // Bazarr spells the header X-API-KEY, not X-Api-Key. Header names are
        // case-insensitive per RFC 9110, so this is cosmetic — but it matches
        // Bazarr's own documentation, which is what a reader will compare to.
        this.#http = new ServiceHttp('bazarr', config, apiKeyHeader('X-API-KEY', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const body = await this.#http.get<Envelope<RawStatus>>('/api/system/status');
        const version = body.data?.bazarr_version;
        if (!version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return version;
    }

    /**
     * Bazarr reports problems rather than a pass/fail per check, so every row
     * returned is a failure. There is no `ok` type to filter out, and the
     * shared HealthCheck shape wants one — `warning` is the honest mapping.
     */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const body = await this.#http.get<Envelope<RawHealth[]>>('/api/system/health');
        return (body.data ?? []).map(row => ({
            service: this.id,
            source: row.object ?? 'bazarr',
            type: 'warning',
            message: row.issue ?? ''
        }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
