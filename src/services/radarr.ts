import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type HealthCheck,
    type HealthCheckCapable,
    type ScanState,
    type ScanStateCapable,
    type ServiceAdapter
} from './types.ts';

import type { components } from './generated/radarr.ts';

/**
 * Generated from the vendored spec, so an upstream field rename becomes a
 * typecheck failure here rather than a runtime surprise for a user.
 */
type RawStatus = components['schemas']['SystemResource'];
type RawDiskSpace = components['schemas']['DiskSpaceResource'];
type RawHealthCheck = components['schemas']['HealthResource'];
type RawTask = components['schemas']['TaskResource'];

/**
 * Task names whose last execution stands in for "when did the library last get
 * looked at". Confirmed against a live instance during the capture run — if the
 * real taskName does not match, this pattern changes and nothing else does.
 */
const REFRESH_TASKS = /refresh|rescan/i;

export class RadarrAdapter implements ServiceAdapter, DiskSpaceCapable, HealthCheckCapable, ScanStateCapable {
    readonly id: ServiceId = 'radarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('radarr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v3/system/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return status.version;
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        const rows = await this.#http.get<RawDiskSpace[]>('/api/v3/diskspace');
        // The generated types mark these nullable, not merely optional — the
        // spec really does allow nulls. Narrowing on the value rather than on
        // `!== undefined` is what keeps a null out of a `string` field.
        return rows.map(r => ({
            service: this.id,
            ...(typeof r.path === 'string' ? { path: r.path } : {}),
            label: r.label ?? '',
            freeSpace: r.freeSpace ?? 0,
            ...(typeof r.totalSpace === 'number' ? { totalSpace: r.totalSpace } : {})
        }));
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const all = await this.#http.get<RawHealthCheck[]>('/api/v3/health');
        // Radarr generally returns only entries worth surfacing, but some
        // versions include `ok` rows — filter rather than trust.
        return all
            .filter(c => c.type !== 'ok')
            .map(c => ({
                service: this.id,
                source: c.source ?? 'unknown',
                type: c.type ?? 'warning',
                message: c.message ?? ''
            }));
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.get<RawTask[]>('/api/v3/system/task');
        const latest = tasks
            .filter(t => typeof t.taskName === 'string' && REFRESH_TASKS.test(t.taskName))
            .map(t => t.lastExecution)
            .filter((v): v is string => typeof v === 'string')
            .sort()
            .at(-1);
        return { service: this.id, ...(latest === undefined ? {} : { lastCompleted: latest }) };
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
