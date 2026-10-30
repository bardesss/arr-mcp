import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { queryParamKey } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type HistoryCapable,
    type HistoryEntry,
    type PauseCapable,
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

/**
 * Hand-written: SABnzbd's API is query-parameter driven and publishes no
 * OpenAPI document. The key travels in the URL, which is why ServiceHttp never
 * puts a full URL into an error message.
 */
type RawVersion = { version?: string };
type RawQueue = {
    queue?: {
        diskspace1?: string;
        diskspacetotal1?: string;
        diskspace2?: string;
        diskspacetotal2?: string;
        status?: string;
        /** Queue-wide, and the only client-level paused flag any of the three
         *  download clients publishes. */
        paused?: boolean;
        /** The cap in bytes/s, as a string. `speedlimit` beside it is a
         *  percentage — see `setSpeedLimit`. */
        speedlimit_abs?: string;
        slots?: RawSlot[];
    };
};
type RawHistory = { history?: { slots?: RawHistorySlot[] } };
type RawHistorySlot = {
    nzo_id?: string;
    name?: string;
    status?: string;
    fail_message?: string;
    /** Unix seconds. */
    completed?: number;
};

type RawSlot = {
    nzo_id?: string;
    filename?: string;
    status?: string;
    mb?: string;
    mbleft?: string;
    timeleft?: string;
    /** 3.0.0 and later list flags such as `ENCRYPTED` here, beside a plain
     *  `filename`; 2.x prefixed the filename instead (`ENCRYPTED / name`). */
    labels?: string[];
};

const BYTES_PER_MB = 1024 ** 2;

const megabytesToBytes = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * BYTES_PER_MB) : undefined;
};

const SAB_TIMELEFT = /^(?:(\d+):)?(\d+):(\d+):(\d+)$/;

/**
 * SABnzbd's timeleft is "H:MM:SS", or "D:HH:MM:SS" once more than 24h remain.
 * "0:00:00" is its placeholder for paused, stalled or zero-speed slots, so it
 * means no estimate rather than done.
 */
export function parseSabTimeleft(value: string | undefined): number | undefined {
    const parts = value === undefined ? null : SAB_TIMELEFT.exec(value.trim());
    if (parts === null) return undefined;
    const seconds = Number(parts[1] ?? 0) * 86_400 + Number(parts[2]) * 3600 + Number(parts[3]) * 60 + Number(parts[4]);
    return seconds > 0 ? seconds : undefined;
}

const BYTES_PER_GB = 1024 ** 3;

/**
 * SABnzbd reports disk space as gigabytes in a string — confirmed against a
 * live 5.0.4, which returned `"4711.95"`. A silent NaN here would surface as
 * "0 bytes free" in stack_health, which reads as a crisis rather than a bug.
 */
const gigabytesToBytes = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * BYTES_PER_GB) : undefined;
};

/** How long a retry or unlock is watched for proof SABnzbd acted: 20 × 250 ms. */
const RETRY_POLL_MS = 250;
const RETRY_POLLS = 20;

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The 2.x display form, where the label was baked into the queue name. */
const ENCRYPTED_PREFIX = 'ENCRYPTED / ';

/**
 * Whether SABnzbd flagged the slot as encrypted. Since 3.0.0 `build_queue`
 * sets `filename` to the plain `final_name` and the flag lives in `labels`;
 * the prefix check covers 2.x.
 *
 * The label is `T("ENCRYPTED")` — translated into SABnzbd's UI language — so
 * on a non-English SABnzbd it is not recognised here. `findRetryTarget`
 * refuses such a paused slot rather than guessing.
 */
const isEncrypted = (slot: RawSlot): boolean =>
    (slot.labels ?? []).some(l => l.toUpperCase() === 'ENCRYPTED') || (slot.filename ?? '').startsWith(ENCRYPTED_PREFIX);

/** The job's real name, which is what a rename has to send back unchanged. */
const plainName = (filename: string | undefined): string =>
    (filename ?? '').startsWith(ENCRYPTED_PREFIX) ? (filename ?? '').slice(ENCRYPTED_PREFIX.length) : (filename ?? '');

/** Queue statuses SABnzbd shows while post-processing rather than downloading. */
const PROCESSING_STATUSES = new Set(['verifying', 'repairing', 'extracting', 'moving', 'running']);

const MISSING_REMEDY =
    'Take a current id from get_history or get_queue. If Radarr or Sonarr grabbed it, its "Remove Failed" setting (Settings → Download Clients) deletes failed downloads from SABnzbd; turn it off to keep them retryable.';

export class SabnzbdAdapter
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        QueueCapable,
        QueueRemoveCapable,
        PauseCapable,
        SpeedLimitCapable,
        HistoryCapable,
        RetryCapable
{
    readonly type: ServiceId = 'sabnzbd';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['sabnzbd'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('sabnzbd', config.name);
        this.#http = new ServiceHttp(this.id, config, queryParamKey('apikey', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const body = await this.#http.get<RawVersion>('/api?mode=version&output=json');
        if (!body.version) {
            throw new ServiceError('UpstreamError', this.id, 'mode=version returned no version field');
        }
        return body.version;
    }

    /**
     * SABnzbd reports up to two download volumes. Both are surfaced, because a
     * stack with an incomplete and a complete directory on different disks can
     * run out of space on either.
     */
    async getDiskSpace(): Promise<DiskSpace[]> {
        const body = await this.#http.get<RawQueue>('/api?mode=queue&output=json');
        // `string | undefined` rather than optional: exactOptionalPropertyTypes
        // treats "absent" and "present but undefined" as different types, and
        // these fields are always present here, sometimes holding undefined.
        const volumes: { label: string; free: string | undefined; total: string | undefined }[] = [
            { label: 'SABnzbd download', free: body.queue?.diskspace1, total: body.queue?.diskspacetotal1 },
            { label: 'SABnzbd secondary', free: body.queue?.diskspace2, total: body.queue?.diskspacetotal2 }
        ];

        return volumes.flatMap(({ label, free, total }) => {
            const freeBytes = gigabytesToBytes(free);
            if (freeBytes === undefined) return [];
            const totalBytes = gigabytesToBytes(total);
            return [
                {
                    service: this.id,
                    path: label,
                    label,
                    freeSpace: freeBytes,
                    ...(totalBytes === undefined ? {} : { totalSpace: totalBytes })
                }
            ];
        });
    }

    async getQueue(): Promise<QueueItem[]> {
        const body = await this.#http.get<RawQueue>('/api?mode=queue&output=json');
        return (body.queue?.slots ?? [])
            .filter((s): s is RawSlot & { nzo_id: string } => typeof s.nzo_id === 'string')
            .map(s => {
                const size = megabytesToBytes(s.mb);
                const remaining = megabytesToBytes(s.mbleft);
                const eta = parseSabTimeleft(s.timeleft);
                return {
                    service: this.id,
                    id: s.nzo_id,
                    // A queue entry's filename is the release name it came from.
                    title: fenceText(s.filename ?? '', { service: this.id, field: 'filename' }),
                    status: (s.status ?? 'unknown').toLowerCase(),
                    protocol: 'usenet',
                    ...(size === undefined ? {} : { sizeBytes: size }),
                    ...(remaining === undefined ? {} : { remainingBytes: remaining }),
                    ...(eta === undefined ? {} : { etaSeconds: eta })
                };
            });
    }

    /** SABnzbd has no blocklist — that lives in the *arr that queued the grab. */
    readonly supportsBlocklist = false;

    /**
     * A write over GET, because that is SABnzbd's entire API — every mode,
     * read or write, is a query parameter on `/api`. It answers
     * `{"status": true}` on success and, notably, **also 200 with
     * `{"status": false}`** for an nzo_id it does not have, so the body has to
     * be checked. Trusting the status line would report a deletion that never
     * happened.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        const body = await this.#http.getAsWrite<{ status?: boolean; error?: string }>(
            `/api?mode=queue&name=delete&value=${encodeURIComponent(id)}&del_files=${opts.removeFromClient ? 1 : 0}&output=json`
        );

        if (body.status !== true) {
            throw new ServiceError('UpstreamError', this.id, `queue delete of ${id} was refused`, {
                remedy:
                    body.error ??
                    'SABnzbd reported no failure reason. Check the item is still in the queue — take a current id from get_queue.'
            });
        }
    }

    /**
     * SABnzbd is the one client with a real queue-wide paused flag, so this
     * reads it directly rather than inferring it from the items.
     *
     * With an id, the answer comes from that slot's own status — and a slot
     * that is no longer in the queue is refused, not reported as paused.
     */
    async readPauseState(id?: string): Promise<PauseState> {
        const body = await this.#http.get<RawQueue>('/api?mode=queue&output=json');

        if (id === undefined) {
            return { paused: body.queue?.paused === true, scope: 'the SABnzbd queue' };
        }

        const slot = (body.queue?.slots ?? []).find(s => s.nzo_id === id);
        if (slot === undefined) {
            throw new ServiceError('NotFound', this.id, `nothing in the queue has id "${id}"`, {
                remedy: 'Take a current nzo id from get_queue — ids do not survive an item leaving the queue.'
            });
        }
        return { paused: (slot.status ?? '').toLowerCase() === 'paused', scope: `queue item ${id}` };
    }

    /**
     * Like every SABnzbd write, a GET — and like every SABnzbd write, a
     * failure arrives as HTTP 200 with `status: false`, so the body is what
     * says whether anything happened.
     */
    async setPaused(paused: boolean, id?: string): Promise<void> {
        const path =
            id === undefined
                ? `/api?mode=${paused ? 'pause' : 'resume'}&output=json`
                : `/api?mode=queue&name=${paused ? 'pause' : 'resume'}&value=${encodeURIComponent(id)}&output=json`;

        const body = await this.#http.getAsWrite<{ status?: boolean; error?: string }>(path);
        if (body.status !== true) {
            throw new ServiceError(
                'UpstreamError',
                this.id,
                `${paused ? 'pause' : 'resume'} was refused`,
                {
                    remedy:
                        body.error ??
                        'SABnzbd reported no failure reason. Check the queue is reachable — call get_queue.'
                }
            );
        }
    }

    /**
     * `speedlimit_abs` is the cap in **bytes per second**, as a string;
     * `speedlimit` beside it is a percentage of the configured maximum, which
     * is the trap this whole capability exists around. An empty or zero
     * absolute value means no cap.
     */
    async readSpeedLimit(): Promise<SpeedLimit> {
        const body = await this.#http.get<RawQueue>('/api?mode=queue&output=json');
        const bytes = Number(body.queue?.speedlimit_abs ?? '');
        if (!Number.isFinite(bytes) || bytes <= 0) return { service: this.id };
        return { service: this.id, kbps: Math.round(bytes / 1024) };
    }

    /**
     * The `K` suffix is load-bearing: `value=100` sets **100 percent** of the
     * configured line speed, `value=100K` sets 100 KB/s. `value=0` clears it.
     */
    async setSpeedLimit(kbps: number | undefined): Promise<void> {
        const value = kbps === undefined || kbps <= 0 ? '0' : `${Math.round(kbps)}K`;
        const body = await this.#http.getAsWrite<{ status?: boolean; error?: string }>(
            `/api?mode=config&name=speedlimit&value=${encodeURIComponent(value)}&output=json`
        );

        if (body.status !== true) {
            throw new ServiceError('UpstreamError', this.id, 'the speed limit was refused', {
                remedy: body.error ?? 'SABnzbd reported no failure reason. Check it is reachable — call get_queue.'
            });
        }
    }

    /**
     * SABnzbd's own history — what happened to a download after it left the
     * queue, one layer below the *arr history `get_history` already merges.
     * When Radarr says "grabbed" and nothing arrived, this is where the reason
     * is.
     *
     * `id` is refused rather than answered empty: SABnzbd has no idea what a
     * movie or series id is, and an empty list would read as "nothing ever
     * happened to that film".
     */
    async readHistory(opts: { id?: string; since?: string }): Promise<HistoryEntry[]> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'SABnzbd has no per-movie or per-series history', {
                remedy: 'Scope `id` to radarr or sonarr, which know what the id means. SABnzbd answers for the whole client.'
            });
        }

        const body = await this.#http.get<RawHistory>('/api?mode=history&limit=100&output=json');

        return (body.history?.slots ?? [])
            .filter((s): s is RawHistorySlot & { nzo_id: string } => typeof s.nzo_id === 'string')
            .flatMap(s => {
                // `completed` is unix seconds. A row that cannot be dated is
                // dropped rather than stamped with the epoch: `get_history`
                // sorts and filters `since` as a plain string, so a 1970 date
                // would quietly sink to the bottom of every answer.
                if (typeof s.completed !== 'number' || !Number.isFinite(s.completed)) return [];
                const at = new Date(s.completed * 1000).toISOString();
                if (opts.since !== undefined && at < opts.since) return [];

                const status = (s.status ?? '').toLowerCase();
                return [
                    {
                        service: this.id,
                        id: s.nzo_id,
                        at,
                        event: status === 'completed' ? 'imported' : status === 'failed' ? 'failed' : 'unknown',
                        rawEvent: s.status ?? 'unknown',
                        title: fenceText(s.name ?? '', { service: this.id, field: 'name' }),
                        ...(s.fail_message
                            ? { reason: fenceText(s.fail_message, { service: this.id, field: 'fail_message' }) }
                            : {})
                    }
                ];
            });
    }

    /**
     * One queue slot by id. `nzo_ids` filters server-side from 4.x on, but
     * 3.0.0's `_api_queue_default` ignores it and answers the whole queue, so
     * the match is always made here.
     */
    async #queueSlot(id: string): Promise<RawSlot | undefined> {
        const body = await this.#http.get<RawQueue>(`/api?mode=queue&nzo_ids=${encodeURIComponent(id)}&output=json`);
        return (body.queue?.slots ?? []).find(s => s.nzo_id === id);
    }

    /**
     * One history slot by id. No `limit`: 3.0.0's `build_history` ignores
     * `nzo_ids`, and a limit would hide an older failure from it.
     */
    async #historySlot(id: string): Promise<RawHistorySlot | undefined> {
        const body = await this.#http.get<RawHistory>(`/api?mode=history&nzo_ids=${encodeURIComponent(id)}&output=json`);
        return (body.history?.slots ?? []).find(s => s.nzo_id === id);
    }

    #fence(value: string, field: string): string {
        return fenceText(value, { service: this.id, field });
    }

    /**
     * The two things SABnzbd can do for a stuck job: re-queue a failed one
     * from history (`retry`), or give a job it paused as encrypted its
     * password (`unlock`). Anything else is refused before a write is offered.
     */
    async findRetryTarget(id: string, opts: { hasPassword: boolean }): Promise<RetryTarget> {
        const queued = await this.#queueSlot(id);
        if (queued !== undefined) {
            const base = {
                id,
                title: this.#fence(plainName(queued.filename), 'filename'),
                where: 'queue' as const,
                status: this.#fence(queued.status ?? 'unknown', 'status'),
                downloadId: id
            };
            const paused = (queued.status ?? '').toLowerCase() === 'paused';

            if (isEncrypted(queued)) {
                // The label outlives the pause: `resume()` sets `encrypted = 2`
                // and the label stays. A running job has nothing to unlock,
                // and a watch on it would "succeed" without any write landing.
                if (!paused) {
                    throw new ServiceError('NotFound', this.id, `download ${id} is encrypted but not paused`, {
                        remedy: 'It is already running in SABnzbd, so there is nothing to unlock. Check its progress with get_queue.'
                    });
                }
                if (!opts.hasPassword) {
                    throw new ServiceError('NotFound', this.id, `download ${id} is paused because it is encrypted`, {
                        remedy: 'Pass `password` with the archive password from the site the NZB came from; SABnzbd cannot unpack it without one.'
                    });
                }
                return { ...base, method: 'unlock' };
            }
            if (paused && opts.hasPassword) {
                // The ENCRYPTED label is translated, so a non-English SABnzbd
                // can hide it. Without it, a password would be a guess.
                throw new ServiceError('NotFound', this.id, `download ${id} is paused, but not flagged as encrypted`, {
                    remedy: "Encryption could not be confirmed — the label may be in another language on a non-English SABnzbd. If it is encrypted, set its password and resume it from SABnzbd's own UI."
                });
            }
            throw new ServiceError('NotFound', this.id, `download ${id} has not failed; it is still in the queue`, {
                remedy: 'Check its progress with get_queue. Only a failed download, or one paused as encrypted, can be retried.'
            });
        }

        const filed = await this.#historySlot(id);
        if (filed === undefined) {
            throw new ServiceError('NotFound', this.id, `nothing in the queue or history has id "${id}"`, {
                remedy: MISSING_REMEDY
            });
        }
        if (filed.status !== 'Failed') {
            throw new ServiceError('NotFound', this.id, `download ${id} did not fail; only a failed download can be retried`, {
                remedy: `SABnzbd shows it as ${this.#fence(filed.status ?? 'unknown', 'status')}. Take a failed id from get_history.`
            });
        }
        return {
            id,
            title: this.#fence(filed.name ?? '', 'name'),
            where: 'history',
            status: this.#fence(filed.status, 'status'),
            ...(filed.fail_message ? { reason: this.#fence(filed.fail_message, 'fail_message') } : {}),
            downloadId: id,
            method: 'retry'
        };
    }

    /**
     * Re-resolves the target first, so a job that changed since the preview
     * is refused rather than sent the wrong write. The password only ever
     * travels in a POST form body: SABnzbd's API reads POST fields like query
     * ones, and a URL ends up in proxy and access logs.
     */
    async runRetry(id: string, opts: { method: RetryMethod; password?: string }): Promise<RetryOutcome> {
        const target = await this.findRetryTarget(id, { hasPassword: opts.password !== undefined && opts.password !== '' });
        if (target.method !== opts.method) {
            throw new ServiceError('NotFound', this.id, `download ${id} now needs "${target.method}", not "${opts.method}"`, {
                remedy: 'It changed since the preview. Preview retry_download again.'
            });
        }
        return opts.method === 'unlock'
            ? this.#unlock(target, opts.password as string)
            : this.#retry(target, opts.password);
    }

    /**
     * `mode=retry` (3.0.0 `_api_retry` → `retry_job`) removes the history row
     * and queues the job again under a **new** nzo_id, which is what is
     * watched. The password reaches the new job only on the repair path; a
     * job that was fetched from a URL is re-fetched and gets none.
     *
     * A refusal's `error` is dropped when a password was sent, in case
     * SABnzbd ever quotes it back.
     */
    async #retry(target: RetryTarget, password: string | undefined): Promise<RetryOutcome> {
        const body = await this.#http.postForm<{ status?: boolean; nzo_id?: string; error?: string }>('/api', {
            mode: 'retry',
            value: target.id,
            output: 'json',
            ...(password ? { password } : {})
        });

        if (body.status !== true || typeof body.nzo_id !== 'string' || body.nzo_id === '') {
            const fixed = 'SABnzbd gave no new job. Check it is still in history as Failed — take a current id from get_history.';
            throw new ServiceError('UpstreamError', this.id, `SABnzbd refused to retry ${target.id}`, {
                remedy: password || !body.error ? fixed : this.#fence(body.error, 'error')
            });
        }

        const newId = body.nzo_id;
        for (let poll = 0; poll < RETRY_POLLS; poll++) {
            if (poll > 0) await delay(RETRY_POLL_MS);
            const seen = await this.#whereNow(target, newId);
            if (seen !== undefined) return seen;
        }
        throw new ServiceError('UpstreamError', this.id, `SABnzbd accepted the retry, but the new job ${newId} never appeared`, {
            remedy: 'Check get_queue and get_history; SABnzbd may still be fetching the NZB again.'
        });
    }

    /**
     * Renames the job to its own name with the password as `value3`, which
     * 3.0.0's `change_name` hands to `set_final_name_and_scan_password`. With
     * an explicit password that skips `scan_password`, so the name is stored
     * as sent and the `{{password}}` form never enters it.
     *
     * Then a resume: `NzbObject.resume()` sets `encrypted = 2`, and the
     * assembler only checks for encryption while `encrypted == 0`, so the
     * job is not paused again — even if the password is wrong, which surfaces
     * later as an unpack failure in history.
     */
    async #unlock(target: RetryTarget, password: string): Promise<RetryOutcome> {
        // Read again for the raw name: the target only carries it fenced.
        const slot = await this.#queueSlot(target.id);
        if (slot === undefined) {
            throw new ServiceError('NotFound', this.id, `download ${target.id} left the queue`, { remedy: MISSING_REMEDY });
        }
        const renamed = await this.#http.postForm<{ status?: boolean }>('/api', {
            mode: 'queue',
            name: 'rename',
            value: target.id,
            value2: plainName(slot.filename),
            value3: password,
            output: 'json'
        });
        if (renamed.status !== true) {
            throw new ServiceError('UpstreamError', this.id, `SABnzbd refused to set the password on ${target.id}`, {
                remedy: 'Nothing was resumed. Check the job is still in the queue — take a current id from get_queue.'
            });
        }

        const resumed = await this.#http.getAsWrite<{ status?: boolean; error?: string }>(
            `/api?mode=queue&name=resume&value=${encodeURIComponent(target.id)}&output=json`
        );
        if (resumed.status !== true) {
            throw new ServiceError('UpstreamError', this.id, `SABnzbd set the password but refused to resume ${target.id}`, {
                remedy: resumed.error
                    ? this.#fence(resumed.error, 'error')
                    : 'Resume it with pause_downloads, or from SABnzbd\'s own UI.'
            });
        }

        for (let poll = 0; poll < RETRY_POLLS; poll++) {
            if (poll > 0) await delay(RETRY_POLL_MS);
            const seen = await this.#whereNow(target, target.id, true);
            if (seen !== undefined) return seen;
        }
        throw new ServiceError('UpstreamError', this.id, `download ${target.id} is still paused after the resume`, {
            remedy: 'Check get_queue; if it stays paused, resume it from SABnzbd\'s own UI.'
        });
    }

    /**
     * Where `id` stands now, or `undefined` while there is no proof yet. For
     * an unlock, a slot still `Paused` is not proof.
     */
    async #whereNow(target: RetryTarget, id: string, pausedIsPending = false): Promise<RetryOutcome | undefined> {
        const queued = await this.#queueSlot(id);
        if (queued !== undefined) {
            const raw = queued.status ?? 'unknown';
            if (pausedIsPending && raw.toLowerCase() === 'paused') return undefined;
            return {
                target,
                id,
                state: PROCESSING_STATUSES.has(raw.toLowerCase()) ? 'processing' : 'downloading',
                status: this.#fence(raw, 'status')
            };
        }

        const filed = await this.#historySlot(id);
        if (filed === undefined) return undefined;
        const raw = filed.status ?? 'unknown';
        return {
            target,
            id,
            state: 'finished',
            status: this.#fence(raw, 'status'),
            event: raw === 'Failed' ? 'failed' : 'imported'
        };
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
