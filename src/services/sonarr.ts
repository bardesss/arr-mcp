import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { calendarPath, readArrQueue, readSonarrCalendar } from './arrQueue.ts';
import type { components } from './generated/sonarr.ts';
import {
    diagnoseConnection,
    type CalendarCapable,
    type CalendarEntry,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type HealthCheck,
    type HealthCheckCapable,
    type QueueCapable,
    type QueueItem,
    type ScanState,
    type ScanStateCapable,
    type ServiceAdapter
} from './types.ts';

type RawStatus = components['schemas']['SystemResource'];
type RawDiskSpace = components['schemas']['DiskSpaceResource'];
type RawHealthCheck = components['schemas']['HealthResource'];
type RawTask = components['schemas']['TaskResource'];

/**
 * The task that rescans the series library, confirmed against a live Sonarr
 * 4.0.19 during the Phase 2a capture run.
 *
 * Matched exactly, never by pattern — for the same reason as Radarr's
 * `RefreshMovie`. A live instance runs eleven tasks, and
 * `RefreshMonitoredDownloads` polls the download queue every minute. Taking the
 * most recent match reported the library as scanned minutes ago when the real
 * scan was nine hours old.
 */
const LIBRARY_SCAN_TASK = 'RefreshSeries';

export class SonarrAdapter
    implements ServiceAdapter, DiskSpaceCapable, HealthCheckCapable, ScanStateCapable, QueueCapable, CalendarCapable
{
    readonly id: ServiceId = 'sonarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('sonarr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
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
        // The generated types mark these nullable, not merely optional.
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
        return all
            .filter(c => c.type !== 'ok')
            .map(c => ({
                service: this.id,
                source: c.source ?? 'unknown',
                type: String(c.type ?? 'warning'),
                message: c.message ?? ''
            }));
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.get<RawTask[]>('/api/v3/system/task');
        const scan = tasks.find(t => t.taskName === LIBRARY_SCAN_TASK);
        const lastCompleted = scan?.lastExecution;
        return { service: this.id, ...(typeof lastCompleted === 'string' ? { lastCompleted } : {}) };
    }

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id);
    }

    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const episodes = await this.#http.get<Parameters<typeof readSonarrCalendar>[0]>(calendarPath(range));
        return readSonarrCalendar(episodes, this.id);
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
