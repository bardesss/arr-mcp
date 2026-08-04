import type { ServiceId } from '../config/schema.ts';
import type { ServiceErrorKind } from '../core/errors.ts';

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

export type DiskSpace = { path: string; label: string; freeSpace: number; totalSpace: number };
export type HealthCheck = { source: string; type: string; message: string };

/** Shared by Radarr and Sonarr; Sonarr's adapter lands in Phase 2. */
export interface ArrAdapter extends ServiceAdapter {
    getDiskSpace(): Promise<DiskSpace[]>;
    getFailedHealthChecks(): Promise<HealthCheck[]>;
}
