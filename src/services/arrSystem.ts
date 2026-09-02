import { ServiceError } from '../core/errors.ts';
import type { ServiceHttp } from '../core/http.ts';
import { postArrCommand } from './arrCommands.ts';
import type { CommandHandle, DiskSpace, HealthCheck, ScanState } from './types.ts';

/**
 * Radarr and Sonarr share a framework, so their system endpoints are identical
 * but for the command name. One implementation, two services — the same reason
 * `arrQueue.ts` exists, and the drift it prevents had already started: the two
 * copies of the health mapper disagreed about coercing `type` to a string.
 */

type RawStatus = { version?: string };
type RawDiskSpace = { path?: string | null; label?: string | null; freeSpace?: number | null; totalSpace?: number | null };
type RawHealthCheck = { source?: string; type?: unknown; message?: string };
type RawTask = { taskName?: string; lastExecution?: string };

export async function arrVersion(http: ServiceHttp, id: string): Promise<string> {
    const status = await http.get<RawStatus>('/api/v3/system/status');
    if (!status.version) {
        throw new ServiceError('UpstreamError', id, 'system/status returned no version field');
    }
    return status.version;
}

export async function arrDiskSpace(http: ServiceHttp, id: string): Promise<DiskSpace[]> {
    const rows = await http.get<RawDiskSpace[]>('/api/v3/diskspace');
    // The vendored spec marks these nullable, not merely optional — the spec
    // really does allow nulls. Narrowing on the value rather than on
    // `!== undefined` is what keeps a null out of a `string` field.
    return rows.map(r => ({
        service: id,
        ...(typeof r.path === 'string' ? { path: r.path } : {}),
        label: r.label ?? '',
        freeSpace: r.freeSpace ?? 0,
        ...(typeof r.totalSpace === 'number' ? { totalSpace: r.totalSpace } : {})
    }));
}

export async function arrFailedHealthChecks(http: ServiceHttp, id: string): Promise<HealthCheck[]> {
    const all = await http.get<RawHealthCheck[]>('/api/v3/health');
    // Both services generally return only entries worth surfacing, but some
    // versions include `ok` rows — filter rather than trust.
    return all
        .filter(c => c.type !== 'ok')
        .map(c => ({
            service: id,
            source: c.source ?? 'unknown',
            // Coerced: upstream has been seen sending a non-string here, and
            // `HealthCheck.type` is declared `string`.
            type: String(c.type ?? 'warning'),
            message: c.message ?? ''
        }));
}

/**
 * Queues the same command `arrScanState` reads the last run of, so what this
 * starts and what that reports can never drift apart.
 */
export async function arrStartLibraryScan(http: ServiceHttp, id: string, command: string): Promise<CommandHandle> {
    return postArrCommand(http, id, { name: command });
}

export async function arrScanState(http: ServiceHttp, id: string, taskName: string): Promise<ScanState> {
    const tasks = await http.get<RawTask[]>('/api/v3/system/task');
    const lastCompleted = tasks.find(t => t.taskName === taskName)?.lastExecution;
    return {
        service: id,
        ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
    };
}
