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

/** Hand-written until Task 4 replaces them with generated types. */
type RawStatus = { appName?: string; version?: string; instanceName?: string };
type RawDiskSpace = { path?: string; label?: string; freeSpace?: number; totalSpace?: number };
type RawHealthCheck = { source?: string; type?: string; message?: string };
type RawTask = { taskName?: string; lastExecution?: string };

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
        return rows.map(r => ({
            service: this.id,
            ...(r.path === undefined ? {} : { path: r.path }),
            label: r.label ?? '',
            freeSpace: r.freeSpace ?? 0,
            ...(r.totalSpace === undefined ? {} : { totalSpace: r.totalSpace })
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
