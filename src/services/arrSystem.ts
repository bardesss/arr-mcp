import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { postArrCommand } from './arrCommands.ts';
import type { CommandHandle, DiskSpace, HealthCheck, LogEntry, RecentLogs, ScanState } from './types.ts';

/**
 * Radarr, Sonarr, Whisparr and Lidarr share a framework, so their system
 * endpoints are identical but for the command name and the API root. One
 * implementation for all four — the same reason `arrQueue.ts` exists, and the
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
    const rows = await http.get<RawDiskSpace[]>(`${http.apiRoot}/diskspace`);
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
    const all = await http.get<RawHealthCheck[]>(`${http.apiRoot}/health`);
    // These services generally return only entries worth surfacing, but some
    // versions include `ok` rows — filter rather than trust.
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
    totalRecords?: number | null;
    records?: { time?: string; level?: string | null; logger?: string | null; message?: string | null; exceptionType?: string | null }[] | null;
};

/**
 * Raw lines read before folding. A client failing every two seconds writes a
 * pair of lines each time and fills this in under a minute, which can push out
 * the line that explains the failure. `read` and `total` say how far it got.
 */
const LOG_LINES = 50;

/** Warnings and errors, newest first, identical lines folded into one with a count. */
export async function arrRecentLogs(http: ServiceHttp, id: string): Promise<RecentLogs> {
    const page = await http.get<RawLogPage>(
        `${http.apiRoot}/log?page=1&pageSize=${LOG_LINES}&sortKey=time&sortDirection=descending&level=warn`
    );
    const records = page.records ?? [];
    const folded = new Map<string, LogEntry>();
    for (const r of records) {
        if (typeof r.time !== 'string') continue;
        const level = r.level ?? 'warn';
        const logger = r.logger ?? 'unknown';
        const message = r.message ?? '';
        const key = `${level}\u0000${logger}\u0000${message}`;
        const seen = folded.get(key);
        if (seen !== undefined) {
            // Rows arrive newest first, so a later row only moves firstSeen back.
            seen.count++;
            seen.firstSeen = r.time;
            continue;
        }
        folded.set(key, {
            service: id,
            level,
            logger,
            // Log lines quote hosts, paths, release names and indexer errors.
            message: fenceText(message, { service: id, field: 'message' }),
            ...(r.exceptionType ? { exceptionType: fenceText(r.exceptionType, { service: id, field: 'exceptionType' }) } : {}),
            count: 1,
            firstSeen: r.time,
            lastSeen: r.time
        });
    }
    return { entries: [...folded.values()], read: records.length, total: page.totalRecords ?? records.length };
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
    const tasks = await http.get<RawTask[]>(`${http.apiRoot}/system/task`);
    const lastCompleted = tasks.find(t => t.taskName === taskName)?.lastExecution;
    return {
        service: id,
        ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
    };
}
