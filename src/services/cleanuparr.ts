import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type ServiceAdapter
} from './types.ts';
import { compareVersions, parseVersion } from './versions.ts';

export const CLEANUPARR_API = '/api';

export const TESTED_MINOR = '2.10';

type RawStatus = { application?: { version?: string } };
type RawHealthEntry = { status?: string; description?: string };
type RawHealth = { entries?: Record<string, RawHealthEntry> };
type RawArrStatus = Record<string, Array<{ name?: string; isConnected?: boolean; message?: string }>>;
export type RawClientStatus = { id: string; name: string; type: string; host: string; enabled: boolean; isConnected: boolean };
type RawJob = { jobType?: string; status?: string };
export type RawGeneral = { dryRun?: boolean; ignoredDownloads?: string[] };

const JOB_LABEL: Record<string, string> = { QueueCleaner: 'Queue Cleaner', DownloadCleaner: 'Download Cleaner' };

/**
 * Hand-written against the source at tag v2.10.9: Cleanuparr publishes no
 * API reference, and minor releases may break this contract.
 */
export class CleanuparrAdapter implements ServiceAdapter, HealthCheckCapable {
    readonly type: ServiceId = 'cleanuparr';
    readonly id = 'cleanuparr';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['cleanuparr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    /** Reported as `2.10.9.0`; the fourth part is a build number. */
    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>(`${CLEANUPARR_API}/status`);
        const raw = status.application?.version;
        if (!raw) throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        return raw.split('.').slice(0, 3).join('.');
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const [version, health, arrs, clients, jobs, general] = await Promise.all([
            this.getVersion(),
            this.#http.get<RawHealth>('/health/detailed'),
            this.#http.get<RawArrStatus>(`${CLEANUPARR_API}/status/arrs`),
            this.#clients(),
            this.#jobs(),
            this.#general()
        ]);
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const fence = (value: string) => fenceText(value, { service: this.id, field: 'message' });
        const out: HealthCheck[] = [];

        for (const [name, entry] of Object.entries(health.entries ?? {})) {
            if (entry.status !== 'healthy') out.push(check('health', 'error', fence(`${name}: ${entry.description ?? entry.status ?? 'unknown'}`)));
        }
        for (const [kind, list] of Object.entries(arrs)) {
            for (const a of list) {
                if (a.isConnected === false) {
                    out.push(check('arrs', 'error', fence(`${kind} "${a.name ?? kind}" is not connected: ${a.message ?? 'no reason given'}`)));
                }
            }
        }
        for (const c of clients) {
            if (c.enabled && !c.isConnected) out.push(check('clients', 'error', fence(`Download client "${c.name}" is not connected`)));
        }
        for (const job of jobs) {
            const label = JOB_LABEL[job.jobType ?? ''];
            if (label !== undefined && job.status !== 'Scheduled') out.push(check('jobs', 'warning', `${label} is not scheduled, so its rules are not enforced`));
        }
        if (general.dryRun === true) out.push(check('general', 'warning', 'Dry run is on: Cleanuparr logs what it would do and does nothing'));

        const actual = parseVersion(version);
        const tested = parseVersion(TESTED_MINOR);
        if (actual !== undefined && tested !== undefined && compareVersions(actual.slice(0, 2), tested) > 0) {
            out.push(check('version', 'warning', `Cleanuparr ${version} is newer than ${TESTED_MINOR}.x, which this adapter was written against; untested, results may be wrong`));
        }
        return out;
    }

    /** The client list without credentials. `/api/configuration/download_client` has passwords. */
    async #clients(): Promise<RawClientStatus[]> {
        const body = await this.#http.get<{ Clients?: RawClientStatus[] }>(`${CLEANUPARR_API}/status/download-client`);
        return body.Clients ?? [];
    }

    async #jobs(): Promise<RawJob[]> {
        return this.#http.get<RawJob[]>(`${CLEANUPARR_API}/jobs`);
    }

    async #general(): Promise<RawGeneral> {
        return this.#http.get<RawGeneral>(`${CLEANUPARR_API}/configuration/general`);
    }
}
