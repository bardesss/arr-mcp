import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { qbittorrentSession } from '../core/auth.ts';
import { SHORT_READ_TTL_MS, cached } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { hostPort } from '../core/hostPort.ts';
import type { TorrentFacts } from '../core/cleanuparrRules.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ClientSeedLimits,
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
    type SeedingState,
    type SeedLimitsCapable,
    type ServiceAdapter,
    type SpeedLimit,
    type SpeedLimitCapable,
    type TorrentEndpoint,
    PAUSE_MARK
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
    /** -1 when infinite. */
    ratio?: number;
    seeding_time?: number;
    /** -2 follows the default, -1 is no limit. */
    ratio_limit?: number;
    seeding_time_limit?: number;
    /** Effective limits after torrent, category and global; -1 is none.
     *  `max_seeding_time` is minutes. */
    max_ratio?: number;
    max_seeding_time?: number;
    /** 5.x only, and null until metadata arrives. */
    private?: boolean | null;
    category?: string;
    tags?: string;
    tracker?: string;
    save_path?: string;
};

type RawMainData = { server_state?: { free_space_on_disk?: number } };
type RawPreferences = {
    save_path?: string;
    max_ratio_enabled?: boolean;
    max_ratio?: number;
    max_seeding_time_enabled?: boolean;
    /** Minutes. */
    max_seeding_time?: number;
    max_ratio_act?: number;
};

/** `ShareLimitAction` in 5.x, `MaxRatioAction` in 4.x: same numbers. */
const SHARE_LIMIT_ACTION: Record<number, ClientSeedLimits['action']> = {
    0: 'stop',
    1: 'remove',
    2: 'super seeding',
    3: 'remove with content'
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * A magnet's `btih` is 40 hex characters or, per BEP 9, 32 base32 ones.
 * `torrents/info?hashes=` takes hex only, so a base32 hash never matches and
 * the duplicate check silently passes. A 32-character value with a character
 * outside the base32 alphabet is left as given.
 */
export function btihToHex(btih: string): string {
    const lower = btih.toLowerCase();
    if (lower.length !== 32 || [...lower].some(c => !BASE32.includes(c))) return lower;
    const bits = [...lower].map(c => BASE32.indexOf(c).toString(2).padStart(5, '0')).join('');
    return Array.from({ length: 40 }, (_, i) => parseInt(bits.slice(i * 4, i * 4 + 4), 2).toString(16)).join('');
}

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

const DEFAULT_LIMIT = -2;

/** Mirrors `SessionImpl::processTorrentShareLimits`: ratio first, then
 *  seeding time in whole minutes. */
function seedingOf(t: RawTorrent): { seeding?: SeedingState } {
    if (t.amount_left !== 0) return {};

    const ratio = t.ratio === -1 ? Infinity : t.ratio;
    const ratioLimit = t.max_ratio !== undefined && t.max_ratio >= 0 ? t.max_ratio : undefined;
    const minutesLimit = t.max_seeding_time !== undefined && t.max_seeding_time >= 0 ? t.max_seeding_time : undefined;
    const overridden =
        (t.ratio_limit ?? DEFAULT_LIMIT) !== DEFAULT_LIMIT || (t.seeding_time_limit ?? DEFAULT_LIMIT) !== DEFAULT_LIMIT;

    const overRatio = ratioLimit !== undefined && ratio !== undefined && ratio >= ratioLimit;
    const overTime =
        minutesLimit !== undefined && t.seeding_time !== undefined && Math.floor(t.seeding_time / 60) >= minutesLimit;

    return {
        seeding: {
            ...(ratio === undefined || ratio === Infinity ? {} : { ratio }),
            ...(t.seeding_time === undefined ? {} : { seedingSeconds: t.seeding_time }),
            ...(ratioLimit === undefined ? {} : { ratioLimit }),
            ...(minutesLimit === undefined ? {} : { seedingLimitSeconds: minutesLimit * 60 }),
            ...(overridden ? { ownLimit: true as const } : {}),
            ...(overRatio || overTime ? { overLimit: true as const } : {}),
            ...(t.state === 'forcedUP' ? { forced: true as const } : {})
        }
    };
}

const STOPPED = new Set(['pausedUP', 'stoppedUP', 'pausedDL', 'stoppedDL']);

/** qBittorrent sends tags as one comma-separated string. */
const tagsOf = (t: RawTorrent): string[] => (t.tags ?? '').split(',').map(s => s.trim()).filter(s => s !== '');

const isMarked = (t: RawTorrent): boolean => tagsOf(t).includes(PAUSE_MARK);

/** Only the active tracker: torrents/info carries one. Cleanuparr checks every tracker. */
function torrentOf(t: RawTorrent & { hash: string }): { torrent: TorrentFacts } {
    let trackerDomains: string[];
    try {
        trackerDomains = t.tracker ? [new URL(t.tracker).hostname.toLowerCase()] : [];
    } catch {
        trackerDomains = [];
    }
    return {
        torrent: {
            hash: t.hash.toLowerCase(),
            category: t.category ?? '',
            tags: tagsOf(t),
            trackerDomains,
            ...(t.save_path ? { savePath: t.save_path } : {}),
            ...(typeof t.private === 'boolean' ? { private: t.private } : {}),
            stopped: STOPPED.has(t.state ?? ''),
            seeding: t.amount_left === 0
        }
    };
}

/**
 * Whether `torrents/add` took the torrent. Up to 5.1 it answers 200 with
 * `Ok.` or `Fails.`, so the status line says nothing; later builds answer
 * empty or with JSON counts.
 */
function addAccepted(body: string): boolean {
    if (body === '' || body === 'Ok.') return true;
    try {
        const counts = JSON.parse(body) as { success_count?: unknown; pending_count?: unknown; failure_count?: unknown };
        if (typeof counts !== 'object' || counts === null) return false;
        const n = (v: unknown) => (typeof v === 'number' ? v : 0);
        return n(counts.success_count) + n(counts.pending_count) > 0 || n(counts.failure_count) === 0;
    } catch {
        return false;
    }
}

export class QbittorrentAdapter
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        QueueCapable,
        QueueRemoveCapable,
        PauseCapable,
        SpeedLimitCapable,
        MagnetAddCapable,
        SeedLimitsCapable,
        TorrentEndpoint
{
    readonly type: ServiceId = 'qbittorrent';
    readonly endpoint: string;
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;
    /** Shared by the disk check and the seed limits of one get_stack_health pass; this adapter never writes preferences. */
    readonly #preferences = cached(SHORT_READ_TTL_MS, () => this.#http.get<RawPreferences>(`${API}/app/preferences`));

    constructor(config: ConfigByService['qbittorrent'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.endpoint = hostPort(config.url) ?? config.url;
        this.id = instanceId('qbittorrent', config.name);
        this.#http = new ServiceHttp(
            this.id,
            config,
            qbittorrentSession({
                id: this.id,
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
            this.#preferences()
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
                ...(t.eta === undefined || t.eta <= 0 || t.eta >= ETA_UNKNOWN ? {} : { etaSeconds: t.eta }),
                ...(typeof t.private === 'boolean' ? { private: t.private } : {}),
                ...seedingOf(t),
                ...torrentOf(t)
            }));
    }

    /** Global defaults only. Per-category limits (5.2+) show up per torrent
     *  in `getQueue`, as its effective limit. */
    async getSeedLimits(): Promise<ClientSeedLimits> {
        const prefs = await this.#preferences();
        const ratio = prefs.max_ratio_enabled === true ? prefs.max_ratio : undefined;
        const minutes = prefs.max_seeding_time_enabled === true ? prefs.max_seeding_time : undefined;

        return {
            service: this.id,
            ...(ratio === undefined || ratio < 0 ? {} : { ratioLimit: ratio }),
            ...(minutes === undefined || minutes < 0 ? {} : { seedingLimitSeconds: minutes * 60 }),
            action: SHARE_LIMIT_ACTION[prefs.max_ratio_act ?? -1] ?? 'unknown'
        };
    }

    /** No blocklist of grabbed releases: that is an *arr concept. */
    readonly supportsBlocklist = false;

    /**
     * `deleteFiles` is the destructive half and maps to `removeFromClient`.
     *
     * The existence check is not redundant: `torrents/delete` answers 200 for a
     * hash it has never seen, so without it a typo'd id reports a successful
     * removal of nothing.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        const hash = this.#hash(id);
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
     * qBittorrent has no client-wide paused flag. A whole-client pause stops
     * the running torrents and tags them, and the client reads as paused while
     * any torrent carries the tag; stopped torrents without it were stopped by
     * something else and resume leaves them be. Both spellings of stopped
     * count, because 5.0 renamed the paused states and this adapter serves 4.x
     * and 5.x alike, exactly as `TORRENT_STATE` already does.
     *
     * **Spec-derived, like every pause path here.** There is no qBittorrent on
     * the stack these adapters were probed against, so nothing below was
     * confirmed against a live instance.
     */
    async readPauseState(id?: string): Promise<PauseState> {
        if (id !== undefined) {
            const [torrent] = await this.#torrents(id);
            if (torrent === undefined) throw this.#notFound(id);
            return { paused: PAUSED_STATES.has(torrent.state ?? ''), scope: `torrent ${id}` };
        }

        const torrents = await this.#tagged();
        const running = torrents.filter(t => !PAUSED_STATES.has(t.state ?? '')).length;
        const marked = torrents.filter(isMarked).length;
        return {
            paused: marked > 0,
            scope: torrents.length === 1 ? '1 torrent' : `${torrents.length} torrents`,
            torrents: { running, stopped: torrents.length - running, marked, mark: `tag ${PAUSE_MARK}` }
        };
    }

    async setPaused(paused: boolean, id?: string): Promise<void> {
        if (id !== undefined) {
            const [torrent] = await this.#torrents(id);
            if (torrent === undefined) throw this.#notFound(id);
            const hash = this.#hash(id);
            await this.#verb(paused, hash);
            // Started by hand, so a later whole-client resume has nothing to do for it.
            if (!paused && isMarked(torrent)) await this.#tag(false, hash);
            return;
        }

        const torrents = await this.#tagged();
        if (paused) {
            const running = torrents.filter(t => !PAUSED_STATES.has(t.state ?? '')).map(t => t.hash);
            if (running.length === 0) return;
            // Tagged before they stop: a stop that fails half-way then leaves
            // running torrents tagged, which resume starts harmlessly, rather
            // than stopped ones resume does not know about.
            await this.#tag(true, running.join('|'));
            await this.#verb(true, running.join('|'));
            return;
        }

        const held = torrents.filter(isMarked).map(t => t.hash);
        if (held.length === 0) return;
        await this.#verb(false, held.join('|'));
        await this.#tag(false, held.join('|'));
    }

    /**
     * v5 renamed `pause`/`resume` to `stop`/`start`. Both are attempted: the
     * new verb first, the old one only if that 404s, because this adapter has
     * no version gate and guessing wrong would silently do nothing. `hashes`
     * is never `all`: that would start torrents no pause stopped.
     */
    async #verb(paused: boolean, hashes: string): Promise<void> {
        const [modern, legacy] = paused ? ['stop', 'pause'] : ['start', 'resume'];
        try {
            await this.#http.postForm(`${API}/torrents/${modern}`, { hashes }, true);
        } catch (err) {
            if (!(err instanceof ServiceError) || err.kind !== 'NotFound') throw err;
            await this.#http.postForm(`${API}/torrents/${legacy}`, { hashes }, true);
        }
    }

    /** `addTags` creates the tag if it does not exist yet. */
    async #tag(mark: boolean, hashes: string): Promise<void> {
        try {
            await this.#http.postForm(`${API}/torrents/${mark ? 'addTags' : 'removeTags'}`, { hashes, tags: PAUSE_MARK }, true);
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'NotFound') throw this.#noTags();
            throw err;
        }
    }

    /** Every torrent, refused on a qBittorrent without tags (before 4.2, whose
     *  rows carry no `tags` field): a whole-client pause with nowhere to record
     *  what it stopped could not be undone exactly. */
    async #tagged(): Promise<(RawTorrent & { hash: string })[]> {
        const torrents = (await this.#torrents()).filter(
            (t): t is RawTorrent & { hash: string } => typeof t.hash === 'string' && t.hash !== ''
        );
        if (torrents.some(t => t.tags === undefined)) throw this.#noTags();
        return torrents;
    }

    #noTags(): ServiceError {
        return new ServiceError(
            'VersionUnsupported',
            this.id,
            'this qBittorrent has no torrent tags, so a whole-client pause could not record which torrents it stopped',
            { remedy: 'Pause or resume torrents one at a time with `id`, or upgrade to qBittorrent 4.2 or later.' }
        );
    }

    #notFound(id: string): ServiceError {
        return new ServiceError('NotFound', this.id, `no torrent with hash "${id}"`, {
            remedy: 'qBittorrent torrent ids are info hashes. Take one from get_queue.'
        });
    }

    /**
     * qBittorrent speaks **bytes per second** here, where this boundary
     * speaks KiB/s. `0` means unlimited, both ways.
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
        const btih = /xt=urn:btih:([0-9a-zA-Z]+)/.exec(uri)?.[1];
        const hash = btih === undefined ? undefined : btihToHex(btih);
        const existing =
            hash === undefined
                ? []
                : await this.#http.get<RawTorrent[]>(`${API}/torrents/info?hashes=${encodeURIComponent(hash)}`);

        const duplicate = Array.isArray(existing) && existing.length > 0;
        const answer = await this.#http.postFormText(`${API}/torrents/add`, { urls: uri });
        // A duplicate is already known, and older builds answer one with
        // `Fails.` too, so the body only decides a new torrent.
        if (!duplicate && !addAccepted(answer)) {
            throw new ServiceError(
                'UpstreamError',
                this.id,
                `qBittorrent did not add the torrent: it answered ${fenceText(answer, { service: this.id, field: 'add' })}`,
                { remedy: 'Check the magnet link, and that qBittorrent has finished starting up, then try again.' }
            );
        }

        return {
            ...(hash === undefined ? {} : { id: hash }),
            duplicate
        };
    }

    /** `hashes` is `|`-separated with `all` as a keyword, so only one bare hash may reach it. */
    #hash(id: string): string {
        const hash = id.trim().toLowerCase();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a torrent info hash`, {
                remedy: 'qBittorrent torrent ids are 40 or 64 hex characters. Take one from get_queue.'
            });
        }
        return hash;
    }

    async #torrents(id?: string): Promise<RawTorrent[]> {
        const path =
            id === undefined
                ? `${API}/torrents/info`
                : `${API}/torrents/info?hashes=${encodeURIComponent(this.#hash(id))}`;
        const torrents = await this.#http.get<RawTorrent[]>(path);
        return Array.isArray(torrents) ? torrents : [];
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
