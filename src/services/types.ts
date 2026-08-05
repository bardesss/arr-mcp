import type { ServiceId } from '../config/schema.ts';
import { ServiceError, type ServiceErrorKind } from '../core/errors.ts';

/**
 * A diagnosis, not a boolean (design spec §6/§14). A connection test that
 * returns true/false tells the user nothing about what to fix.
 */
export type ConnectionDiagnosis = {
    ok: boolean;
    service: ServiceId;
    latency_ms: number;
    version?: string;
    error?: { kind: ServiceErrorKind; detail: string; remedy?: string };
};

export interface ServiceAdapter {
    readonly id: ServiceId;
    testConnection(): Promise<ConnectionDiagnosis>;
    getVersion(): Promise<string>;
}

/**
 * `service` is carried on every row because stack_health merges rows from up
 * to eight services into one list. A failing health check that does not say
 * who reported it is not actionable.
 */
export type DiskSpace = {
    service: ServiceId;
    /** Optional: omitted below `detail: full`, where paths are the longest
     *  strings in the response and rarely what the question was about. */
    path?: string;
    label: string;
    freeSpace: number;
    /** Optional: Transmission reports free space without a total. */
    totalSpace?: number;
};

export type HealthCheck = { service: ServiceId; source: string; type: string; message: string };

/** Library scan staleness, the fourth thing design spec §12 asks stack_health for. */
export type ScanState = { service: ServiceId; lastCompleted?: string; running?: boolean };

export interface DiskSpaceCapable {
    getDiskSpace(): Promise<DiskSpace[]>;
}
export interface HealthCheckCapable {
    getFailedHealthChecks(): Promise<HealthCheck[]>;
}
export interface ScanStateCapable {
    getScanState(): Promise<ScanState>;
}

export const hasDiskSpace = (a: ServiceAdapter): a is ServiceAdapter & DiskSpaceCapable =>
    typeof (a as Partial<DiskSpaceCapable>).getDiskSpace === 'function';

export const hasHealthChecks = (a: ServiceAdapter): a is ServiceAdapter & HealthCheckCapable =>
    typeof (a as Partial<HealthCheckCapable>).getFailedHealthChecks === 'function';

export const hasScanState = (a: ServiceAdapter): a is ServiceAdapter & ScanStateCapable =>
    typeof (a as Partial<ScanStateCapable>).getScanState === 'function';

/**
 * Every adapter's testConnection is the same twenty lines around a different
 * probe. Sharing them means "returns a diagnosis, never throws" is one
 * implementation to test rather than eight to audit.
 */
export async function diagnoseConnection(
    id: ServiceId,
    probe: () => Promise<string | undefined>
): Promise<ConnectionDiagnosis> {
    const started = performance.now();
    try {
        const version = await probe();
        const diagnosis: ConnectionDiagnosis = {
            ok: true,
            service: id,
            latency_ms: Math.round(performance.now() - started)
        };
        if (version !== undefined) diagnosis.version = version;
        return diagnosis;
    } catch (err) {
        const se =
            err instanceof ServiceError
                ? err
                : new ServiceError('UpstreamError', id, (err as Error).message ?? 'unknown', { cause: err });
        const error: ConnectionDiagnosis['error'] = { kind: se.kind, detail: se.detail };
        if (se.remedy !== undefined) error.remedy = se.remedy;
        return { ok: false, service: id, latency_ms: Math.round(performance.now() - started), error };
    }
}
