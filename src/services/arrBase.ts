import { instanceId } from '../config/instances.ts';
import type { BaseServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { TtlCache } from '../core/cache.ts';
import { ServiceHttp } from '../core/http.ts';
import { arrItemId, type ArrIdKind } from './arrCommands.ts';
import { arrDiskSpace, arrFailedHealthChecks, arrScanState, arrVersion } from './arrSystem.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type DiskSpace, type HealthCheck, type ScanState } from './types.ts';

/**
 * What Radarr, Sonarr, Whisparr and Lidarr bind the same way: the instance
 * identity, one `ServiceHttp`, the whole-library cache, and the six system
 * reads that only differ by the scan task they name.
 *
 * Prowlarr stays outside: it has no library and no scan state.
 */
export abstract class ArrAdapterBase {
    readonly type: ServiceId;
    readonly instance: string | undefined;
    readonly id: string;
    protected readonly http: ServiceHttp;

    /** The whole-library read shared by `search(_, 'library')` and `listLibrary`.
     *  Discarded on config reload for free: `buildAdapters` constructs a new adapter. */
    protected readonly libraryCache = new TtlCache();

    /** The system task `getScanState` reads, matched exactly. */
    protected abstract readonly scanTask: string;

    protected constructor(
        type: 'radarr' | 'sonarr' | 'whisparr' | 'lidarr',
        config: { name?: string | undefined; api_key: string } & BaseServiceConfig,
        fetchImpl: typeof fetch,
        opts: { apiRoot?: string } = {}
    ) {
        this.type = type;
        this.instance = config.name;
        // The instance id, not the type: an error from the 4K instance has to
        // say which one it came from, or two instances produce
        // indistinguishable failures.
        this.id = instanceId(type, config.name);
        this.http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl, opts);
    }

    async getVersion(): Promise<string> {
        return arrVersion(this.http, this.id);
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        return arrDiskSpace(this.http, this.id);
    }

    /** Only the checks that are failing; their text is fenced. */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        return arrFailedHealthChecks(this.http, this.id);
    }

    async getScanState(): Promise<ScanState> {
        return arrScanState(this.http, this.id, this.scanTask);
    }

    /** Drop the cached whole-library read, e.g. after a write. */
    invalidateLibrary(): void {
        this.libraryCache.clear();
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    /** A positive integer id, or a refusal that names the service and the kind. */
    protected numericId(kind: ArrIdKind, value: string): number {
        return arrItemId(this.id, kind, value);
    }
}
