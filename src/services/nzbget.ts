import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { basicAuth, decodeOrRaw } from '../core/auth.ts';
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
    type PostProcessCapable,
    type PostProcessOutcome,
    type PostProcessTarget,
    type PauseState,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RemoveQueueOptions,
    type RetryCapable,
    type RetryMethod,
    type RetryOutcome,
    type RetryTarget,
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
    Kind?: string;
    NZBFilename?: string;
    Name?: string;
    NZBName?: string;
    NZBNicename?: string;
    DestDir?: string;
    FinalDir?: string;
    HistoryTime?: number;
    Status?: string;
    ParStatus?: string;
    UnpackStatus?: string;
    MoveStatus?: string;
    ScriptStatus?: string;
    DeleteStatus?: string;
    MarkStatus?: string;
    UrlStatus?: string;
    /** Per mille of articles downloaded; 1000 is all of them. */
    Health?: number;
    Parameters?: RawParameter[];
};
type RawLogMessage = { ID?: unknown; Kind?: unknown; Text?: unknown };
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
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
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
 * The DELETED/* details that are a failed download, not someone's choice:
 * HEALTH is NZBGet aborting a download with too many missing articles (Radarr
 * counts it as failed too), BAD a download marked bad, SCAN an NZB that could
 * not be parsed. MANUAL, DUPE, COPY and GOOD stay deletions.
 */
const FAILED_DELETIONS = new Set(['HEALTH', 'BAD', 'SCAN']);

/**
 * `Status` is `<KIND>/<DETAIL>`: SUCCESS/*, FAILURE/*, DELETED/* and
 * WARNING/* (see NzbInfo::MakeTextStatus). A WARNING is neither an import nor
 * a failure — a damaged or password-protected download waiting on a human —
 * so it stays `unknown` with its raw status kept.
 */
const historyEvent = (status: string): HistoryEventType => {
    const [kind, detail] = status.toUpperCase().split('/');
    if (kind === 'SUCCESS') return 'imported';
    if (kind === 'FAILURE') return 'failed';
    if (kind === 'DELETED') return detail !== undefined && FAILED_DELETIONS.has(detail) ? 'failed' : 'deleted';
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

/**
 * The scripts enabled for one download. NZBGet records each as a
 * post-processing parameter named `<script>:` with the value `yes`; the
 * built-in options it stores the same way start with `*` (`*Unpack:`).
 */
const enabledScripts = (parameters: unknown): string[] =>
    objectsIn<RawParameter>(parameters).flatMap(p =>
        typeof p.Name === 'string' &&
        p.Name.endsWith(':') &&
        p.Name.length > 1 &&
        !p.Name.startsWith('*') &&
        typeof p.Value === 'string' &&
        p.Value.toLowerCase() === 'yes'
            ? [p.Name.slice(0, -1)]
            : []
    );

/** A non-NZB history record in fixed words, never NZBGet's own text. */
const describeKind = (kind: string | undefined): string =>
    kind === 'URL' ? 'a URL fetch' : kind === 'DUP' ? 'a duplicate record' : 'an unrecognised record';

/** What a `drone` id looks like when an *arr set it. Anything else is
 *  someone's free text, and is not passed on as an id. */
const DOWNLOAD_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/** How often, and for how long, a rerun is watched for a sign that it started.
 *  A download with nothing left to do is back in history within about a
 *  second on 21.0; a real unpack or script shows in the queue at once. The
 *  full history is read only when the log says the download was filed, or on
 *  every fourth poll, because it can hold thousands of rows. */
const POST_PROCESS_POLL_MS = 250;
const POST_PROCESS_POLLS = 20;
const POST_PROCESS_HISTORY_EVERY = 4;
/** How many previewed rows are kept for their confirm. */
const POST_PROCESS_CACHED = 8;
/** PrePostProcessor.cpp's line when it accepts the rerun, and QueueCoordinator's
 *  when the download is filed into history again. */
const POST_PROCESS_STARTED = 'Post-processing again';
const filedLine = (name: string): string => `Collection ${name} added to history`;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** PrePostProcessor.cpp's refusal when the download's folder is gone. NZBGet
 *  still answers `true` to the editqueue call, so the log is the only place
 *  the refusal shows. */
const POST_PROCESS_REFUSED = 'Could not post-process again';

/** The id get_queue and the *arrs use for a history row, when it has one
 *  of the expected shape. */
const historyDownloadId = (row: RawHistory): { downloadId?: string } => {
    const id = droneParameter(row.Parameters) ?? (typeof row.NZBID === 'number' ? String(row.NZBID) : undefined);
    return id !== undefined && DOWNLOAD_ID_SHAPE.test(id) ? { downloadId: id } : {};
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

/** HistoryCoordinator::HistoryRetry's lines (21.0) for a HistoryRetryFailed:
 *  it logs the start, or a refusal when the item is not an NZB or its
 *  DestDir is gone, and the editqueue call answers `true` either way. */
const RETRY_STARTED = 'Retrying failed articles for';
const RETRY_REFUSED = 'Could not retry failed articles for';

/** The parameter Unpack.cpp reads the archive password from. 21.0's
 *  HistorySetParameter splits its text at the first `=`, so a password that
 *  contains `=` survives whole. */
const UNPACK_PASSWORD = '*Unpack:Password';

const RETRY_MISSING_REMEDY =
    'Take a current id from get_history or get_queue. If Radarr or Sonarr grabbed it, its "Remove Failed" setting (Settings → Download Clients) deletes failed downloads from NZBGet; turn it off to keep them retryable.';

/**
 * Which retry a failed history row needs, or `undefined` when neither helps.
 * Missing articles have to be fetched again (HistoryRetryFailed); a download
 * whose articles are all there but would not unpack, usually for want of a
 * password, needs only post-processing again.
 */
const retryMethod = (row: RawHistory): RetryMethod | undefined => {
    const status = (row.Status ?? '').toUpperCase();
    const par = (row.ParStatus ?? '').toUpperCase();
    const unpack = (row.UnpackStatus ?? '').toUpperCase();
    if (['DELETED/HEALTH', 'FAILURE/HEALTH', 'FAILURE/PAR'].includes(status) || par === 'FAILURE') return 'retry-failed';
    // Articles missing and no par repair made up for them: no par files, or
    // none checked. A repaired download (ParStatus SUCCESS) has them all.
    if (par !== 'SUCCESS' && typeof row.Health === 'number' && row.Health < 1000) return 'retry-failed';
    const complete = par === 'SUCCESS' || (par !== 'FAILURE' && row.Health === 1000);
    const locked = unpack === 'FAILURE' || unpack === 'PASSWORD' || status === 'WARNING/PASSWORD';
    return complete && locked ? 'postprocess' : undefined;
};

/** The statuses that are a failure at all; anything else did not fail. */
const isFailedStatus = (status: string): boolean => {
    const upper = status.toUpperCase();
    return upper.startsWith('FAILURE/') || upper.startsWith('WARNING/') || upper === 'DELETED/HEALTH';
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
        HistoryCapable,
        PostProcessCapable,
        RetryCapable
{
    readonly type: ServiceId = 'nzbget';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;
    /** Basic auth needs a username; without one nothing is sent at all. */
    readonly #passwordOnly: boolean;
    #nextRpcId = 1;

    constructor(config: ConfigByService['nzbget'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('nzbget', config.name);
        // A username in the URL (`http://nzbget@host`) pairs with the
        // configured password; userinfo alone would send an empty one.
        const urlUsername = decodeOrRaw(new URL(config.url).username);
        const username = (config.username ?? '') === '' && urlUsername !== '' ? urlUsername : config.username;
        // WebServer.cpp answers a 401 before reading the POST body but keeps
        // the connection open, so the next request on it fails. Without
        // keep-alive NZBGet closes after each reply.
        this.#http = new ServiceHttp(this.id, config, basicAuth({ username, password: config.password }), fetchImpl, {
            closeConnection: true
        });
        this.#passwordOnly = config.password !== undefined && config.password !== '' && (username ?? '') === '';
    }

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
            if (body.error.code === RPC_NO_REPORT) return [];
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
     * item (or a paused queue), and one with nothing left to download, has
     * no ETA.
     */
    async getQueue(): Promise<QueueItem[]> {
        const [status, groups] = await Promise.all([this.#status(), this.#groups()]);
        const rate = int64(status.DownloadRateHi, status.DownloadRateLo) ?? status.DownloadRate ?? 0;
        const queuePaused = status.ServerPaused === true || status.DownloadPaused === true || status.Download2Paused === true;
        let ahead = 0;
        return groups
            .filter((group): group is RawGroup & { NZBID: number } => typeof group.NZBID === 'number')
            .map(group => {
                const size = int64(group.FileSizeHi, group.FileSizeLo, group.FileSizeMB);
                const remaining = int64(group.RemainingSizeHi, group.RemainingSizeLo, group.RemainingSizeMB);
                const paused = int64(group.PausedSizeHi, group.PausedSizeLo, group.PausedSizeMB) ?? 0;
                const own = remaining === undefined ? 0 : remaining - paused;
                let eta: number | undefined;
                if (!queuePaused && own > 0 && rate > 0) {
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
        const ok = await this.#rpc<boolean>('editqueue', [command, 0, '', [numericId]], isBoolean);
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
            const ok = await this.#rpc<boolean>('editqueue', [command, 0, '', [numericId]], isBoolean);
            if (!ok) {
                throw new ServiceError('UpstreamError', this.id, `${command} was refused for queue item ${id}`);
            }
            return;
        }

        const method = paused ? 'pausedownload' : 'resumedownload';
        const ok = await this.#rpc<boolean>(method, [], isBoolean);
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
        const ok = await this.#rpc<boolean>('rate', [value], isBoolean);
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
            // the epoch, as for SABnzbd; one with no id cannot be referred to.
            if (typeof row.HistoryTime !== 'number' || !Number.isFinite(row.HistoryTime)) return [];
            const id = row.NZBID ?? row.ID;
            if (typeof id !== 'number') return [];
            const at = new Date(row.HistoryTime * 1000).toISOString();
            if (opts.since !== undefined && at < opts.since) return [];

            const status = row.Status ?? 'unknown';
            const event = historyEvent(status);
            const entry: HistoryEntry = {
                service: this.id,
                id: String(id),
                at,
                event,
                rawEvent: status,
                title: fenceText(row.NZBNicename ?? row.Name ?? row.NZBFilename ?? '', {
                    service: this.id,
                    field: 'NZBNicename'
                }),
                ...(event === 'imported'
                    ? {}
                    : { reason: fenceText(historyReason(row, status), { service: this.id, field: 'Status' }) }),
                ...historyDownloadId(row)
            };
            return [entry];
        });
    }

    /** Whether a queue group or history row is the download this id names:
     *  by its `drone` parameter (what an *arr's queue shows) or, for an NZB
     *  added by hand, by its NZBID (what get_queue falls back to). */
    #isDownload(row: { NZBID?: number; Parameters?: RawParameter[] }, downloadId: string): boolean {
        // Case-insensitive, as trigger_scan's import matches the same id.
        const drone = droneParameter(row.Parameters);
        if (drone !== undefined) return drone.toLowerCase() === downloadId.toLowerCase();
        return /^\d+$/.test(downloadId) && typeof row.NZBID === 'number' && String(row.NZBID) === downloadId;
    }

    /** A rerun of a download already in the queue would run twice on one
     *  folder, so it is refused while one is in progress. Not an upstream
     *  fault: the download simply is not back in history yet. */
    async #refuseIfQueued(downloadId: string): Promise<void> {
        const queued = (await this.#groups()).find(group => this.#isDownload(group, downloadId));
        if (queued !== undefined) {
            throw new ServiceError(
                'NotFound',
                this.id,
                `download ${downloadId} is not in NZBGet's history yet: it is still in the queue, as ${fenceText(queueStatus(queued.Status), { service: this.id, field: 'Status' })}`,
                { remedy: 'Wait until it has finished and is back in history (get_queue shows it until then), then try again.' }
            );
        }
    }

    /**
     * The history row a download id names. Only downloaded NZBs have files: a
     * URL fetch an *arr sent leaves its own row with the same drone id, and is
     * set aside before choosing. The same NZB grabbed twice leaves two rows,
     * and the newest is the one whose folder can still exist.
     */
    async #historyRow(downloadId: string): Promise<RawHistory & { ID: number }> {
        const rows = objectsIn<RawHistory>(await this.#rpc<unknown[]>('history', [false], isArray)).filter(
            (row): row is RawHistory & { ID: number } => typeof row.ID === 'number' && this.#isDownload(row, downloadId)
        );
        const row = rows
            .filter(r => r.Kind === undefined || r.Kind === 'NZB')
            .sort((a, b) => (b.HistoryTime ?? 0) - (a.HistoryTime ?? 0))[0];
        if (row !== undefined) return row;
        if (rows.length > 0) {
            throw new ServiceError('NotFound', this.id, `download "${downloadId}" has no downloaded files in NZBGet's history, only ${describeKind(rows[0]?.Kind)}`, {
                remedy: 'Post-processing runs on downloaded files. Use the download\'s own row, once NZBGet has fetched and downloaded it.'
            });
        }
        throw new ServiceError('NotFound', this.id, `nothing in NZBGet's history has download id "${downloadId}"`, {
            remedy: 'Take the id from `downloadId` on a get_queue or get_history row. Post-processing can only be run again while NZBGet still has the download in its history.'
        });
    }

    #postProcessTarget(row: RawHistory & { ID: number }): PostProcessTarget {
        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
        // Post-processing runs in DestDir, and NZBGet refuses when it is gone;
        // FinalDir is only where a finished download was moved to afterwards.
        const destDir = row.DestDir ?? '';
        const finalDir = row.FinalDir ?? '';
        return {
            historyId: String(row.ID),
            ...(typeof row.HistoryTime === 'number' ? { historyTime: row.HistoryTime } : {}),
            title: fence(row.NZBNicename ?? row.Name ?? row.NZBName ?? '', 'NZBNicename'),
            status: fence(row.Status ?? 'unknown', 'Status'),
            ...(destDir === '' ? {} : { folder: fence(destDir, 'DestDir') }),
            ...(finalDir === '' || finalDir === destDir ? {} : { finalFolder: fence(finalDir, 'FinalDir') }),
            scripts: enabledScripts(row.Parameters).map(script => fence(script, 'Parameters'))
        };
    }

    /**
     * The rows the last few previews resolved, by history id. On confirm the write
     * harness re-runs the preview immediately before applying, and the token
     * has bound that history id and time, so the run reuses the row instead of
     * reading the queue and the whole history again.
     */
    readonly #resolved = new Map<string, RawHistory & { ID: number }>();

    async findPostProcessTarget(downloadId: string): Promise<PostProcessTarget> {
        await this.#refuseIfQueued(downloadId);
        const row = await this.#historyRow(downloadId);
        this.#resolved.delete(String(row.ID));
        this.#resolved.set(String(row.ID), row);
        // Only a preview about to be confirmed needs its row: drop the oldest.
        for (const key of this.#resolved.keys()) {
            if (this.#resolved.size <= POST_PROCESS_CACHED) break;
            this.#resolved.delete(key);
        }
        return this.#postProcessTarget(row);
    }

    /** The id of the newest message in NZBGet's log, or 0 when it is empty. */
    async #lastLogId(): Promise<number> {
        const [last] = objectsIn<RawLogMessage>(await this.#rpc<unknown[]>('log', [0, 1], isArray));
        return typeof last?.ID === 'number' ? last.ID : 0;
    }

    /**
     * "Post-process again" on the exact history row the preview showed.
     *
     * NZBGet answers `true` even when it then refuses because the download's
     * folder is gone, and logs the refusal instead, so the answer alone proves
     * nothing. After sending, the item is watched for about five seconds:
     * in the queue is `running`; back in history after this rerun is
     * `finished`, with whatever status it finished on; filed after this rerun
     * and then gone from both, or gone from both at the end after NZBGet
     * showed it running, is `removed` (an *arr already took the result); a
     * logged refusal is an error. Anything else is an error, never a success.
     */
    async runPostProcess(downloadId: string, historyId: string): Promise<PostProcessOutcome> {
        let row = this.#resolved.get(historyId);
        this.#resolved.delete(historyId);
        if (row === undefined || !this.#isDownload(row, downloadId)) {
            // Not previewed by this instance (or for another id): look again.
            await this.#refuseIfQueued(downloadId);
            row = await this.#historyRow(downloadId);
        }
        if (String(row.ID) !== historyId) {
            throw new ServiceError('NotFound', this.id, `download ${downloadId} no longer resolves to the history item the preview showed`, {
                remedy: 'Preview it again: NZBGet\'s history changed in between.'
            });
        }
        const target = this.#postProcessTarget(row);
        const mark = await this.#lastLogId();

        const ok = await this.#rpc<boolean>('editqueue', ['HistoryProcess', 0, '', [row.ID]], isBoolean);
        if (!ok) {
            throw new ServiceError('UpstreamError', this.id, `NZBGet refused to post-process download ${downloadId} again`, {
                remedy: 'Check that the download is still in NZBGet\'s history — take a current id from get_history.'
            });
        }
        return this.#watchPostProcess(row, target, { mark, label: `download ${downloadId}` });
    }

    /**
     * Watches a `HistoryProcess` just sent for proof it ran, shared by
     * runPostProcess and runRetry. `mark` is the newest log id from before
     * the send, so only that request's messages are read; `label` names the
     * download in the errors.
     */
    async #watchPostProcess(
        row: RawHistory & { ID: number },
        target: PostProcessTarget,
        { mark, label }: { mark: number; label: string }
    ): Promise<PostProcessOutcome> {
        // PrePostProcessor.cpp writes "Could not post-process again <NZBName>: …".
        // Matching the whole prefix keeps `Some.Release.REPACK`'s refusal, or
        // one whose path merely contains this name, from reading as this one's.
        const name = row.NZBName ?? row.Name;
        const named = name !== undefined && name !== '';
        const refusalPrefix = named ? `${POST_PROCESS_REFUSED} ${name}:` : undefined;
        const isThisRow = (r: { NZBID?: number }) => typeof r.NZBID === 'number' && r.NZBID === (row.NZBID ?? row.ID);
        const status = (raw: string | undefined) => fenceText(raw ?? 'unknown', { service: this.id, field: 'Status' });
        // Evidence that the rerun really ran, as opposed to NZBGet having
        // accepted the request and done nothing.
        let started = false;
        let seenInQueue = false;
        let seenLeftHistory = false;
        const last = POST_PROCESS_POLLS - 1;

        for (let poll = 0; poll < POST_PROCESS_POLLS; poll++) {
            if (poll > 0) await delay(POST_PROCESS_POLL_MS);

            // Only the messages logged since the request, read alongside the queue.
            const [messages, groups] = await Promise.all([
                this.#rpc<unknown[]>('log', [mark + 1, 0], isArray).then(rows => objectsIn<RawLogMessage>(rows)),
                this.#groups()
            ]);
            const texts = messages.flatMap(m => (typeof m.Text === 'string' ? [{ kind: m.Kind, text: m.Text }] : []));

            const refusal = texts.find(m => m.kind === 'ERROR' && refusalPrefix !== undefined && m.text.startsWith(refusalPrefix));
            if (refusal !== undefined) {
                throw new ServiceError('UpstreamError', this.id, fenceText(refusal.text, { service: this.id, field: 'log' }), {
                    remedy: "NZBGet only post-processes files still in the download's folder, and that folder has been moved or deleted — usually by an *arr's import or a cleanup. Nothing was changed. If the files are gone, grab the release again instead."
                });
            }
            if (named && texts.some(m => m.text === `${POST_PROCESS_STARTED} ${name}`)) started = true;
            // The filing line names only the NZB, which another row of the same
            // NZB can share, so it counts only after this rerun's own start line.
            const filedAgain = started && texts.some(m => m.text === filedLine(name as string));

            const queued = groups.find(isThisRow);
            if (queued !== undefined) {
                seenInQueue = true;
                const finishing = (queued.Status ?? '').toUpperCase() === 'PP_FINISHED';
                // PP_FINISHED is done but not yet filed: wait for history, which
                // says whether it succeeded, unless time is up.
                if (!finishing || poll === last) return { target, state: 'running', status: status(queueStatus(queued.Status)) };
                continue;
            }

            // The full history can hold thousands of rows: read it when the log
            // says the download was filed, every fourth poll, and on the last.
            if (!filedAgain && poll !== last && poll % POST_PROCESS_HISTORY_EVERY !== POST_PROCESS_HISTORY_EVERY - 1) continue;

            const filed = objectsIn<RawHistory>(await this.#rpc<unknown[]>('history', [false], isArray)).find(r => r.ID === row.ID);
            if (filed === undefined) {
                // Filed after this rerun and then gone, or gone at the end after
                // NZBGet showed the rerun running: an *arr's "Remove Completed"
                // already took the result. Missing alone is not proof it ran.
                if (filedAgain || (poll === last && (started || seenInQueue))) return { target, state: 'removed' };
                seenLeftHistory = true;
                continue;
            }
            const refiled =
                filedAgain ||
                seenInQueue ||
                seenLeftHistory ||
                (typeof filed.HistoryTime === 'number' && typeof row.HistoryTime === 'number' && filed.HistoryTime > row.HistoryTime);
            if (refiled) {
                const raw = filed.Status ?? 'unknown';
                return { target, state: 'finished', event: historyEvent(raw), status: status(raw) };
            }
        }

        if (started) {
            throw new ServiceError('UpstreamError', this.id, `NZBGet started post-processing ${label} again, but had not filed a result when the wait ran out`, {
                remedy: 'It was not reported as done. get_queue and get_history show where it stands now.'
            });
        }
        throw new ServiceError('UpstreamError', this.id, `NZBGet accepted the request for ${label} but showed no sign of post-processing it`, {
            remedy: "It was not reported as done, because it may not have run. The usual cause is that the download's folder no longer exists; NZBGet's Messages page says for certain."
        });
    }

    /**
     * The failed history row an id names, and what retrying it means. The id
     * is the history id get_history shows. NZBGet ignores `hasPassword`: an
     * encrypted download fails into history like any other, and nothing in
     * the queue waits for a password.
     */
    async findRetryTarget(id: string, _opts: { hasPassword: boolean }): Promise<RetryTarget> {
        return (await this.#retryRow(id)).target;
    }

    async #retryRow(id: string): Promise<{ row: RawHistory & { ID: number }; target: RetryTarget }> {
        const numericId = asIntegerId(id, this.id);
        const rows = objectsIn<RawHistory>(await this.#rpc<unknown[]>('history', [false], isArray)).filter(
            (r): r is RawHistory & { ID: number } => r.ID === numericId
        );
        const row = rows.find(r => r.Kind === undefined || r.Kind === 'NZB');
        if (row === undefined) {
            if (rows.length > 0) {
                throw new ServiceError('NotFound', this.id, `history item ${id} is ${describeKind(rows[0]?.Kind)}, not a download`, {
                    remedy: 'Only a downloaded NZB can be retried. Take a failed id from get_history.'
                });
            }
            if ((await this.#groups()).some(group => group.NZBID === numericId)) {
                throw new ServiceError('NotFound', this.id, `download ${id} has not failed; it is still in the queue`, {
                    remedy: 'Check its progress with get_queue. Only a failed download can be retried.'
                });
            }
            throw new ServiceError('NotFound', this.id, `nothing in NZBGet's history has id "${id}"`, { remedy: RETRY_MISSING_REMEDY });
        }

        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
        const raw = row.Status ?? 'unknown';
        if (!isFailedStatus(raw)) {
            throw new ServiceError('NotFound', this.id, `download ${id} did not fail; only a failed download can be retried`, {
                remedy: `NZBGet shows it as ${fence(raw, 'Status')}. Take a failed id from get_history.`
            });
        }
        const method = retryMethod(row);
        if (method === undefined) {
            throw new ServiceError('NotFound', this.id, `download ${id} failed in a way a retry cannot fix`, {
                remedy: `NZBGet shows it as ${fence(historyReason(row, raw), 'Status')}. A retry only fetches missing articles again, or unpacks again once every article is there. Fix the cause in NZBGet, or grab another release.`
            });
        }
        return {
            row,
            target: {
                id,
                title: fence(row.NZBNicename ?? row.Name ?? row.NZBName ?? '', 'NZBNicename'),
                where: 'history',
                status: fence(raw, 'Status'),
                reason: fence(historyReason(row, raw), 'Status'),
                ...historyDownloadId(row),
                method
            }
        };
    }

    /**
     * Re-resolves the row first, so one that changed since the preview is
     * refused rather than sent the wrong edit. The password travels only in
     * the JSON-RPC params, and is set before anything runs, so nothing
     * unpacks without it.
     */
    async runRetry(id: string, opts: { method: RetryMethod; password?: string }): Promise<RetryOutcome> {
        const { row, target } = await this.#retryRow(id);
        if (target.method !== opts.method) {
            throw new ServiceError('NotFound', this.id, `download ${id} now needs "${target.method}", not "${opts.method}"`, {
                remedy: 'It changed since the preview. Preview retry_download again.'
            });
        }
        if (opts.password !== undefined && opts.password !== '') await this.#setUnpackPassword(row, id, opts.password);
        return opts.method === 'postprocess' ? this.#retryPostProcess(row, target) : this.#retryFailed(row, target);
    }

    /** NZBGet's error text and the cause are dropped: a server could quote the
     *  parameter, password and all, back in either. */
    async #setUnpackPassword(row: RawHistory & { ID: number }, id: string, password: string): Promise<void> {
        const refused = (kind: 'UpstreamError' | 'AuthFailed') =>
            new ServiceError(kind, this.id, `NZBGet refused to set the unpack password on download ${id}`, {
                remedy: "Nothing was retried. Check the download is still in NZBGet's history (take a current id from get_history) and that this login may edit it."
            });
        let ok: boolean;
        try {
            ok = await this.#rpc<boolean>('editqueue', ['HistorySetParameter', 0, `${UNPACK_PASSWORD}=${password}`, [row.ID]], isBoolean);
        } catch (err) {
            throw refused(err instanceof ServiceError && err.kind === 'AuthFailed' ? 'AuthFailed' : 'UpstreamError');
        }
        if (!ok) throw refused('UpstreamError');
    }

    async #retryPostProcess(row: RawHistory & { ID: number }, target: RetryTarget): Promise<RetryOutcome> {
        const mark = await this.#lastLogId();
        const ok = await this.#rpc<boolean>('editqueue', ['HistoryProcess', 0, '', [row.ID]], isBoolean);
        if (!ok) {
            throw new ServiceError('UpstreamError', this.id, `NZBGet refused to post-process download ${target.id} again`, {
                remedy: "Check that the download is still in NZBGet's history — take a current id from get_history."
            });
        }
        const seen = await this.#watchPostProcess(row, this.#postProcessTarget(row), { mark, label: `download ${target.id}` });
        if (seen.state === 'running') return { target, id: target.id, state: 'processing', status: seen.status };
        if (seen.state === 'finished') return { target, id: target.id, state: 'finished', event: seen.event, status: seen.status };
        // Filed and already gone from history: an *arr took the result.
        return { target, id: target.id, state: 'finished', status: 'removed' };
    }

    /**
     * 21.0's HistoryRetryFailed (HistoryCoordinator::HistoryRetry with
     * resetFailed) checks only that the row is an NZB and its DestDir exists,
     * never its status, and moves it back to the queue under the same NZBID.
     * It answers `true` even when it refuses, so the queue is the proof.
     */
    async #retryFailed(row: RawHistory & { ID: number }, target: RetryTarget): Promise<RetryOutcome> {
        const mark = await this.#lastLogId();
        const ok = await this.#rpc<boolean>('editqueue', ['HistoryRetryFailed', 0, '', [row.ID]], isBoolean);
        if (!ok) {
            throw new ServiceError('UpstreamError', this.id, `NZBGet refused to retry download ${target.id}`, {
                remedy: "Check that the download is still in NZBGet's history — take a current id from get_history."
            });
        }

        const name = row.NZBName ?? row.Name;
        const named = name !== undefined && name !== '';
        const nzbId = row.NZBID ?? row.ID;
        const status = (raw: string) => fenceText(raw, { service: this.id, field: 'Status' });
        let started = false;
        for (let poll = 0; poll < POST_PROCESS_POLLS; poll++) {
            if (poll > 0) await delay(POST_PROCESS_POLL_MS);
            const [messages, groups] = await Promise.all([
                this.#rpc<unknown[]>('log', [mark + 1, 0], isArray).then(rows => objectsIn<RawLogMessage>(rows)),
                this.#groups()
            ]);
            for (const m of messages) {
                if (!named || typeof m.Text !== 'string') continue;
                // The whole prefix, so a look-alike name's refusal is not this one's.
                if (m.Kind === 'ERROR' && m.Text.startsWith(`${RETRY_REFUSED} ${name}:`)) {
                    throw new ServiceError('UpstreamError', this.id, fenceText(m.Text, { service: this.id, field: 'log' }), {
                        remedy: "NZBGet only retries a download whose folder still exists, and that folder has been moved or deleted. Nothing was retried. Grab the release again instead."
                    });
                }
                if (m.Text === `${RETRY_STARTED} ${name}`) started = true;
            }
            const queued = groups.find(group => group.NZBID === nzbId);
            if (queued !== undefined) return { target, id: target.id, state: 'downloading', status: status(queueStatus(queued.Status)) };
        }

        // With nothing left to fetch it can be filed again between polls.
        if (started) {
            const filed = objectsIn<RawHistory>(await this.#rpc<unknown[]>('history', [false], isArray)).find(r => r.ID === row.ID);
            if (filed !== undefined && typeof filed.HistoryTime === 'number' && filed.HistoryTime > (row.HistoryTime ?? 0)) {
                const raw = filed.Status ?? 'unknown';
                return { target, id: target.id, state: 'finished', event: historyEvent(raw), status: status(raw) };
            }
        }
        throw new ServiceError('UpstreamError', this.id, `NZBGet accepted the retry of download ${target.id}, but it never appeared in the queue`, {
            remedy: "It was not reported as retried. The usual cause is that the download's folder no longer exists; NZBGet's Messages page says for certain."
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
