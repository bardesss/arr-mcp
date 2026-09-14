import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import type { components } from './generated/profilarr.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type ServiceAdapter } from './types.ts';

type RawStatus = components['schemas']['StatusResponse'];
type RawArrInstance = components['schemas']['ArrInstance'];
type RawJob = components['schemas']['JobResponse'];
type RawSyncTrigger = components['schemas']['SyncTriggerResponse'];

export type ProfilarrArrEntry = { id: number; name: string; type: 'radarr' | 'sonarr'; url: string };
export type ProfilarrDrift = {
    lastCheckedAt: string;
    drifted: boolean;
    details: { qualityProfiles: number; delayProfiles: number; mediaManagement: number };
};
export type ProfilarrArrStatus = {
    id: number;
    name: string;
    type: 'radarr' | 'sonarr';
    enabled: boolean;
    drift: ProfilarrDrift | null;
};
export type ProfilarrDatabase = {
    id: number;
    name: string;
    enabled: boolean;
    lastSyncedAt: string | null;
    counts: { customFormats: number; qualityProfiles: number; regularExpressions: number; delayProfiles: number };
};

const API = '/api/v1';

/**
 * Profilarr owns quality profile config for Radarr/Sonarr; arr-mcp never
 * writes profiles itself. `drift` is reserved-but-live in the spec — always
 * null on 2.2.0 — and null means "not checked yet", never "clean". This
 * adapter passes it through unchanged rather than defaulting it.
 */
export class ProfilarrAdapter implements ServiceAdapter {
    readonly type: ServiceId = 'profilarr';
    readonly id = 'profilarr';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['profilarr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>(`${API}/status`);
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        }
        return status.version;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async listArrs(): Promise<ProfilarrArrEntry[]> {
        const arrs = await this.#http.get<RawArrInstance[]>(`${API}/arr`);
        return arrs.map(a => ({ id: a.id, name: a.name, type: a.type, url: a.url }));
    }

    async status(): Promise<{ version: string; databases: ProfilarrDatabase[]; arrs: ProfilarrArrStatus[] }> {
        const raw = await this.#http.get<RawStatus>(`${API}/status`);
        return {
            version: raw.version,
            databases: raw.databases.map(d => ({
                id: d.id,
                name: d.name,
                enabled: d.enabled,
                lastSyncedAt: d.lastSyncedAt,
                counts: d.counts
            })),
            arrs: raw.arrs.map(a => ({
                id: a.id,
                name: a.name,
                type: a.type,
                enabled: a.enabled,
                drift: a.drift
            }))
        };
    }

    async triggerSync(databaseId: number): Promise<number> {
        const result = await this.#http.post<RawSyncTrigger>(`${API}/databases/${databaseId}/sync`, undefined);
        return result.jobId;
    }

    async jobStatus(jobId: number): Promise<'queued' | 'running' | 'success' | 'failed' | 'cancelled'> {
        const job = await this.#http.get<RawJob>(`${API}/jobs/${jobId}`);
        return job.status;
    }
}
