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
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RemoveQueueOptions,
    type ServiceAdapter
} from './types.ts';

const API = '/api/v2';

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

export class QbittorrentAdapter implements ServiceAdapter, DiskSpaceCapable, QueueCapable, QueueRemoveCapable {
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

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
