import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { calendarPath, readArrQueue, readRadarrCalendar } from './arrQueue.ts';
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
 * The task that actually rescans the film library, confirmed against a live
 * Radarr 6.3.0 during the Phase 2a capture run.
 *
 * Matched exactly, never by pattern. A live instance runs eleven scheduled
 * tasks, three of which contain "Refresh": `RefreshMovie` is the library scan,
 * but `RefreshMonitoredDownloads` polls the download queue every minute and
 * `RefreshCollections` syncs collections. Taking the most recent match
 * reported the library as scanned a minute ago when it had in fact been
 * scanned 23 hours earlier — scan staleness that can never look stale is worse
 * than not reporting it at all.
 */
const LIBRARY_SCAN_TASK = 'RefreshMovie';

export class RadarrAdapter
    implements ServiceAdapter, DiskSpaceCapable, HealthCheckCapable, ScanStateCapable, QueueCapable, CalendarCapable
{
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
        const scan = tasks.find(t => t.taskName === LIBRARY_SCAN_TASK);
        const lastCompleted = scan?.lastExecution;
        return {
            service: this.id,
            ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
        };
    }

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id);
    }

    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const movies = await this.#http.get<Parameters<typeof readRadarrCalendar>[0]>(calendarPath(range));
        return readRadarrCalendar(movies, this.id);
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
