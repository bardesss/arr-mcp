import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { DELUGE_RPC_PATH, delugeSession } from '../core/auth.ts';
import { SHORT_READ_TTL_MS, cached } from '../core/cache.ts';
import type { TorrentFacts } from '../core/cleanuparrRules.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { hostPort } from '../core/hostPort.ts';
import { ServiceHttp } from '../core/http.ts';
import { magnetHash } from '../core/magnet.ts';
import {
    diagnoseConnection,
    withHold,
    type ClientHold,
    type ClientSeedLimits,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type MagnetAdded,
    type MagnetAddCapable,
    type PauseCapable,
    type PauseState,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RemoveQueueOptions,
    type SeedingState,
    type SeedLimitsCapable,
    type ServiceAdapter,
    type SpeedLimit,
    type SpeedLimitCapable,
    type TorrentEndpoint
} from './types.ts';

/**
 * Hand-written: Deluge's Web UI speaks JSON-RPC on one POST endpoint and
 * passes most calls on to a separate daemon. Every answer is HTTP 200, a
 * failed call included, so the body is what says whether one worked.
 * Confirmed against a live 2.2.0 and 2.0.3.
 */
type RpcAnswer<T> = { result?: T; error?: { message?: unknown; code?: unknown } | null } | null;

type RawConfig = {
    download_location?: string;
    /** KiB/s; -1, Deluge's default, is no limit. */
    max_download_speed?: number;
    stop_seed_at_ratio?: boolean;
    stop_seed_ratio?: number;
    /** Removes the torrent, keeping its files, rather than pausing it at the ratio. */
    remove_seed_at_ratio?: boolean;
    enabled_plugins?: unknown[];
};

/** One `core.get_config_values` serves the disk check and seed limits of a get_stack_health pass, the speed limit, and the Scheduler check below. */
export const CONFIG_KEYS = ['download_location', 'max_download_speed', 'stop_seed_at_ratio', 'stop_seed_ratio', 'remove_seed_at_ratio', 'enabled_plugins'];

type RawTorrent = {
    name?: string;
    state?: string;
    /** libtorrent's own flag: set on a torrent paused by hand, and on one Deluge's queue holds back. */
    paused?: boolean;
    /** Every wanted file is down. A torrent with files left out finishes without being a seed. */
    is_finished?: boolean;
    total_size?: number;
    /** Bytes left of the wanted files: libtorrent's `total_wanted` less `total_wanted_done`. */
    total_remaining?: number;
    /** 0 when Deluge has no estimate and -1 past a year; on a finished torrent, the time left to its stop ratio. */
    eta?: number;
    /** "OK", or why a torrent is in `Error`. */
    message?: string;
    /** -1 while nothing has downloaded. */
    ratio?: number;
    seeding_time?: number;
    /** On when true or a number other than 0, as Deluge reads it: Radarr and Sonarr set it to 1 (`DelugeProxy`). */
    stop_at_ratio?: boolean | number;
    stop_ratio?: number;
    private?: boolean;
    download_location?: string;
    /** The Label plugin's, and only while it is enabled: the category Radarr and Sonarr set. */
    label?: string;
    trackers?: unknown[];
};

/** Asked for by name: with no keys Deluge sends every field, files and peers included. A key it does not know, `label` with the plugin off, is left out of the answer. */
export const QUEUE_KEYS = [
    'name',
    'state',
    'paused',
    'is_finished',
    'total_size',
    'total_remaining',
    'eta',
    'message',
    'ratio',
    'seeding_time',
    'stop_at_ratio',
    'stop_ratio',
    'private',
    'download_location',
    'label',
    'trackers'
];

/** What a one-torrent pause or resume needs to know about it. */
const PAUSE_KEYS = ['state', 'paused', 'is_finished', 'ratio', 'stop_at_ratio', 'stop_ratio', 'message'];

/**
 * Deluge's states, the same from 2.0.3 to 2.2.0 (`Torrent.update_state`).
 * `Paused` and `Queued` are read with the flags beside them, in `statusOf`.
 */
const TORRENT_STATE: Record<string, string> = {
    Allocating: 'allocating',
    Checking: 'checking',
    Downloading: 'downloading',
    Seeding: 'seeding',
    Moving: 'moving',
    Error: 'error'
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A Deluge speed setting in KiB/s, where 0 or below is no limit. */
const kbpsOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;

/** A torrent's "Stop seed at ratio", which Deluge reads by truthiness (`Torrent.resume`, `TorrentManager`). */
const stopsAtRatio = (value: unknown): boolean => value === true || (typeof value === 'number' && value !== 0);

/** A finished torrent at or past the ratio it stops at, which `Torrent.resume` does not restart. */
const atStopRatio = (t: RawTorrent): boolean =>
    t.is_finished === true &&
    stopsAtRatio(t.stop_at_ratio) &&
    typeof t.stop_ratio === 'number' &&
    typeof t.ratio === 'number' &&
    t.ratio >= t.stop_ratio;

/**
 * What holds every torrent while the session is paused: a pause by hand, which
 * a whole-client resume ends, or an hour the Scheduler marks Paused, where it
 * would pause a resume again the next time it runs in a Paused hour, or sooner,
 * when a limit it controls changes, so this server refuses one there.
 */
type SessionHold = Extract<ClientHold, 'queue' | 'scheduler'>;

/**
 * A session pause holds every torrent, and Deluge shows each one that was
 * running as `Paused`, but one in `Error` or `Moving`, which keep those
 * states (`Torrent.update_state`). Under one, a torrent's own `paused` flag
 * is what says where a `Paused` one stands: clear on a torrent that was
 * running, which resuming the session starts again, and set on one paused by
 * hand. Libtorrent 1.2 and later report no pause for a torrent paused
 * already, so one Deluge's queue was holding back stays `Queued`
 * (`set_session_paused`). Libtorrent 1.1 reports every torrent paused, and
 * Deluge then shows that one as `Paused` with the flag set, which nothing in
 * its status tells from a pause by hand, so it is read as paused by hand.
 */
function statusOf(t: RawTorrent, hold: SessionHold | undefined): { status: string; heldBy?: SessionHold } {
    const queued = t.is_finished === true ? 'queued to seed' : 'queued';
    const held = withHold(hold);
    if (t.state === 'Queued') return { status: queued, ...held };
    if (t.state === 'Paused') return { status: hold !== undefined && t.paused !== true ? queued : 'paused', ...held };
    return { status: TORRENT_STATE[t.state ?? ''] ?? 'unknown', ...held };
}

/**
 * Deluge's only seed limit is a ratio, stored on each torrent: copied from the
 * client's defaults when it is added, and changed after by Radarr and Sonarr
 * (the indexer's), a label or a hand edit. So a torrent whose ratio settings
 * differ from the client's defaults has its own.
 */
function seedingOf(t: RawTorrent, config: RawConfig): { seeding?: SeedingState } {
    if (t.is_finished !== true) return {};

    const ratio = typeof t.ratio === 'number' && t.ratio >= 0 ? t.ratio : undefined;
    const stops = stopsAtRatio(t.stop_at_ratio);
    const ratioLimit = stops && typeof t.stop_ratio === 'number' ? t.stop_ratio : undefined;
    const own =
        typeof config.stop_seed_at_ratio === 'boolean' &&
        (typeof t.stop_at_ratio === 'boolean' || typeof t.stop_at_ratio === 'number') &&
        (stops !== config.stop_seed_at_ratio || (stops && t.stop_ratio !== config.stop_seed_ratio));

    return {
        seeding: {
            ...(ratio === undefined ? {} : { ratio }),
            ...(typeof t.seeding_time === 'number' ? { seedingSeconds: t.seeding_time } : {}),
            ...(ratioLimit === undefined ? {} : { ratioLimit }),
            ...(own ? { ownLimit: true as const } : {}),
            ...(ratioLimit !== undefined && ratio !== undefined && ratio >= ratioLimit ? { overLimit: true as const } : {})
        }
    };
}

/**
 * Read the way Cleanuparr reads a Deluge torrent (`DelugeItemWrapper`,
 * `DelugeServiceDC`): the Label plugin's label is the category, there are no
 * tags, every tracker counts, `Paused` is stopped, and a seed is one in
 * `Seeding` or a finished one paused or queued.
 */
function torrentOf(hash: string, t: RawTorrent): { torrent: TorrentFacts } {
    const trackerDomains = (Array.isArray(t.trackers) ? t.trackers : []).flatMap(tr => {
        const url = isRecord(tr) ? tr.url : undefined;
        try {
            return typeof url === 'string' ? [new URL(url).hostname.toLowerCase()] : [];
        } catch {
            return [];
        }
    });
    return {
        torrent: {
            hash,
            category: typeof t.label === 'string' ? t.label : '',
            tags: [],
            trackerDomains,
            ...(typeof t.download_location === 'string' && t.download_location !== '' ? { savePath: t.download_location } : {}),
            ...(typeof t.private === 'boolean' ? { private: t.private } : {}),
            stopped: t.state === 'Paused',
            seeding: t.state === 'Seeding' || (t.is_finished === true && (t.state === 'Paused' || t.state === 'Queued'))
        }
    };
}

const ID_REMEDY = 'Deluge torrent ids are info hashes. Take one from get_queue.';

/** The password was taken, and the session cookie that came with it was not, on the very next call. */
const SESSION_REFUSED_REMEDY =
    'Deluge accepted the password but not the session cookie sent back with the next call. Check that nothing between arr-mcp and the Web UI, such as a reverse proxy, drops the Cookie header.';

/**
 * Deluge's Scheduler plugin applies its Schedule about a minute past each hour,
 * when it is turned on or its settings are saved, and at once whenever one of
 * the limits it controls changes (`do_schedule`, `on_config_value_changed`,
 * `CONTROLLED_SETTINGS`), while `get_state` reads the hour's state from its
 * first second. Each hour is `Green`, `Yellow` or `Red`, which its
 * Web UI calls Normal, Throttled and Paused, and every hour not set otherwise
 * is `Green`. A Paused hour pauses the session and any other resumes it, so a
 * whole-client pause in a Normal or Throttled hour, or a resume in a Paused
 * one, would last only until the Schedule next says otherwise, and in a
 * Throttled hour the limit in its Throttled Settings (the `low_*` ones) is in
 * force. Those are refused, as Transmission's turtle mode refuses a limit; the
 * rest works. One torrent's own pause is not the session's, and is left to work
 * every hour.
 */
const schedulerOn = (config: RawConfig): boolean => Array.isArray(config.enabled_plugins) && config.enabled_plugins.includes('Scheduler');

type SchedulerSlot = 'Green' | 'Yellow' | 'Red';

const isSlot = (value: unknown): value is SchedulerSlot => value === 'Green' || value === 'Yellow' || value === 'Red';

export const schedulerPauseRefusal = (id: string): Error =>
    new Error(
        `Deluge's Scheduler plugin is on at ${id}, and its Schedule runs the session this hour, so it would resume a pause the next time it runs in an hour it does not mark Paused, or sooner, when a limit it controls changes. Pause torrents one at a time with \`id\`, which it leaves alone, or mark this hour Paused in the Schedule.`
    );

export const schedulerResumeRefusal = (id: string): Error =>
    new Error(
        `Deluge's Scheduler plugin is on at ${id}, and its Schedule marks this hour Paused, so it would pause the session the next time it runs in an hour it marks Paused, or sooner, when a limit it controls changes. Mark this hour Normal or Throttled in the Schedule, or turn the plugin off in Deluge's Plugins preferences; either resumes the session at once, or keeps it running.`
    );

export const schedulerLimitRefusal = (id: string, kbps: number | undefined): Error =>
    new Error(
        `Deluge's Scheduler plugin is on at ${id}, and its Schedule marks this hour Throttled, so the download limit in its Throttled Settings (${kbps === undefined ? 'none' : `${kbps} KiB/s`}) is in force through every Throttled hour. Change that limit in the plugin's Throttled Settings, or this hour in the Schedule.`
    );

/** A read made while the Web UI has no daemon behind it. get_stack_health's connection test says which case it is. */
const notConnected = (id: string): ServiceError =>
    new ServiceError('Unreachable', id, 'the Web UI is not connected to a Deluge daemon, so nothing behind it can be read', {
        remedy: "Connect to the daemon in the Web UI's Connection Manager, after starting deluged if it is not running."
    });

const SESSION = 'the Deluge session';

/** A plugin call's answer when the daemon has not loaded the plugin (`#rpc`'s `notLoaded`). */
const NOT_LOADED = Symbol('not loaded');

export class DelugeAdapter
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
    readonly type: ServiceId = 'deluge';
    readonly endpoint: string;
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;
    /**
     * Whether the Web UI has a daemon behind it, asked before every daemon
     * call. Without one, a daemon call through a Web UI that was connected
     * before never answers, and waits out the timeout: the Web UI keeps the
     * method list of its last connection and passes the call to a connection
     * that is gone. A `false` is kept for the whole window too.
     */
    readonly #connectedRead = cached(SHORT_READ_TTL_MS, () => this.#rpc<boolean>('web.connected', []));
    readonly #configRead = cached(SHORT_READ_TTL_MS, () => this.#readConfig());
    /** The Scheduler's state for the hour, read only while the plugin is on. */
    readonly #slotRead = cached(SHORT_READ_TTL_MS, () => this.#readSlot());

    constructor(config: ConfigByService['deluge'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.endpoint = hostPort(config.url) ?? config.url;
        this.id = instanceId('deluge', config.name);
        this.#http = new ServiceHttp(
            this.id,
            config,
            delugeSession({
                id: this.id,
                url: config.url,
                password: config.password,
                timeoutMs: config.timeout_ms,
                ...(fetchImpl === fetch ? {} : { fetchImpl })
            }),
            fetchImpl
        );
    }

    /** The daemon's version: the Web UI does not report its own. */
    async getVersion(): Promise<string> {
        const version = await this.#daemon<unknown>('daemon.get_version', []);
        if (typeof version !== 'string' || version === '') {
            throw new ServiceError('UpstreamError', this.id, 'daemon.get_version returned no version');
        }
        return version;
    }

    /** -1 is Deluge's answer for a download folder that does not exist, not a size. */
    async getDiskSpace(): Promise<DiskSpace[]> {
        const [config, free] = await Promise.all([this.#configRead(), this.#daemon<unknown>('core.get_free_space', [])]);
        if (typeof free !== 'number' || free < 0) return [];
        return [
            {
                service: this.id,
                path: config.download_location ?? 'download_location',
                label: 'Deluge download_location',
                freeSpace: free
                // No totalSpace: Deluge reports free space only.
            }
        ];
    }

    async getQueue(): Promise<QueueItem[]> {
        // The config's ratio defaults tell a torrent's own limit apart. A
        // failed side read costs the queue only what that read adds: no config
        // drops `ownLimit`, no config or Scheduler state reads a session pause
        // as one by hand, and no session state drops `heldBy`, so a torrent
        // only the session holds reads `paused`.
        const [torrents, hold, config] = await Promise.all([
            this.#daemon<unknown>('core.get_torrents_status', [{}, QUEUE_KEYS]),
            this.#sessionHold().catch(() => undefined),
            this.#configRead().catch((): RawConfig => ({}))
        ]);
        if (!isRecord(torrents)) return [];

        return Object.entries(torrents).flatMap(([key, value]) => {
            if (!isRecord(value) || !/^[0-9a-f]{40}$/i.test(key)) return [];
            const t = value as RawTorrent;
            const hash = key.toLowerCase();
            const { status, heldBy } = statusOf(t, hold);
            const finished = t.is_finished === true;
            return [
                {
                    service: this.id,
                    id: hash,
                    title: fenceText(t.name ?? '', { service: this.id, field: 'name' }),
                    status,
                    protocol: 'torrent',
                    ...(typeof t.total_size === 'number' ? { sizeBytes: t.total_size } : {}),
                    ...(typeof t.total_remaining === 'number' ? { remainingBytes: t.total_remaining } : {}),
                    // Absent rather than 0 when Deluge has no estimate, and on a
                    // finished torrent, where it counts down to the stop ratio.
                    ...(!finished && typeof t.eta === 'number' && t.eta > 0 ? { etaSeconds: t.eta } : {}),
                    ...(t.state === 'Error' && typeof t.message === 'string' && t.message !== ''
                        ? { errorMessage: fenceText(t.message, { service: this.id, field: 'message' }) }
                        : {}),
                    ...(typeof t.private === 'boolean' ? { private: t.private } : {}),
                    ...withHold(heldBy),
                    ...seedingOf(t, config),
                    ...torrentOf(hash, t)
                }
            ];
        });
    }

    /**
     * Deluge has no seeding-time limit. At its ratio it pauses a torrent, or
     * removes it and keeps the files. These are the defaults a torrent takes
     * when it is added without settings of its own: Radarr and Sonarr add
     * theirs with "Remove at ratio" off (`DelugeProxy`), so Deluge pauses
     * those at the ratio whatever the default says. A label with "Apply queue
     * settings" on puts its own in their place when they set it, and moving a
     * torrent off such a label puts these defaults back (the Label plugin's
     * `_set_torrent_options` and `_unset_torrent_options`).
     */
    async getSeedLimits(): Promise<ClientSeedLimits> {
        const config = await this.#configRead();
        const ratio = config.stop_seed_at_ratio === true && typeof config.stop_seed_ratio === 'number' ? config.stop_seed_ratio : undefined;
        return {
            service: this.id,
            ...(ratio === undefined ? {} : { ratioLimit: ratio }),
            action: config.remove_seed_at_ratio === true ? 'remove' : 'stop'
        };
    }

    /** Deluge has no blocklist of grabbed releases: that is an *arr concept. */
    readonly supportsBlocklist = false;

    /**
     * `remove_data` is the destructive half, and it maps to
     * `removeFromClient`. No lookup first: remove_queue_item's preview has
     * just found the torrent in get_queue, and an id Deluge does not have
     * fails loudly, as an `InvalidTorrentError`, rather than doing nothing.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        const hash = this.#torrentRef(id);
        const removed = await this.#daemon<unknown>('core.remove_torrent', [hash, opts.removeFromClient]);
        // False is libtorrent refusing the removal.
        if (removed !== true) {
            throw new ServiceError('UpstreamError', this.id, `Deluge did not remove torrent ${hash}`, {
                remedy: "Check the torrent in Deluge: libtorrent refused to remove it, and the daemon's log says why."
            });
        }
    }

    /**
     * The whole client is Deluge's session pause, which `resume_session` ends
     * without starting the torrents paused one at a time. Deluge does not
     * save it, so a restart of the daemon ends it too. One torrent's pause is
     * its own, and is saved with it.
     */
    async readPauseState(id?: string): Promise<PauseState> {
        if (id === undefined) {
            const [paused, slot] = await Promise.all([this.#sessionPaused(), this.#slot()]);
            return {
                paused,
                scope: SESSION,
                endsOnRestart: true,
                resumeNote: "Every torrent not paused on its own starts again, as Deluge's Queue settings allow, and uses bandwidth.",
                ...(slot === undefined ? {} : { scheduler: slot === 'Red' ? 'stop' : 'run' })
            };
        }

        const hash = this.#torrentRef(id);
        const [t, hold] = await Promise.all([this.#torrent(hash, PAUSE_KEYS), this.#sessionHold()]);
        if (t === undefined) throw this.#notFound(id);

        const { status, heldBy } = statusOf(t, hold);
        // Its own pause is libtorrent's flag, which a one-torrent read gets
        // fresh (`get_status` with `update`), where the state lags a pause or
        // resume until Deluge has handled libtorrent's alert, longest on 2.0.3,
        // and shows `Moving` ahead of it. One in Error is held paused too, and
        // Deluge refuses to pause it again.
        const own = typeof t.paused === 'boolean' ? t.paused && t.state !== 'Queued' : t.state === 'Paused';
        const paused = own || t.state === 'Error';
        // A resume leaves one in Error at its stop ratio paused, and so would
        // resuming the session, so no hold is named for it.
        const held = t.state === 'Error' && atStopRatio(t) ? undefined : heldBy;
        return { paused, scope: `torrent ${id}`, ...withHold(held), ...this.#resumeLimits(t, status, own, hold !== undefined) };
    }

    /**
     * What Deluge's own `Torrent.resume` does instead of restarting the
     * torrent: nothing for one its queue holds back (it starts that one
     * itself) or one paused at its stop ratio, and for one in `Error` a retry
     * that clears libtorrent's own error but not one Deluge raised itself,
     * which a Force Recheck clears (`force_recheck`). Its error is cleared
     * whichever restart it skips, so a resume of one at its stop ratio is
     * sent, and leaves it paused. One Deluge raised the error on is not
     * restarted either when it was paused as the error came, which nothing in
     * its status shows (`TorrentError.was_paused`).
     */
    #resumeLimits(t: RawTorrent, status: string, own: boolean, sessionPaused: boolean): Pick<PauseState, 'resumeNoop' | 'resumeNote'> {
        if (!sessionPaused && (status === 'queued' || status === 'queued to seed')) {
            return { resumeNoop: 'is queued: Deluge starts it by itself as its Queue settings allow.' };
        }
        const atRatio = atStopRatio(t);
        if (t.state === 'Error') {
            const why = typeof t.message === 'string' && t.message !== '' ? ` (${fenceText(t.message, { service: this.id, field: 'message' })})` : '';
            const ratio = atRatio ? ` It has reached its stop ratio of ${t.stop_ratio}, so Deluge leaves it paused even once the error is cleared.` : '';
            return {
                resumeNote: `It is in Error${why}. A resume clears an error libtorrent raised, but not one Deluge raised itself, such as missing data or a failed move, which a Force Recheck in Deluge clears and which can keep the torrent from restarting.${ratio}`
            };
        }
        if (own && atRatio) {
            return {
                resumeNoop: `has reached its stop ratio of ${t.stop_ratio}, so Deluge does not restart it: raise its "Stop seed at ratio" or turn it off in Deluge first.`
            };
        }
        // Deluge's queue sets the flag too, and `Moving` hides which (`Torrent.update_state`).
        if (own && t.state === 'Moving') {
            return { resumeNote: "It is being moved, so Deluge does not show whether its own pause or Deluge's queue holds it; a resume restarts it only in the first case." };
        }
        return {};
    }

    /**
     * `only` is ignored: Deluge has a real client-wide pause, so there is
     * nothing to bind. The Scheduler is checked on the read the confirm's own
     * preview has just made.
     */
    async setPaused(paused: boolean, id?: string): Promise<void> {
        if (id === undefined) {
            const slot = await this.#slot();
            if (paused && slot !== undefined && slot !== 'Red') throw schedulerPauseRefusal(this.id);
            if (!paused && slot === 'Red') throw schedulerResumeRefusal(this.id);
            await this.#daemon(paused ? 'core.pause_session' : 'core.resume_session', []);
            return;
        }
        // No lookup first, as in removeQueueItem: the preview has just read
        // this torrent, and Deluge fails one it does not have.
        await this.#daemon(paused ? 'core.pause_torrent' : 'core.resume_torrent', [this.#torrentRef(id)]);
    }

    /**
     * `max_download_speed` is in KiB/s, the unit this boundary speaks, and 0
     * or below is no limit. In a Scheduler Throttled hour the limit in force
     * is the hour's own, `low_down`, in the same unit. In any other hour a
     * new limit makes the Scheduler apply the hour again, which resumes a
     * paused session in a Normal hour and pauses a running one in a Paused
     * hour (`on_config_value_changed`, `__apply_set_functions`).
     */
    async readSpeedLimit(): Promise<SpeedLimit> {
        const slot = await this.#slot();
        if (slot === 'Yellow') {
            const scheduler = await this.#daemon<unknown>('scheduler.get_config', []);
            const low = isRecord(scheduler) ? kbpsOf(scheduler.low_down) : undefined;
            return { service: this.id, ...(low === undefined ? {} : { kbps: low }), scheduled: true };
        }
        const limit = kbpsOf((await this.#configRead()).max_download_speed);
        return { service: this.id, ...(limit === undefined ? {} : { kbps: limit }), ...(await this.#sessionChange(slot)) };
    }

    /** What a new limit does to the session, as the Scheduler applies the hour again. */
    async #sessionChange(slot: SchedulerSlot | undefined): Promise<Pick<SpeedLimit, 'sessionChange'>> {
        if (slot === undefined) return {};
        const paused = await this.#sessionPaused();
        if (slot === 'Green' && paused) return { sessionChange: 'resume' };
        if (slot === 'Red' && !paused) return { sessionChange: 'pause' };
        return {};
    }

    async setSpeedLimit(kbps: number | undefined): Promise<void> {
        // The confirm's own preview has just read the hour's state, which is shared.
        if ((await this.#slot()) === 'Yellow') throw schedulerLimitRefusal(this.id, (await this.readSpeedLimit()).kbps);
        await this.#daemon('core.set_config', [{ max_download_speed: kbps === undefined || kbps <= 0 ? -1 : Math.round(kbps) }]);
        this.#configRead.clear();
    }

    /**
     * Deluge fails a magnet for a torrent it already has, so a duplicate is
     * looked for first and reported rather than thrown: it is the state the
     * caller asked for. `add_torrent_magnet` answers with the info hash once
     * the torrent is in the session. Options are left to the client's
     * defaults, since no *arr is behind the magnet to set a label.
     */
    async addMagnet(uri: string): Promise<MagnetAdded> {
        const hash = magnetHash(uri);
        if (hash !== undefined && /^[0-9a-f]{40}$/.test(hash)) {
            const existing = await this.#torrent(hash, ['name']);
            if (existing !== undefined) {
                return {
                    id: hash,
                    ...(typeof existing.name === 'string' ? { title: fenceText(existing.name, { service: this.id, field: 'name' }) } : {}),
                    duplicate: true
                };
            }
        }

        const added = await this.#daemon<unknown>('core.add_torrent_magnet', [uri, {}], {
            remedy: 'Deluge refused the magnet. Check the link is complete.'
        });
        return { ...(typeof added === 'string' && added !== '' ? { id: added.toLowerCase() } : {}), duplicate: false };
    }

    /**
     * After `web.connected` is false, `web.get_host_status` words the remedy:
     * the daemon is down, or up with the Web UI not connected to it. Only
     * here, never in a read: for a daemon it is not connected to, it opens a
     * connection of its own, with Twisted's 30 s timeout behind it.
     */
    async testConnection(): Promise<ConnectionDiagnosis> {
        this.#connectedRead.clear();
        this.#configRead.clear();
        this.#slotRead.clear();
        return diagnoseConnection(this.id, this.type, async () => {
            if ((await this.#connectedRead()) !== true) throw await this.#notConnected();
            return this.getVersion();
        });
    }

    async #notConnected(): Promise<ServiceError> {
        const hosts = await this.#rpc<unknown>('web.get_hosts', []).catch(() => undefined);
        const rows = Array.isArray(hosts) ? (hosts as unknown[]) : [];
        const ids = rows.flatMap(h => (Array.isArray(h) && typeof h[0] === 'string' ? [h[0]] : []));
        if (Array.isArray(hosts) && ids.length === 0) {
            return new ServiceError('Unreachable', this.id, 'the Web UI is not connected to a Deluge daemon, and its Connection Manager lists none', {
                remedy: "Add the daemon in the Web UI's Connection Manager and connect to it."
            });
        }
        const states = await Promise.all(
            ids.map(host =>
                this.#rpc<unknown>('web.get_host_status', [host]).then(
                    (s): unknown => (Array.isArray(s) ? (s as unknown[])[1] : undefined),
                    () => undefined
                )
            )
        );
        if (states.includes('Online')) {
            return new ServiceError('Unreachable', this.id, 'the Web UI answers, but it is not connected to the Deluge daemon, which is running', {
                remedy: "Connect to the daemon in the Web UI's Connection Manager."
            });
        }
        if (states.length > 0 && states.every(s => s === 'Offline')) {
            return new ServiceError('Unreachable', this.id, 'the Web UI answers, but no Deluge daemon answers at the address its Connection Manager lists', {
                remedy: "Start deluged, or correct the daemon's address in the Web UI's Connection Manager, then connect to it there."
            });
        }
        return notConnected(this.id);
    }

    /** `{}` is Deluge's answer for a torrent id it does not have. */
    async #torrent(hash: string, keys: readonly string[]): Promise<RawTorrent | undefined> {
        const t = await this.#daemon<unknown>('core.get_torrent_status', [hash, keys]);
        return isRecord(t) && Object.keys(t).length > 0 ? t : undefined;
    }

    async #sessionPaused(): Promise<boolean> {
        return (await this.#daemon<unknown>('core.is_session_paused', [])) === true;
    }

    /** What holds every torrent, while the session is paused. */
    async #sessionHold(): Promise<SessionHold | undefined> {
        if (!(await this.#sessionPaused())) return undefined;
        // A Scheduler state that cannot be read leaves the pause one by hand.
        const slot = await this.#slot().catch(() => undefined);
        return slot === 'Red' ? 'scheduler' : 'queue';
    }

    /** The Scheduler's state for the hour, or undefined while the plugin is off. */
    async #slot(): Promise<SchedulerSlot | undefined> {
        return schedulerOn(await this.#configRead()) ? this.#slotRead() : undefined;
    }

    /**
     * Code 2, "Unknown method", is a Scheduler `enabled_plugins` lists that
     * the daemon could not load, whose name it keeps
     * (`PluginManagerBase.enable_plugin`). The Web UI reloads its method list
     * whenever a plugin is turned on or off, so it has none of the plugin's
     * methods, and no Schedule runs: the plugin counts as off.
     */
    async #readSlot(): Promise<SchedulerSlot | undefined> {
        const slot = await this.#daemon<unknown>('scheduler.get_state', [], { notLoaded: true });
        if (slot === NOT_LOADED) return undefined;
        if (isSlot(slot)) return slot;
        throw new ServiceError('UpstreamError', this.id, `scheduler.get_state answered ${fenceText(JSON.stringify(slot) ?? 'nothing', { service: this.id, field: 'slot' })}, not Green, Yellow or Red`);
    }

    async #readConfig(): Promise<RawConfig> {
        const config = await this.#daemon<unknown>('core.get_config_values', [CONFIG_KEYS]);
        return isRecord(config) ? config : {};
    }

    /** The info hash get_queue reports. Deluge keys torrents by it in lower case. */
    #torrentRef(id: string): string {
        const trimmed = id.trim();
        if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
        throw new ServiceError('NotFound', this.id, `"${id}" is not a Deluge torrent id`, { remedy: ID_REMEDY });
    }

    #notFound(id: string): ServiceError {
        return new ServiceError('NotFound', this.id, `no torrent with id "${id}"`, { remedy: ID_REMEDY });
    }

    /** A call the daemon answers, made only while the Web UI has one behind it. */
    async #daemon<T>(method: string, params: unknown[], opts?: { remedy?: string; notLoaded?: true }): Promise<T> {
        if ((await this.#connectedRead()) !== true) throw notConnected(this.id);
        return this.#rpc<T>(method, params, opts);
    }

    /**
     * One JSON-RPC call. "Not authenticated" (code 1) has already cost a
     * login and one retry in the auth strategy, so here it means the new
     * session was refused too. Any other error is the call failing: code 2
     * an unknown method, 3 and 4 an exception, as "ClassName: message".
     * `notLoaded` answers code 2 with `NOT_LOADED` instead, for a plugin's call.
     */
    async #rpc<T>(method: string, params: unknown[], opts?: { remedy?: string; notLoaded?: true }): Promise<T> {
        const body = await this.#http.post<RpcAnswer<T>>(DELUGE_RPC_PATH, { method, params, id: 1 });
        if (!isRecord(body)) {
            throw new ServiceError('UpstreamError', this.id, `${method} answered with no JSON-RPC body`, {
                remedy: 'Check the url points at the Deluge Web UI, whose JSON-RPC endpoint is /json.'
            });
        }
        const error = body.error;
        if (error != null) {
            if (error.code === 1) {
                throw new ServiceError('AuthFailed', this.id, 'the Web UI refused the session it had just issued', { remedy: SESSION_REFUSED_REMEDY });
            }
            if (error.code === 2 && opts?.notLoaded === true) return NOT_LOADED as T;
            const message = typeof error.message === 'string' ? error.message : 'no message';
            throw new ServiceError(
                'UpstreamError',
                this.id,
                `${method} failed: ${fenceText(message, { service: this.id, field: 'error' })}`,
                opts?.remedy === undefined ? undefined : { remedy: opts.remedy }
            );
        }
        return body.result as T;
    }
}
