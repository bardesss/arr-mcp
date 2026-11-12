import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { postArrCommand } from './arrCommands.ts';
import { LOG_LINES, foldLogLines } from './logLines.ts';
import type { CommandHandle, DiskSpace, HealthCheck, RecentLogs, ScanState } from './types.ts';

/**
 * Radarr, Sonarr, Whisparr and Lidarr share a framework, so their system
 * endpoints are identical but for the command name and the API root. One
 * implementation for all four: the same reason `arrQueue.ts` exists, and the
 * drift it prevents had already started: the two copies of the health mapper
 * disagreed about coercing `type` to a string.
 */

type RawStatus = { version?: string };
type RawDiskSpace = { path?: string | null; label?: string | null; freeSpace?: number | null; totalSpace?: number | null };
type RawHealthCheck = { source?: string; type?: unknown; message?: string };
type RawTask = { taskName?: string; lastExecution?: string };

export async function arrVersion(http: ServiceHttp, id: string): Promise<string> {
    const status = await http.get<RawStatus>(`${http.apiRoot}/system/status`);
    if (!status.version) {
        throw new ServiceError('UpstreamError', id, 'system/status returned no version field');
    }
    return status.version;
}

export async function arrDiskSpace(http: ServiceHttp, id: string): Promise<DiskSpace[]> {
    const rows = await http.getArray<RawDiskSpace>(`${http.apiRoot}/diskspace`);
    // The vendored spec marks these nullable, not merely optional: the spec
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
    const all = await http.getArray<RawHealthCheck>(`${http.apiRoot}/health`);
    // These services generally return only entries worth surfacing, but some
    // versions include `ok` rows: filter rather than trust.
    return all
        .filter(c => c.type !== 'ok')
        .map(c => ({
            service: id,
            source: c.source ?? 'unknown',
            // Coerced: upstream has been seen sending a non-string here, and
            // `HealthCheck.type` is declared `string`.
            type: String(c.type ?? 'warning'),
            // Health text quotes indexer, list and client names, and their errors.
            message: fenceText(c.message ?? '', { service: id, field: 'message' })
        }));
}

type RawLogPage = {
    pageSize?: number | null;
    totalRecords?: number | null;
    records?: { time?: string; level?: string | null; logger?: string | null; message?: string | null; exceptionType?: string | null }[] | null;
};

/**
 * Warnings and errors, newest first, lines differing only in a date-time folded
 * into one with a count. With its log database turned off (`LogDbEnabled`), an
 * *arr's `LogController` answers `new PagingResource<LogResource>()`, with no
 * records and a `pageSize` of 0, while a read with the database on echoes the
 * `pageSize` asked for. That page is reported as `logDbEnabled: false`, not as
 * a log with no warnings.
 */
export async function arrRecentLogs(http: ServiceHttp, id: string): Promise<RecentLogs> {
    const page = await http.get<RawLogPage>(
        `${http.apiRoot}/log?page=1&pageSize=${LOG_LINES}&sortKey=time&sortDirection=descending&level=warn`
    );
    if (page.pageSize === 0) return { entries: [], read: 0, total: 0, logDbEnabled: false };
    const records = page.records ?? [];
    const lines = records.flatMap(r =>
        typeof r.time === 'string'
            ? [{ time: r.time, level: r.level ?? 'warn', logger: r.logger ?? 'unknown', message: r.message ?? '', exceptionType: r.exceptionType }]
            : []
    );
    return { entries: foldLogLines(lines, id), read: records.length, total: page.totalRecords ?? records.length };
}

/**
 * Queues the library scan whose time `arrScanState` reports. Radarr, Sonarr and
 * Whisparr pass the same name to both, so what this starts and what that
 * reports cannot drift apart. Lidarr starts `RefreshArtist`, which queues the
 * `RescanFolders` its scan state reads unless "rescan artist folder after
 * refresh" is Never (`LIBRARY_SCAN_TASK` in `lidarr.ts`).
 */
export async function arrStartLibraryScan(http: ServiceHttp, id: string, command: string): Promise<CommandHandle> {
    return postArrCommand(http, id, { name: command });
}

export async function arrScanState(http: ServiceHttp, id: string, taskName: string): Promise<ScanState> {
    const tasks = await http.getArray<RawTask>(`${http.apiRoot}/system/task`);
    const lastCompleted = tasks.find(t => t.taskName === taskName)?.lastExecution;
    return {
        service: id,
        ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
    };
}
