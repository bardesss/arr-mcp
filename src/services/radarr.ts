import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { ServiceError, classifyFetchError, classifyHttpStatus } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { ArrAdapter, ConnectionDiagnosis, DiskSpace, HealthCheck } from './types.ts';

/** Minimal hand-written shapes; replaced by generated types in Phase 2. */
type SystemStatus = { appName?: string; version?: string; instanceName?: string };

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

export class RadarrAdapter implements ArrAdapter {
    readonly id: ServiceId = 'radarr';

    readonly #config: KeyedServiceConfig;
    readonly #fetch: typeof fetch;
    #consecutiveFailures = 0;
    #openedAt: number | undefined;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#config = config;
        this.#fetch = fetchImpl;
    }

    async getVersion(): Promise<string> {
        const status = await this.#get<SystemStatus>('/api/v3/system/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return status.version;
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        return this.#get<DiskSpace[]>('/api/v3/diskspace');
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const all = await this.#get<HealthCheck[]>('/api/v3/health');
        // Radarr generally returns only entries worth surfacing, but some
        // versions include `ok` rows — filter rather than trust.
        return all.filter(c => c.type !== 'ok');
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        const started = performance.now();
        try {
            const status = await this.#get<SystemStatus>('/api/v3/system/status');
            const diagnosis: ConnectionDiagnosis = {
                ok: true,
                service: this.id,
                latency_ms: Math.round(performance.now() - started)
            };
            if (status.version) diagnosis.version = status.version;
            return diagnosis;
        } catch (err) {
            const se =
                err instanceof ServiceError
                    ? err
                    : new ServiceError('UpstreamError', this.id, (err as Error).message ?? 'unknown', { cause: err });
            const error: ConnectionDiagnosis['error'] = { kind: se.kind, detail: se.detail };
            if (se.remedy !== undefined) error.remedy = se.remedy;
            return {
                ok: false,
                service: this.id,
                latency_ms: Math.round(performance.now() - started),
                error
            };
        }
    }

    // --- internals ---

    #circuitOpen(): boolean {
        if (this.#openedAt === undefined) return false;
        if (Date.now() - this.#openedAt >= CIRCUIT_COOLDOWN_MS) {
            // Half-open: allow a single trial request through. Leaving the
            // failure count one below the threshold means one more failure
            // re-opens the circuit immediately.
            this.#openedAt = undefined;
            this.#consecutiveFailures = CIRCUIT_THRESHOLD - 1;
            return false;
        }
        return true;
    }

    #recordSuccess(): void {
        this.#consecutiveFailures = 0;
        this.#openedAt = undefined;
    }

    #recordFailure(): void {
        this.#consecutiveFailures += 1;
        if (this.#consecutiveFailures >= CIRCUIT_THRESHOLD && this.#openedAt === undefined) {
            this.#openedAt = Date.now();
            logger.warn({ service: this.id }, 'circuit breaker opened after consecutive failures');
        }
    }

    /** Reads retry once on timeout; writes never auto-retry (design spec §15). */
    async #get<T>(path: string): Promise<T> {
        if (this.#circuitOpen()) {
            throw new ServiceError(
                'Unreachable',
                this.id,
                `circuit breaker is open after ${CIRCUIT_THRESHOLD} consecutive failures`,
                { remedy: `Not retried for ${CIRCUIT_COOLDOWN_MS / 1000}s. Fix the service, then try again.` }
            );
        }

        try {
            const result = await this.#attempt<T>(path);
            this.#recordSuccess();
            return result;
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'Timeout') {
                try {
                    const result = await this.#attempt<T>(path);
                    this.#recordSuccess();
                    return result;
                } catch (retryErr) {
                    this.#recordFailure();
                    throw retryErr;
                }
            }
            this.#recordFailure();
            throw err;
        }
    }

    async #attempt<T>(path: string): Promise<T> {
        const url = new URL(path, this.#config.url).toString();
        const signal = AbortSignal.timeout(this.#config.timeout_ms);

        let response: Response;
        try {
            response = await this.#fetch(url, {
                signal,
                headers: { 'X-Api-Key': this.#config.api_key, Accept: 'application/json' }
            });
        } catch (err) {
            throw classifyFetchError(err, this.id, url);
        }

        const httpError = classifyHttpStatus(response.status, this.id, url);
        if (httpError) throw httpError;

        try {
            return (await response.json()) as T;
        } catch (err) {
            throw new ServiceError('UpstreamError', this.id, `response from ${path} was not valid JSON`, {
                cause: err
            });
        }
    }
}
