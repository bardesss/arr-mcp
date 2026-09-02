import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { queryParamKey } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
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
type RawSlot = {
    nzo_id?: string;
    filename?: string;
    status?: string;
    mb?: string;
    mbleft?: string;
    timeleft?: string;
};

const BYTES_PER_MB = 1024 ** 2;

const megabytesToBytes = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * BYTES_PER_MB) : undefined;
};

/** SABnzbd's timeleft is "H:MM:SS", with no leading zero on the hour. */
const parseSabTimeleft = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parts = value.split(':').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return undefined;
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
};

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

export class SabnzbdAdapter
    implements ServiceAdapter, DiskSpaceCapable, QueueCapable, QueueRemoveCapable, PauseCapable, SpeedLimitCapable
{
    readonly type: ServiceId = 'sabnzbd';
    readonly id: string = 'sabnzbd';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('sabnzbd', config, queryParamKey('apikey', config.api_key), fetchImpl);
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

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
