import type { CredentialServiceConfig, ServiceId } from '../config/schema.ts';
import { qbittorrentSession } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
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
    type MagnetAdded,
    type MagnetAddCapable,
    type RemoveQueueOptions,
    type ServiceAdapter,
    type SpeedLimit,
    type SpeedLimitCapable
} from './types.ts';

const API = '/api/v2';

/** Both spellings, for the same reason `TORRENT_STATE` keeps both: 5.0 renamed
 *  the paused states to stopped. */
const PAUSED_STATES = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);

/**
 * Hand-written: qBittorrent publishes no OpenAPI document. Its WebUI API mixes
 * JSON responses with bare-string ones, and takes form fields rather than JSON
 * on writes.
 */
type RawTorrent = {
    hash?: string;
    name?: string;
    state?: string;
    size?: number;
    amount_left?: number;
    eta?: number;
};

type RawMainData = { server_state?: { free_space_on_disk?: number } };
type RawPreferences = { save_path?: string };

/** qBittorrent's own state vocabulary, mapped onto readable words. 5.0 renamed
 *  the paused states to stopped; both spellings are kept so one adapter serves
 *  4.x and 5.x. */
const TORRENT_STATE: Record<string, string> = {
    error: 'error',
    missingFiles: 'missing files',
    uploading: 'seeding',
    forcedUP: 'seeding',
    stalledUP: 'seeding (no peers)',
    pausedUP: 'stopped',
    stoppedUP: 'stopped',
    queuedUP: 'queued to seed',
    checkingUP: 'verifying',
    downloading: 'downloading',
    forcedDL: 'downloading',
    metaDL: 'fetching metadata',
    forcedMetaDL: 'fetching metadata',
    stalledDL: 'stalled',
    pausedDL: 'stopped',
    stoppedDL: 'stopped',
    queuedDL: 'queued',
    checkingDL: 'verifying',
    checkingResumeData: 'verifying',
    allocating: 'allocating',
    moving: 'moving'
};

/** qBittorrent reports this (100 days) rather than a null when it cannot
 *  estimate, so passing it through would promise a finish date it never made. */
const ETA_UNKNOWN = 8_640_000;

export class QbittorrentAdapter
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        QueueCapable,
        QueueRemoveCapable,
        PauseCapable,
        SpeedLimitCapable,
        MagnetAddCapable
{
    readonly type: ServiceId = 'qbittorrent';
    readonly id: string = 'qbittorrent';
    readonly #http: ServiceHttp;

    constructor(config: CredentialServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(
            'qbittorrent',
            config,
            qbittorrentSession({
                url: config.url,
                timeoutMs: config.timeout_ms,
                ...(config.username === undefined ? {} : { username: config.username }),
                ...(config.password === undefined ? {} : { password: config.password }),
                ...(fetchImpl === fetch ? {} : { fetchImpl })
            }),
            fetchImpl
        );
    }

    /** Answered as a bare `v5.0.4`, not JSON. */
    async getVersion(): Promise<string> {
        const version = await this.#http.getText(`${API}/app/version`);
        if (version === '') {
            throw new ServiceError('UpstreamError', this.id, 'app/version returned an empty body');
        }
        return version;
    }

    /**
     * Free space lives only in `sync/maindata`; the path it refers to lives only
     * in `app/preferences`. Reporting free bytes without saying which disk is
     * what makes a two-disk stack unreadable, so this pays for both.
     */
    async getDiskSpace(): Promise<DiskSpace[]> {
        const [main, prefs] = await Promise.all([
            this.#http.get<RawMainData>(`${API}/sync/maindata`),
            this.#http.get<RawPreferences>(`${API}/app/preferences`)
        ]);

        const free = main.server_state?.free_space_on_disk;
        if (typeof free !== 'number') return [];

        return [
            {
                service: this.id,
                path: prefs.save_path ?? 'save_path',
                label: 'qBittorrent save path',
                freeSpace: free
                // No totalSpace: qBittorrent reports free space only.
            }
        ];
    }

    async getQueue(): Promise<QueueItem[]> {
        const torrents = await this.#http.get<RawTorrent[]>(`${API}/torrents/info`);

        return (Array.isArray(torrents) ? torrents : [])
            .filter((t): t is RawTorrent & { hash: string } => typeof t.hash === 'string' && t.hash !== '')
            .map(t => ({
                service: this.id,
                id: t.hash,
                title: fenceText(t.name ?? '', { service: this.id, field: 'name' }),
                status: TORRENT_STATE[t.state ?? ''] ?? 'unknown',
                protocol: 'torrent',
                ...(t.size === undefined ? {} : { sizeBytes: t.size }),
                ...(t.amount_left === undefined ? {} : { remainingBytes: t.amount_left }),
                ...(t.eta === undefined || t.eta <= 0 || t.eta >= ETA_UNKNOWN ? {} : { etaSeconds: t.eta })
            }));
    }

    /** No blocklist of grabbed releases — that is an *arr concept. */
    readonly supportsBlocklist = false;

    /**
     * `deleteFiles` is the destructive half and maps to `removeFromClient`.
     *
     * The existence check is not redundant: `torrents/delete` answers 200 for a
     * hash it has never seen, so without it a typo'd id reports a successful
     * removal of nothing.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        const hash = id.trim().toLowerCase();
        const existing = await this.#http.get<RawTorrent[]>(
            `${API}/torrents/info?hashes=${encodeURIComponent(hash)}`
        );
        if (!Array.isArray(existing) || existing.length === 0) {
            throw new ServiceError('NotFound', this.id, `no torrent with hash "${id}"`, {
                remedy: 'qBittorrent torrent ids are info hashes. Take one from get_queue.'
            });
        }

        await this.#http.postForm(
            `${API}/torrents/delete`,
            { hashes: hash, deleteFiles: String(opts.removeFromClient) },
            true
        );
    }

    /**
     * qBittorrent has no client-wide paused flag, so this is the same
     * every-torrent-is-stopped reading Transmission gets — and it counts both
     * spellings, because 5.0 renamed the paused states to stopped and this
     * adapter serves 4.x and 5.x alike, exactly as `TORRENT_STATE` already
     * does.
     *
     * **Spec-derived, like every pause path here.** There is no qBittorrent on
     * the stack these adapters were probed against, so nothing below was
     * confirmed against a live instance.
     */
    async readPauseState(id?: string): Promise<PauseState> {
        const torrents = await this.#torrents(id);
        const stopped = torrents.filter(t => PAUSED_STATES.has(t.state ?? '')).length;

        if (id !== undefined) return { paused: torrents.length > 0 && stopped === torrents.length, scope: `torrent ${id}` };
        return {
            paused: torrents.length > 0 && stopped === torrents.length,
            scope: torrents.length === 1 ? '1 torrent' : `${torrents.length} torrents`
        };
    }

    /**
     * v5 renamed `pause`/`resume` to `stop`/`start`. Both are attempted — the
     * new verb first, the old one only if that 404s — because this adapter has
     * no version gate and guessing wrong would silently do nothing.
     */
    async setPaused(paused: boolean, id?: string): Promise<void> {
        if (id !== undefined && (await this.#torrents(id)).length === 0) {
            throw new ServiceError('NotFound', this.id, `no torrent with hash "${id}"`, {
                remedy: 'qBittorrent torrent ids are info hashes. Take one from get_queue.'
            });
        }

        const hashes = id === undefined ? 'all' : id.trim().toLowerCase();
        const [modern, legacy] = paused ? ['stop', 'pause'] : ['start', 'resume'];

        try {
            await this.#http.postForm(`${API}/torrents/${modern}`, { hashes }, true);
        } catch (err) {
            if (!(err instanceof ServiceError) || err.kind !== 'NotFound') throw err;
            await this.#http.postForm(`${API}/torrents/${legacy}`, { hashes }, true);
        }
    }

    /**
     * qBittorrent speaks **bytes per second** here, where this boundary
     * speaks KB/s. `0` means unlimited, both ways.
     *
     * Spec-derived, like the pause paths above: there is no qBittorrent on
     * the stack these adapters were probed against.
     */
    async readSpeedLimit(): Promise<SpeedLimit> {
        const raw = await this.#http.getText(`${API}/transfer/downloadLimit`);
        const bytes = Number(raw.trim());
        if (!Number.isFinite(bytes) || bytes <= 0) return { service: this.id };
        return { service: this.id, kbps: Math.round(bytes / 1024) };
    }

    async setSpeedLimit(kbps: number | undefined): Promise<void> {
        const bytes = kbps === undefined || kbps <= 0 ? 0 : Math.round(kbps) * 1024;
        await this.#http.postForm(`${API}/transfer/setDownloadLimit`, { limit: String(bytes) }, true);
    }

    /**
     * qBittorrent takes the link as a form field and answers a bare `Ok.`
     * whether or not it already had the torrent, so a duplicate is checked
     * for beforehand rather than inferred from the response.
     *
     * Spec-derived, like the pause paths above.
     */
    async addMagnet(uri: string): Promise<MagnetAdded> {
        const hash = /xt=urn:btih:([0-9a-zA-Z]+)/.exec(uri)?.[1]?.toLowerCase();
        const existing =
            hash === undefined
                ? []
                : await this.#http.get<RawTorrent[]>(`${API}/torrents/info?hashes=${encodeURIComponent(hash)}`);

        await this.#http.postForm(`${API}/torrents/add`, { urls: uri }, true);

        return {
            ...(hash === undefined ? {} : { id: hash }),
            duplicate: Array.isArray(existing) && existing.length > 0
        };
    }

    async #torrents(id?: string): Promise<RawTorrent[]> {
        const path =
            id === undefined
                ? `${API}/torrents/info`
                : `${API}/torrents/info?hashes=${encodeURIComponent(id.trim().toLowerCase())}`;
        const torrents = await this.#http.get<RawTorrent[]>(path);
        return Array.isArray(torrents) ? torrents : [];
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
