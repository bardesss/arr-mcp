import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { transmissionRpc } from '../core/auth.ts';
import { SHORT_READ_TTL_MS, cached } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { hostPort } from '../core/hostPort.ts';
import type { TorrentFacts } from '../core/cleanuparrRules.ts';
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
    type RemoveQueueOptions,
    type SeedingState,
    type SeedLimitsCapable,
    type MagnetAdded,
    type MagnetAddCapable,
    type ServiceAdapter,
    type SpeedLimit,
    type SpeedLimitCapable,
    type TorrentEndpoint,
    PAUSE_MARK
} from './types.ts';

const RPC_PATH = '/transmission/rpc';

type RpcResponse<T> = { result?: string; arguments?: T };
type RawSession = {
    version?: string;
    'download-dir'?: string;
    'download-dir-free-space'?: number;
    /** In the daemon's own speed unit (`units.speed-bytes`), and only applied when the `-enabled` flag is set. */
    'speed-limit-down'?: number;
    'speed-limit-down-enabled'?: boolean;
    /** Turtle mode: while on, `alt-speed-down` is the cap and the normal limit waits. */
    'alt-speed-down'?: number;
    'alt-speed-enabled'?: boolean;
    'rpc-version'?: number;
    seedRatioLimit?: number;
    seedRatioLimited?: boolean;
    units?: { 'speed-bytes'?: number };
};

/** Bytes per "kB" the daemon counts in; 1000 unless it says otherwise. */
const speedBytes = (s: RawSession): number => s.units?.['speed-bytes'] ?? 1000;

/**
 * Hand-written: Transmission speaks POST-only JSON-RPC against a single
 * endpoint, with an `X-Transmission-Session-Id` handshake that the auth
 * strategy owns. Confirmed against a live 4.1.3.
 */
type RawTorrent = {
    id?: number;
    name?: string;
    status?: number;
    totalSize?: number;
    leftUntilDone?: number;
    eta?: number;
    errorString?: string;
    /** -1 not known yet, -2 infinite. */
    uploadRatio?: number;
    secondsSeeding?: number;
    /** 0 follows the session, 1 uses `seedRatioLimit`, 2 is unlimited. */
    seedRatioMode?: number;
    seedRatioLimit?: number;
    isPrivate?: boolean;
    hashString?: string;
    downloadDir?: string;
    labels?: string[];
    trackers?: Array<{ announce?: string }>;
};

const QUEUE_FIELDS = [
    'id',
    'name',
    'status',
    'totalSize',
    'leftUntilDone',
    'eta',
    'errorString',
    'uploadRatio',
    'secondsSeeding',
    'seedRatioMode',
    'seedRatioLimit',
    'isPrivate',
    'hashString',
    'downloadDir',
    'labels',
    'trackers'
];

/** Transmission has a ratio limit only; its idle limit is about inactivity,
 *  not time spent seeding. */
function seedingOf(t: RawTorrent, session: RawSession): { seeding?: SeedingState } {
    if (t.leftUntilDone !== 0) return {};

    const ratio = t.uploadRatio === -2 ? Infinity : t.uploadRatio === -1 ? undefined : t.uploadRatio;
    const ratioLimit =
        t.seedRatioMode === 1
            ? t.seedRatioLimit
            : t.seedRatioMode === 2 || session.seedRatioLimited !== true
              ? undefined
              : session.seedRatioLimit;

    return {
        seeding: {
            ...(ratio === undefined || ratio === Infinity ? {} : { ratio }),
            ...(t.secondsSeeding === undefined ? {} : { seedingSeconds: t.secondsSeeding }),
            ...(ratioLimit === undefined ? {} : { ratioLimit }),
            ...(t.seedRatioMode === 1 || t.seedRatioMode === 2 ? { ownLimit: true as const } : {}),
            ...(ratioLimit !== undefined && ratio !== undefined && ratio >= ratioLimit ? { overLimit: true as const } : {})
        }
    };
}

/** Cleanuparr takes a Transmission torrent's category from the last folder of its download dir. */
function torrentOf(t: RawTorrent): { torrent?: TorrentFacts } {
    if (t.hashString === undefined) return {};
    const category = (t.downloadDir ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const trackerDomains = (t.trackers ?? []).flatMap(tr => {
        try {
            return tr.announce === undefined ? [] : [new URL(tr.announce).hostname.toLowerCase()];
        } catch {
            return [];
        }
    });
    return {
        torrent: {
            hash: t.hashString.toLowerCase(),
            category,
            tags: t.labels ?? [],
            trackerDomains,
            ...(t.downloadDir ? { savePath: t.downloadDir } : {}),
            ...(typeof t.isPrivate === 'boolean' ? { private: t.isPrivate } : {}),
            stopped: t.status === 0,
            seeding: t.leftUntilDone === 0 && (t.status === 5 || t.status === 6 || t.status === 0)
        }
    };
}

/** Transmission reports status as an integer; these are the RPC spec's values. */
const TORRENT_STATUS: Record<number, string> = {
    0: 'stopped',
    1: 'queued to verify',
    2: 'verifying',
    3: 'queued',
    4: 'downloading',
    5: 'queued to seed',
    6: 'seeding'
};

/** A failed RPC's `result` is free text, often an error string from a tracker or the filesystem. */
const resultOf = (service: string, result: string | undefined): string =>
    result === undefined ? 'no result field' : fenceText(result, { service, field: 'result' });

const ID_REMEDY = 'Transmission torrent ids are info hashes. Take one from get_queue.';

/** Labels arrived in RPC version 16, Transmission 3.0. */
const LABELS_RPC = 16;

type PauseRow = { id?: number; hashString?: string; status?: number; labels?: string[] };

/** The hash where there is one: unlike the integer id it survives a daemon restart. */
const refOf = (t: PauseRow): string | number => t.hashString?.toLowerCase() ?? (t.id as number);

const isMarked = (t: PauseRow): boolean => (t.labels ?? []).includes(PAUSE_MARK);

export class TransmissionAdapter
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
    readonly type: ServiceId = 'transmission';
    readonly endpoint: string;
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;
    /** One session-get serves the disk check, seed limits and speed limit of a get_stack_health pass. */
    readonly #sessionRead = cached(SHORT_READ_TTL_MS, () => this.#readSession());

    constructor(config: ConfigByService['transmission'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.endpoint = hostPort(config.url) ?? config.url;
        this.id = instanceId('transmission', config.name);
        this.#http = new ServiceHttp(
            this.id,
            config,
            transmissionRpc({
                ...(config.username === undefined ? {} : { username: config.username }),
                ...(config.password === undefined ? {} : { password: config.password })
            }),
            fetchImpl
        );
    }

    async getVersion(): Promise<string> {
        const session = await this.#session();
        if (!session.version) {
            throw new ServiceError('UpstreamError', this.id, 'session-get returned no version field');
        }
        return session.version;
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        const session = await this.#session();
        const free = session['download-dir-free-space'];
        if (typeof free !== 'number') return [];

        const path = session['download-dir'] ?? 'download-dir';
        return [
            {
                service: this.id,
                path,
                label: 'Transmission download-dir',
                freeSpace: free
                // No totalSpace: Transmission reports free space only.
            }
        ];
    }

    async getQueue(): Promise<QueueItem[]> {
        // The session holds the default ratio limit a torrent in mode 0 follows.
        const [body, session] = await Promise.all([
            this.#http.post<RpcResponse<{ torrents?: RawTorrent[] }>>(RPC_PATH, {
                method: 'torrent-get',
                arguments: { fields: QUEUE_FIELDS }
            }),
            this.#session()
        ]);
        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `torrent-get failed: ${resultOf(this.id, body.result)}`);
        }

        return (body.arguments?.torrents ?? [])
            .filter(t => typeof t.hashString === 'string' || typeof t.id === 'number')
            .map(t => ({
                service: this.id,
                // The hash, not the RPC `id`: Transmission renumbers torrents
                // when the daemon restarts, so an integer read before one can
                // name a different torrent after it.
                id: t.hashString?.toLowerCase() ?? String(t.id),
                title: fenceText(t.name ?? '', { service: this.id, field: 'name' }),
                status: TORRENT_STATUS[t.status ?? -1] ?? 'unknown',
                protocol: 'torrent',
                ...(t.totalSize === undefined ? {} : { sizeBytes: t.totalSize }),
                ...(t.leftUntilDone === undefined ? {} : { remainingBytes: t.leftUntilDone }),
                // Transmission uses negative eta values to mean "unknown".
                ...(t.eta === undefined || t.eta < 0 ? {} : { etaSeconds: t.eta }),
                ...(t.errorString
                    ? { errorMessage: fenceText(t.errorString, { service: this.id, field: 'errorString' }) }
                    : {}),
                ...(typeof t.isPrivate === 'boolean' ? { private: t.isPrivate } : {}),
                ...seedingOf(t, session),
                ...torrentOf(t)
            }));
    }

    /** Transmission has no seeding-time limit, and always stops a torrent
     *  that reaches its ratio. */
    async getSeedLimits(): Promise<ClientSeedLimits> {
        const session = await this.#session();
        const ratio = session.seedRatioLimited === true ? session.seedRatioLimit : undefined;
        return { service: this.id, ...(ratio === undefined ? {} : { ratioLimit: ratio }), action: 'stop' };
    }

    /** Transmission has no blocklist of grabbed releases: that is an *arr concept. */
    readonly supportsBlocklist = false;

    /**
     * `delete-local-data` is the destructive half, and it maps to
     * `removeFromClient`: leaving it false removes the torrent but keeps what
     * has already downloaded, which is the recoverable choice.
     *
     * Like every Transmission call, a failure arrives as HTTP 200 with a
     * `result` other than "success", so the body is what says whether the
     * torrent was actually removed.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        // Not redundant: `torrent-remove` ignores an id it has never seen and
        // still answers "success", so without this a stale id reported a
        // successful removal of nothing. qBittorrent's adapter pre-checks for
        // the same reason, and SABnzbd reads its own status flag.
        const [torrent] = await this.#torrents(id);
        if (torrent === undefined) throw this.#notFound(id);

        await this.#rpc('torrent-remove', { ids: [this.#torrentRef(id)], 'delete-local-data': opts.removeFromClient });
    }

    /**
     * "Stopped" is Transmission's word for paused, and it is per-torrent:
     * there is no client-wide flag. A whole-client pause therefore stops the
     * running torrents and labels them, and the client reads as paused while
     * any torrent carries that label. Stopped torrents without it were stopped
     * by something else (a ratio limit, the user) and resume leaves them be.
     */
    async readPauseState(id?: string): Promise<PauseState> {
        if (id !== undefined) {
            const [torrent] = await this.#torrents(id);
            if (torrent === undefined) throw this.#notFound(id);
            return { paused: torrent.status === 0, scope: `torrent ${id}` };
        }

        const torrents = await this.#labelled();
        const running = torrents.filter(t => t.status !== 0).length;
        const marked = torrents.filter(isMarked).length;
        return {
            paused: marked > 0,
            scope: torrents.length === 1 ? '1 torrent' : `${torrents.length} torrents`,
            torrents: { running, stopped: torrents.length - running, marked, mark: `label ${PAUSE_MARK}` }
        };
    }

    async setPaused(paused: boolean, id?: string): Promise<void> {
        if (id !== undefined) {
            // The same pre-check `removeQueueItem` makes, for the same reason:
            // probed live, `torrent-stop` for an id Transmission has never seen
            // answers `result: "success"` and does nothing.
            const [torrent] = await this.#torrents(id);
            if (torrent === undefined) throw this.#notFound(id);
            await this.#rpc(paused ? 'torrent-stop' : 'torrent-start', { ids: [this.#torrentRef(id)] });
            // Started by hand, so a later whole-client resume has nothing to do for it.
            if (!paused && isMarked(torrent)) await this.#relabel([torrent], false);
            return;
        }

        const torrents = await this.#labelled();
        if (paused) {
            const running = torrents.filter(t => t.status !== 0);
            if (running.length === 0) return;
            // Labelled before they stop: a stop that fails half-way then leaves
            // running torrents labelled, which resume starts harmlessly, rather
            // than stopped ones resume does not know about.
            await this.#relabel(running.filter(t => !isMarked(t)), true);
            await this.#rpc('torrent-stop', { ids: running.map(refOf) });
            return;
        }

        const held = torrents.filter(isMarked);
        if (held.length === 0) return;
        await this.#rpc('torrent-start', { ids: held.map(refOf) });
        await this.#relabel(held, false);
    }

    /**
     * Transmission counts speeds in its own unit (`units.speed-bytes`, 1000
     * by default), so they are converted to the KiB/s this boundary speaks.
     * The enabled flag is what actually decides whether the number is applied,
     * unless turtle mode is on: its own cap then applies instead.
     */
    async readSpeedLimit(): Promise<SpeedLimit> {
        const session = await this.#session();
        const alt = session['alt-speed-down'];
        if (session['alt-speed-enabled'] === true && typeof alt === 'number') {
            return { service: this.id, kbps: Math.round((alt * speedBytes(session)) / 1024), alternative: true };
        }
        const limit = session['speed-limit-down'];
        if (session['speed-limit-down-enabled'] !== true || typeof limit !== 'number' || limit <= 0) {
            return { service: this.id };
        }
        return { service: this.id, kbps: Math.round((limit * speedBytes(session)) / 1024) };
    }

    async setSpeedLimit(kbps: number | undefined): Promise<void> {
        const clearing = kbps === undefined || kbps <= 0;
        const unit = clearing ? 1000 : speedBytes(await this.#session());
        const body = await this.#http.post<RpcResponse<unknown>>(RPC_PATH, {
            method: 'session-set',
            arguments: {
                'speed-limit-down-enabled': !clearing,
                // Sent even when clearing: Transmission keeps the number
                // behind the flag, and leaving a stale cap there is how a
                // later "pause and resume" comes back throttled.
                'speed-limit-down': clearing ? 0 : Math.round((kbps * 1024) / unit)
            }
        });

        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `session-set failed: ${resultOf(this.id, body.result)}`);
        }
        this.#sessionRead.clear();
    }

    /**
     * `torrent-add` answers with `torrent-added` for a new torrent and
     * `torrent-duplicate` for one the client already has: a 200 either way,
     * so the arguments are what say which happened. A duplicate is reported,
     * not thrown: it is the state the caller asked for.
     */
    async addMagnet(uri: string): Promise<MagnetAdded> {
        const body = await this.#http.post<
            RpcResponse<{
                'torrent-added'?: { id?: number; name?: string; hashString?: string };
                'torrent-duplicate'?: { id?: number; name?: string; hashString?: string };
            }>
        >(RPC_PATH, { method: 'torrent-add', arguments: { filename: uri } });

        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `torrent-add failed: ${resultOf(this.id, body.result)}`, {
                remedy: 'Transmission refused the magnet. Check the link is complete and the client can reach a tracker.'
            });
        }

        const added = body.arguments?.['torrent-added'];
        const duplicate = body.arguments?.['torrent-duplicate'];
        const row = added ?? duplicate;

        const id = row?.hashString?.toLowerCase() ?? (row?.id === undefined ? undefined : String(row.id));
        return {
            ...(id === undefined ? {} : { id }),
            ...(row?.name === undefined
                ? {}
                : { title: fenceText(row.name, { service: this.id, field: 'name' }) }),
            duplicate: added === undefined && duplicate !== undefined
        };
    }

    /**
     * The info hash get_queue reports, or the RPC's integer id that
     * `transmission-remote -l` shows. Digits only: `Number` alone would take
     * `""` as 0 and `0x1f` or `1e1` as ids.
     */
    #torrentRef(id: string): string | number {
        const trimmed = id.trim();
        if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
        if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed);
        throw new ServiceError('NotFound', this.id, `"${id}" is not a Transmission torrent id`, { remedy: ID_REMEDY });
    }

    #notFound(id: string): ServiceError {
        return new ServiceError('NotFound', this.id, `no torrent with id "${id}"`, { remedy: ID_REMEDY });
    }

    /** What "is it stopped" and the pause label need, without the whole
     *  queue payload `getQueue` reads. */
    async #torrents(id?: string): Promise<PauseRow[]> {
        const body = await this.#rpc<{ torrents?: PauseRow[] }>('torrent-get', {
            ...(id === undefined ? {} : { ids: [this.#torrentRef(id)] }),
            fields: ['id', 'hashString', 'status', 'labels']
        });
        return (body?.torrents ?? []).filter(t => typeof t.hashString === 'string' || typeof t.id === 'number');
    }

    /** Every torrent, refused on a daemon without labels: a whole-client pause
     *  with nowhere to record what it stopped could not be undone exactly. */
    async #labelled(): Promise<PauseRow[]> {
        const session = await this.#session();
        const rpc = session['rpc-version'];
        if (rpc !== undefined && rpc < LABELS_RPC) {
            throw new ServiceError(
                'VersionUnsupported',
                this.id,
                `Transmission${session.version === undefined ? '' : ` ${session.version}`} (RPC ${rpc}) has no torrent labels, so a whole-client pause could not record which torrents it stopped`,
                { remedy: 'Pause or resume torrents one at a time with `id`, or upgrade to Transmission 3.0 or later.' }
            );
        }
        return this.#torrents();
    }

    /** `torrent-set labels` replaces the whole list, so torrents are grouped by
     *  the list they end up with: one call per distinct set, not per torrent. */
    async #relabel(torrents: PauseRow[], mark: boolean): Promise<void> {
        const groups = new Map<string, { labels: string[]; ids: (string | number)[] }>();
        for (const t of torrents) {
            const rest = (t.labels ?? []).filter(l => l !== PAUSE_MARK);
            const labels = mark ? [...rest, PAUSE_MARK] : rest;
            const key = JSON.stringify(labels);
            const group = groups.get(key) ?? { labels, ids: [] };
            group.ids.push(refOf(t));
            groups.set(key, group);
        }
        for (const { labels, ids } of groups.values()) await this.#rpc('torrent-set', { ids, labels });
    }

    /** One RPC call, failed on a `result` other than "success", which every
     *  Transmission failure arrives as, with HTTP 200. */
    async #rpc<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T | undefined> {
        const body = await this.#http.post<RpcResponse<T>>(RPC_PATH, {
            method,
            ...(args === undefined ? {} : { arguments: args })
        });
        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `${method} failed: ${resultOf(this.id, body.result)}`);
        }
        return body.arguments;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        this.#sessionRead.clear();
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    /**
     * Transmission answers RPC failures with HTTP 200 and a `result` other than
     * "success", so checking the status line alone would report a broken call
     * as healthy.
     */
    #session(): Promise<RawSession> {
        return this.#sessionRead();
    }

    async #readSession(): Promise<RawSession> {
        const body = await this.#http.post<RpcResponse<RawSession>>(RPC_PATH, { method: 'session-get' });
        if (body.result !== 'success') {
            throw new ServiceError('UpstreamError', this.id, `session-get failed: ${resultOf(this.id, body.result)}`);
        }
        return body.arguments ?? {};
    }
}
