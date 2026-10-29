import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { basicAuth } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryEventType,
    type HistoryQuery,
    type PauseCapable,
    type PauseState,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RemoveQueueOptions,
    type ServiceAdapter,
    type SpeedLimit,
    type SpeedLimitCapable
} from './types.ts';

type RpcError = { code?: unknown; message?: unknown; data?: unknown };
type RpcResponse<T> = { result?: T; error?: RpcError };
type RawStatus = {
    FreeDiskSpaceMB?: number;
    FreeDiskSpaceLo?: number;
    FreeDiskSpaceHi?: number;
    TotalDiskSpaceMB?: number;
    TotalDiskSpaceLo?: number;
    TotalDiskSpaceHi?: number;
    DownloadRate?: number;
    DownloadRateLo?: number;
    DownloadRateHi?: number;
    DownloadLimit?: number;
    ServerPaused?: boolean;
    DownloadPaused?: boolean;
    Download2Paused?: boolean;
};
type RawParameter = { Name?: unknown; Value?: unknown };
type RawGroup = {
    NZBID?: number;
    NZBFilename?: string;
    NZBName?: string;
    NZBNicename?: string;
    Status?: string;
    FileSizeMB?: number;
    FileSizeLo?: number;
    FileSizeHi?: number;
    RemainingSizeMB?: number;
    RemainingSizeLo?: number;
    RemainingSizeHi?: number;
    PausedSizeMB?: number;
    PausedSizeLo?: number;
    PausedSizeHi?: number;
    PostInfoText?: string;
    Parameters?: RawParameter[];
};
type RawHistory = {
    NZBID?: number;
    ID?: number;
    NZBFilename?: string;
    Name?: string;
    NZBNicename?: string;
    HistoryTime?: number;
    Status?: string;
    ParStatus?: string;
    UnpackStatus?: string;
    MoveStatus?: string;
    ScriptStatus?: string;
    DeleteStatus?: string;
    MarkStatus?: string;
    UrlStatus?: string;
    Parameters?: RawParameter[];
};
type RawHealthStatus = { Name?: unknown; Severity?: unknown; Message?: unknown };
type RawHealthSection = {
    Name?: unknown;
    Issues?: RawHealthStatus[];
    Options?: RawHealthStatus[];
    Subsections?: Array<{ Name?: unknown; Options?: RawHealthStatus[] }>;
};
type RawHealthReport = {
    Alerts?: Array<{ Source?: unknown; Category?: unknown; Severity?: unknown; Message?: unknown }>;
    Sections?: RawHealthSection[];
};

const BYTES_PER_MB = 1024 ** 2;
const TWO_POW_32 = 2 ** 32;

const isArray = <T>(value: unknown): value is T[] => Array.isArray(value);
const isObject = <T>(value: unknown): value is T => value !== null && typeof value === 'object';
/** The object elements of a list, or none: a `null` or primitive element is
 *  skipped rather than read as a row. */
const objectsIn = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter((v): v is T => isObject<T>(v)) : []);

/**
 * NZBGet reports 64-bit sizes as a Hi/Lo pair of unsigned 32-bit halves, plus
 * a rounded MB figure. The pair is exact; the MB figure is the fallback for a
 * response that lacks it. A Hi half with its top bit set is a negative value,
 * never a size: v21 sends -1 for free disk space it could not measure.
 */
const int64 = (hi: number | undefined, lo: number | undefined, mb?: number): number | undefined => {
    if (typeof hi === 'number' && typeof lo === 'number' && Number.isFinite(hi) && Number.isFinite(lo) && hi >= 0 && lo >= 0) {
        return hi >= 2 ** 31 ? undefined : hi * TWO_POW_32 + lo;
    }
    if (typeof mb !== 'number' || !Number.isFinite(mb) || mb < 0) return undefined;
    return Math.round(mb * BYTES_PER_MB);
};

/** The `drone` post-processing parameter is the id an *arr stamps on the NZB
 *  it sends; it is what the *arr's own queue calls the downloadId. */
const droneParameter = (parameters: unknown): string | undefined => {
    const drone = objectsIn<RawParameter>(parameters).find(p => p.Name === 'drone');
    return typeof drone?.Value === 'string' && drone.Value.length > 0 ? drone.Value : undefined;
};

/**
 * `Status` is `<KIND>/<DETAIL>`: SUCCESS/*, FAILURE/*, DELETED/* and
 * WARNING/* (see NzbInfo::MakeTextStatus). A WARNING is neither an import nor
 * a failure — a damaged or password-protected download waiting on a human —
 * so it stays `unknown` with its raw status kept.
 */
const historyEvent = (status: string): HistoryEventType => {
    const kind = status.split('/')[0]?.toUpperCase();
    if (kind === 'SUCCESS') return 'imported';
    if (kind === 'FAILURE') return 'failed';
    if (kind === 'DELETED') return 'deleted';
    return 'unknown';
};

/**
 * NZBGet's group `Status` (listgroups, QueueCoordinator/NzbInfo) mapped onto
 * the lowercase words the other download clients emit, which is what
 * `get_queue` merges and `diagnose` classifies. Post-processing stages are
 * healthy progress, and `PP_FINISHED` is a finished download waiting to be
 * imported. Anything not listed is passed through lowercased.
 */
const QUEUE_STATUS: Readonly<Record<string, string>> = {
    QUEUED: 'queued',
    PAUSED: 'paused',
    DOWNLOADING: 'downloading',
    FETCHING: 'fetching',
    PP_QUEUED: 'verifying',
    LOADING_PARS: 'verifying',
    VERIFYING_SOURCES: 'verifying',
    VERIFYING_REPAIRED: 'verifying',
    REPAIRING: 'repairing',
    UNPACKING: 'extracting',
    RENAMING: 'moving',
    MOVING: 'moving',
    EXECUTING_SCRIPT: 'moving',
    PP_FINISHED: 'completed'
};

const queueStatus = (raw: string | undefined): string => {
    if (raw === undefined || raw.length === 0) return 'unknown';
    return QUEUE_STATUS[raw.toUpperCase()] ?? raw.toLowerCase();
};

const STAGE_FIELDS = ['ParStatus', 'UnpackStatus', 'MoveStatus', 'ScriptStatus', 'DeleteStatus', 'MarkStatus', 'UrlStatus'] as const;
const UNREMARKABLE = new Set(['NONE', 'SUCCESS', 'SKIPPED', 'GOOD']);

/**
 * NZBGet has no failure message, only per-stage status codes. The reason is
 * built from the stages that did not succeed, so "FAILURE/PAR" reads as
 * `FAILURE/PAR (ParStatus FAILURE, UnpackStatus NONE...)` minus the noise.
 */
const historyReason = (row: RawHistory, status: string): string => {
    const stages = STAGE_FIELDS.flatMap(field => {
        const value = row[field];
        return typeof value === 'string' && !UNREMARKABLE.has(value.toUpperCase()) ? [`${field} ${value}`] : [];
    });
    return stages.length === 0 ? status : `${status} (${stages.join(', ')})`;
};

/** XmlRpc.cpp answers code 1 ("Invalid procedure") for an unknown method,
 *  which is what a server older than v26 says to `systemhealth`, and for
 *  `systemhealth` with `SystemHealthCheck=no`. Either way there is no report. */
const RPC_NO_REPORT = 1;
/** XmlRpc.cpp answers code 401 "Access denied" (inside an HTTP 200) when an
 *  add-user calls anything but append, appendurl or version. */
const RPC_ACCESS_DENIED = 401;
/** WebServer.cpp answers HTTP 401 when the login matches none of Control,
 *  Restricted or Add. */
const LOGIN_REMEDY =
    'The username or password is wrong. Use the ControlUsername/ControlPassword or RestrictedUsername/RestrictedPassword login from NZBGet Settings → Security.';

/** Exactly what `get_queue` emits. `Number()` would also accept `0x10`,
 *  `1e2` and ` 7 `, and send a destructive edit to a different NZBID. */
const asIntegerId = (value: string, service: string): number => {
    const id = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(id)) {
        throw new ServiceError('NotFound', service, `"${value}" is not an NZBGet queue id`, {
            remedy: 'Queue ids are integers on NZBGet. Take one from get_queue.'
        });
    }
    return id;
};

export class NzbgetAdapter
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        HealthCheckCapable,
        QueueCapable,
        QueueRemoveCapable,
        PauseCapable,
        SpeedLimitCapable,
        HistoryCapable
{
    readonly type: ServiceId = 'nzbget';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;
    #nextRpcId = 1;

    constructor(config: ConfigByService['nzbget'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('nzbget', config.name);
        // WebServer.cpp answers a 401 before reading the POST body but keeps
        // the connection open, so the next request on it fails. Without
        // keep-alive NZBGet closes after each reply.
        this.#http = new ServiceHttp(this.id, config, basicAuth(config), fetchImpl, { closeConnection: true });
        this.#passwordOnly = config.password !== undefined && config.password !== '' && (config.username ?? '') === '';
    }

    /** Basic auth needs a username; without one nothing is sent at all. */
    readonly #passwordOnly: boolean;

    async #call<T>(method: string, params: unknown[]): Promise<RpcResponse<T>> {
        if (this.#passwordOnly) {
            throw new ServiceError('AuthFailed', this.id, 'a password is configured without a username', {
                remedy: `NZBGet logs in with a username and password. Add the username to this ${this.id} entry: the ControlUsername (default "nzbget") or RestrictedUsername from NZBGet Settings → Security.`
            });
        }
        let body: RpcResponse<T>;
        try {
            body = await this.#http.post<RpcResponse<T>>('/jsonrpc', {
                jsonrpc: '2.0',
                method,
                params,
                id: this.#nextRpcId++
            });
        } catch (err) {
            // The shared 401 remedy is about an API key; NZBGet has a login.
            if (err instanceof ServiceError && err.kind === 'AuthFailed') {
                throw new ServiceError('AuthFailed', this.id, err.detail, { remedy: LOGIN_REMEDY, cause: err });
            }
            throw err;
        }
        if (body === null || typeof body !== 'object') {
            throw new ServiceError('UpstreamError', this.id, `JSON-RPC ${method} returned a non-object response`);
        }
        return body;
    }

    #rpcError(method: string, error: RpcError | undefined): ServiceError {
        const message = typeof error?.message === 'string' && error.message ? error.message : 'unknown JSON-RPC error';
        const detail = fenceText(message, { service: this.id, field: 'rpc_error' });
        if (error?.code === RPC_ACCESS_DENIED) {
            return new ServiceError('AuthFailed', this.id, `JSON-RPC ${method} was refused: ${detail}`, {
                remedy:
                    'These look like the add-user login (AddUsername/AddPassword), which may only add NZBs. Use the ControlUsername/ControlPassword or RestrictedUsername/RestrictedPassword login from NZBGet Settings → Security.'
            });
        }
        return new ServiceError('UpstreamError', this.id, detail);
    }

    async #rpc<T>(
        method: string,
        params: unknown[],
        isValid: (value: unknown) => value is T
    ): Promise<T> {
        const body = await this.#call<T>(method, params);
        // `"error": null` is success in JSON-RPC 1.x style and from some proxies.
        if (body.error != null) throw this.#rpcError(method, body.error);
        if (!Object.prototype.hasOwnProperty.call(body, 'result') || !isValid(body.result)) {
            throw new ServiceError('UpstreamError', this.id, `JSON-RPC ${method} returned an invalid result`);
        }
        return body.result;
    }

    /** Queue groups, skipping any element that is not an object, so one bad
     *  row cannot turn into a TypeError. */
    async #groups(): Promise<RawGroup[]> {
        return objectsIn<RawGroup>(await this.#rpc<unknown[]>('listgroups', [0], isArray));
    }

    #status(): Promise<RawStatus> {
        return this.#rpc<RawStatus>('status', [], isObject);
    }

    async getVersion(): Promise<string> {
        return this.#rpc('version', [], (value): value is string => typeof value === 'string' && value.length > 0);
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        const body = await this.#status();
        const freeSpace = int64(body.FreeDiskSpaceHi, body.FreeDiskSpaceLo, body.FreeDiskSpaceMB);
        const totalSpace = int64(body.TotalDiskSpaceHi, body.TotalDiskSpaceLo, body.TotalDiskSpaceMB);
        // DestDir could not be measured (e.g. not created yet): v21 sends -1,
        // v26 sends 0 free of 0 total.
        if (freeSpace === undefined || (freeSpace === 0 && totalSpace === 0)) return [];
        return [
            {
                service: this.id,
                label: 'NZBGet free disk space',
                freeSpace,
                ...(totalSpace === undefined || totalSpace === 0 ? {} : { totalSpace })
            }
        ];
    }

    /**
     * NZBGet's `systemhealth` (v26+) reports alerts and per-section option
     * problems. Ok and Info are not failures. A server too old to have the
     * method, or with the check switched off, has nothing to report rather
     * than a broken health endpoint.
     */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const body = await this.#call<RawHealthReport>('systemhealth', []);
        if (body.error != null) {
            if (body.error?.code === RPC_NO_REPORT) return [];
            throw this.#rpcError('systemhealth', body.error);
        }
        const report = body.result;
        if (!isObject<RawHealthReport>(report)) {
            throw new ServiceError('UpstreamError', this.id, 'JSON-RPC systemhealth returned an invalid result');
        }

        const checks: HealthCheck[] = [];
        const push = (source: unknown, severity: unknown, message: unknown): void => {
            const type = typeof severity === 'string' ? severity.toLowerCase() : '';
            if (type !== 'warning' && type !== 'error') return;
            checks.push({
                service: this.id,
                source: fenceText(typeof source === 'string' && source.length > 0 ? source : 'unknown', {
                    service: this.id,
                    field: 'source'
                }),
                type,
                message: fenceText(typeof message === 'string' ? message : '', { service: this.id, field: 'Message' })
            });
        };
        const name = (value: unknown): string => (typeof value === 'string' ? value : '');

        for (const alert of objectsIn<NonNullable<RawHealthReport['Alerts']>[number]>(report.Alerts)) {
            push([name(alert.Category), name(alert.Source)].filter(Boolean).join('/'), alert.Severity, alert.Message);
        }
        for (const section of objectsIn<RawHealthSection>(report.Sections)) {
            const sectionName = name(section.Name);
            for (const issue of objectsIn<RawHealthStatus>(section.Issues)) {
                push(sectionName, issue.Severity, issue.Message);
            }
            for (const option of objectsIn<RawHealthStatus>(section.Options)) {
                push(`${sectionName}.${name(option.Name)}`, option.Severity, option.Message);
            }
            for (const sub of objectsIn<NonNullable<RawHealthSection['Subsections']>[number]>(section.Subsections)) {
                for (const option of objectsIn<RawHealthStatus>(sub.Options)) {
                    push(`${sectionName}.${name(sub.Name)}.${name(option.Name)}`, option.Severity, option.Message);
                }
            }
        }
        return checks;
    }

    /**
     * NZBGet has no per-item ETA. It is derived the way the *arrs derive it:
     * items download in queue order at the current rate, so each item's ETA
     * is everything ahead of it plus its own unpaused remainder. A paused
     * item (or a paused queue) has no ETA.
     */
    async getQueue(): Promise<QueueItem[]> {
        const [status, groups] = await Promise.all([this.#status(), this.#groups()]);
        const rate = int64(status.DownloadRateHi, status.DownloadRateLo) ?? status.DownloadRate ?? 0;
        let ahead = 0;
        return groups
            .filter((group): group is RawGroup & { NZBID: number } => typeof group.NZBID === 'number')
            .map(group => {
                const size = int64(group.FileSizeHi, group.FileSizeLo, group.FileSizeMB);
                const remaining = int64(group.RemainingSizeHi, group.RemainingSizeLo, group.RemainingSizeMB);
                const paused = int64(group.PausedSizeHi, group.PausedSizeLo, group.PausedSizeMB) ?? 0;
                let eta: number | undefined;
                if (
                    remaining !== undefined &&
                    status.DownloadPaused !== true &&
                    !(remaining === paused && remaining !== 0) &&
                    rate > 0
                ) {
                    const own = Math.max(0, remaining - paused);
                    eta = Math.round((ahead + own) / rate);
                    ahead += own;
                }
                return {
                    service: this.id,
                    id: String(group.NZBID),
                    title: fenceText(group.NZBNicename ?? group.NZBName ?? group.NZBFilename ?? '', {
                        service: this.id,
                        field: 'NZBNicename'
                    }),
                    status: queueStatus(group.Status),
                    protocol: 'usenet',
                    ...(size === undefined ? {} : { sizeBytes: size }),
                    ...(remaining === undefined ? {} : { remainingBytes: remaining }),
                    ...(eta === undefined ? {} : { etaSeconds: eta }),
                    downloadId: droneParameter(group.Parameters) ?? String(group.NZBID)
                };
            });
    }

    readonly supportsBlocklist = false;

    /**
     * removeFromClient=true deletes the group and its files (GroupFinalDelete).
     * removeFromClient=false parks it: the group leaves the queue for history
     * with its downloaded files kept (GroupParkDelete), so it can be
     * redownloaded from there.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        const numericId = asIntegerId(id, this.id);
        const command = opts.removeFromClient ? 'GroupFinalDelete' : 'GroupParkDelete';
        const ok = await this.#rpc<boolean>('editqueue', [command, 0, '', [numericId]], (value): value is boolean => typeof value === 'boolean');
        if (!ok) {
            throw new ServiceError('UpstreamError', this.id, `queue ${command} of ${id} was refused`, {
                remedy: 'Check that the queue item is still present — take a current id from get_queue.'
            });
        }
    }

    async readPauseState(id?: string): Promise<PauseState> {
        if (id !== undefined) {
            const numericId = asIntegerId(id, this.id);
            const groups = await this.#groups();
            const group = groups.find(row => row.NZBID === numericId);
            if (group === undefined) {
                throw new ServiceError('NotFound', this.id, `nothing in the queue has id "${id}"`, {
                    remedy: 'Take a current NZBGet id from get_queue.'
                });
            }
            // `Status` stays DOWNLOADING after GroupPause until in-flight
            // articles drain; every remaining byte being paused is the state
            // the pause actually set.
            const remaining = int64(group.RemainingSizeHi, group.RemainingSizeLo, group.RemainingSizeMB);
            const pausedBytes = int64(group.PausedSizeHi, group.PausedSizeLo, group.PausedSizeMB) ?? 0;
            return {
                paused:
                    (group.Status ?? '').toLowerCase().includes('paused') ||
                    (remaining !== undefined && remaining > 0 && pausedBytes >= remaining),
                scope: `queue item ${id}`
            };
        }

        const body = await this.#status();
        return {
            paused: body.ServerPaused === true || body.DownloadPaused === true || body.Download2Paused === true,
            scope: 'the NZBGet download queue'
        };
    }

    async setPaused(paused: boolean, id?: string): Promise<void> {
        if (id !== undefined) {
            const numericId = asIntegerId(id, this.id);
            const command = paused ? 'GroupPause' : 'GroupResume';
            const ok = await this.#rpc<boolean>('editqueue', [command, 0, '', [numericId]], (value): value is boolean => typeof value === 'boolean');
            if (!ok) {
                throw new ServiceError('UpstreamError', this.id, `${command} was refused for queue item ${id}`);
            }
            return;
        }

        const method = paused ? 'pausedownload' : 'resumedownload';
        const ok = await this.#rpc<boolean>(method, [], (value): value is boolean => typeof value === 'boolean');
        if (!ok) throw new ServiceError('UpstreamError', this.id, `${method} was refused`);
    }

    async readSpeedLimit(): Promise<SpeedLimit> {
        const body = await this.#status();
        if (typeof body.DownloadLimit !== 'number' || !Number.isFinite(body.DownloadLimit) || body.DownloadLimit <= 0) {
            return { service: this.id };
        }
        return { service: this.id, kbps: Math.round(body.DownloadLimit / 1024) };
    }

    async setSpeedLimit(kbps: number | undefined): Promise<void> {
        const value = kbps === undefined || kbps <= 0 ? 0 : Math.round(kbps);
        const ok = await this.#rpc<boolean>('rate', [value], (result): result is boolean => typeof result === 'boolean');
        if (!ok) throw new ServiceError('UpstreamError', this.id, 'the speed limit was refused');
    }

    /**
     * The whole client's history, unfiltered by event: an array tells
     * get_history to apply `event_type` itself. NZBGet has no per-movie or
     * per-series history, so an `id` is refused rather than matched against
     * NZB ids that mean something else.
     */
    async readHistory(opts: HistoryQuery): Promise<HistoryEntry[]> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'NZBGet has no per-movie or per-series history', {
                remedy: 'Scope `id` to an *arr, which knows what the id means. NZBGet answers for the whole client.'
            });
        }

        const rows = objectsIn<RawHistory>(await this.#rpc<unknown[]>('history', [false], isArray));
        return rows.flatMap(row => {
            // A row that cannot be dated is dropped rather than stamped with
            // the epoch, as for SABnzbd.
            if (typeof row.HistoryTime !== 'number' || !Number.isFinite(row.HistoryTime)) return [];
            const at = new Date(row.HistoryTime * 1000).toISOString();
            if (opts.since !== undefined && at < opts.since) return [];

            const status = row.Status ?? 'unknown';
            const event = historyEvent(status);
            const entry: HistoryEntry = {
                service: this.id,
                id: String(row.NZBID ?? row.ID ?? ''),
                at,
                event,
                rawEvent: status,
                title: fenceText(row.NZBNicename ?? row.Name ?? row.NZBFilename ?? '', {
                    service: this.id,
                    field: 'NZBNicename'
                }),
                ...(event === 'imported'
                    ? {}
                    : { reason: fenceText(historyReason(row, status), { service: this.id, field: 'Status' }) })
            };
            return [entry];
        });
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, async () => {
            const version = await this.getVersion();
            // An add-user may call version, so probe a method it may not.
            await this.#status();
            return version;
        });
    }
}
