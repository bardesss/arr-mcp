import type { ServiceId } from '../config/schema.ts';
import type { IndexInput } from '../core/resolver.ts';
import { ServiceError, type ServiceErrorKind } from '../core/errors.ts';
import { assertVersionSupported } from './versions.ts';

/** A diagnosis, not a boolean: true/false tells nobody what to fix. */
export type ConnectionDiagnosis = {
    ok: boolean;
    service: string;
    latency_ms: number;
    version?: string;
    error?: { kind: ServiceErrorKind; detail: string; remedy?: string };
};

export interface ServiceAdapter {
    /** `radarr`, or `radarr/4k` when named. The identity everything
     *  human-facing uses: audit rows, log filters, errors, merged output. */
    readonly id: string;
    /**
     * What kind of service this is. **Capability dispatch keys on this, never
     * on `id`**, which is the whole reason the two are separate: with two
     * Radarrs, `id === 'radarr'` stops being a question with one answer.
     */
    readonly type: ServiceId;
    /** The instance name, absent when there is only one. */
    readonly instance?: string | undefined;
    testConnection(): Promise<ConnectionDiagnosis>;
    getVersion(): Promise<string>;
}

/** `service` is on every row because stack_health merges up to eight services
 *  into one list, and a failure that does not say who reported it is not
 *  actionable. */
export type DiskSpace = {
    service: string;
    /** Optional: omitted below `detail: full`, where paths are the longest
     *  strings in the response and rarely what the question was about. */
    path?: string;
    label: string;
    freeSpace: number;
    /** Optional: Transmission reports free space without a total. */
    totalSpace?: number;
};

export type HealthCheck = { service: string; source: string; type: string; message: string };

/** Library scan staleness, the fourth thing asks stack_health for. */
export type ScanState = { service: string; lastCompleted?: string; running?: boolean };

export interface DiskSpaceCapable {
    getDiskSpace(): Promise<DiskSpace[]>;
}
export interface HealthCheckCapable {
    getFailedHealthChecks(): Promise<HealthCheck[]>;
}
export interface ScanStateCapable {
    getScanState(): Promise<ScanState>;
}

/** Jellyfin and Seerr only — the two multi-user services. */
export type ServiceUser = { id: string; name: string };

export interface UserDirectoryCapable {
    listUsers(): Promise<ServiceUser[]>;
}

export const hasUserDirectory = (a: ServiceAdapter): a is ServiceAdapter & UserDirectoryCapable =>
    typeof (a as Partial<UserDirectoryCapable>).listUsers === 'function';

export const hasDiskSpace = (a: ServiceAdapter): a is ServiceAdapter & DiskSpaceCapable =>
    typeof (a as Partial<DiskSpaceCapable>).getDiskSpace === 'function';

export const hasHealthChecks = (a: ServiceAdapter): a is ServiceAdapter & HealthCheckCapable =>
    typeof (a as Partial<HealthCheckCapable>).getFailedHealthChecks === 'function';

export const hasScanState = (a: ServiceAdapter): a is ServiceAdapter & ScanStateCapable =>
    typeof (a as Partial<ScanStateCapable>).getScanState === 'function';

// --- read-tool capabilities ---

export type IndexerSummary = {
    service: string;
    id: number;
    name: string;
    enabled: boolean;
    protocol: string;
    priority: number;
    disabledUntil?: string;
    lastFailure?: string;
    queries?: number;
    grabs?: number;
    rejectedQueries?: number;
    rejectedGrabs?: number;
};

/** A query an indexer refused, with the reason it gave. the "recent rejections". */
export type IndexerRejection = { indexer: string; at: string; reason: string; query?: string };

export interface IndexerCapable {
    getIndexers(): Promise<IndexerSummary[]>;
    /** Resolves empty rather than throwing when the service exposes no history. */
    getRecentRejections(limit: number): Promise<IndexerRejection[]>;
}

export const hasIndexers = (a: ServiceAdapter): a is ServiceAdapter & IndexerCapable =>
    typeof (a as Partial<IndexerCapable>).getIndexers === 'function';

export type MissingLanguage = { name: string; code2: string; forced: boolean; hearingImpaired: boolean };

export type SubtitleGap = {
    service: string;
    kind: 'movie' | 'episode';
    id: number;
    title: string;
    episodeTitle?: string;
    season?: number;
    episode?: number;
    releaseName?: string;
    missing: MissingLanguage[];
};

/**
 * the "provider state". A subtitle gap says what is missing; this says
 * whether Bazarr is currently able to do anything about it.
 */
export type SubtitleProvider = {
    service: string;
    name: string;
    healthy: boolean;
    /** The provider's own words, present only when unhealthy. */
    status?: string;
    retryAt?: string;
};

export interface SubtitleCapable {
    getMissingSubtitles(): Promise<SubtitleGap[]>;
    getProviders(): Promise<SubtitleProvider[]>;
}

export const hasSubtitles = (a: ServiceAdapter): a is ServiceAdapter & SubtitleCapable =>
    typeof (a as Partial<SubtitleCapable>).getMissingSubtitles === 'function';

export type QueueItem = {
    service: string;
    id: string;
    title: string;
    status: string;
    protocol?: string;
    sizeBytes?: number;
    remainingBytes?: number;
    etaSeconds?: number;
    errorMessage?: string;
};

export interface QueueCapable {
    getQueue(): Promise<QueueItem[]>;
}

export const hasQueue = (a: ServiceAdapter): a is ServiceAdapter & QueueCapable =>
    typeof (a as Partial<QueueCapable>).getQueue === 'function';

export type CalendarEntry = {
    service: string;
    kind: 'movie' | 'episode';
    id: number;
    title: string;
    seriesTitle?: string;
    season?: number;
    episode?: number;
    /** ISO 8601. When the item becomes available, whatever the service calls it. */
    date: string;
    hasFile: boolean;
    monitored: boolean;
};

export interface CalendarCapable {
    getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]>;
}

export const hasCalendar = (a: ServiceAdapter): a is ServiceAdapter & CalendarCapable =>
    typeof (a as Partial<CalendarCapable>).getCalendar === 'function';

export type PlaybackEntry = {
    service: string;
    kind: 'now_playing' | 'resume';
    itemId: string;
    title: string;
    seriesTitle?: string;
    season?: number;
    episode?: number;
    user: string;
    positionSeconds?: number;
    runtimeSeconds?: number;
    percentComplete?: number;
    lastPlayed?: string;
    device?: string;
};

export type RequestStatus = 'pending' | 'approved' | 'declined';

export type MediaRequest = {
    service: string;
    id: number;
    status: RequestStatus | 'unknown';
    mediaType: 'movie' | 'tv' | 'unknown';
    tmdbId?: number;
    tvdbId?: number;
    title?: string;
    requestedBy: string;
    requestedAt?: string;
};

export interface RequestCapable {
    getRequests(opts: { user?: ServiceUser; status?: RequestStatus }): Promise<MediaRequest[]>;
}

export const hasRequests = (a: ServiceAdapter): a is ServiceAdapter & RequestCapable =>
    typeof (a as Partial<RequestCapable>).getRequests === 'function';

export type EpisodeSummary = {
    id: number;
    season: number;
    episode: number;
    title: string;
    airDate?: string;
    hasFile: boolean;
    monitored: boolean;
};

export type MediaDetails = {
    service: string;
    kind: 'movie' | 'series' | 'item';
    id: string;
    title: string;
    year?: number;
    overview?: string;
    monitored?: boolean;
    hasFile?: boolean;
    sizeBytes?: number;
    quality?: string;
    path?: string;
    ids: { tmdb?: number; tvdb?: number; imdb?: string };
    /** Flattened from each service's nested shape to `source → value`. */
    ratings?: Record<string, number>;
    episodes?: EpisodeSummary[];
    episodeCount?: number;
    episodesTruncated?: boolean;
};

export interface MediaDetailCapable {
    getMediaDetails(id: string, opts: { includeEpisodes: boolean; episodeLimit: number }): Promise<MediaDetails>;
}

export const hasMediaDetails = (a: ServiceAdapter): a is ServiceAdapter & MediaDetailCapable =>
    typeof (a as Partial<MediaDetailCapable>).getMediaDetails === 'function';

export type SearchSource = 'library' | 'discover' | 'indexers';

export type SearchHit = {
    service: string;
    source: SearchSource;
    kind: 'movie' | 'series' | 'item' | 'release';
    id: string;
    title: string;
    year?: number;
    ids: { tmdb?: number; tvdb?: number; imdb?: string };
    /**
     * Ratings by source, on each source's native scale — same shape as
     * `MediaDetails.ratings`, which this is the not-yet-owned counterpart to.
     *
     * Nothing an *arr's lookup endpoint returns populates this: their search
     * payloads are shaped for *adding* a title, not describing one. It exists
     * for the IMDb dataset (0.8 ), which fills it for a hit carrying an
     * imdb id.
     */
    ratings?: Record<string, number>;
    hasFile?: boolean;
    monitored?: boolean;
    indexer?: string;
    sizeBytes?: number;
    seeders?: number;
    publishDate?: string;
};

export interface SearchCapable {
    /** Returns [] for a source this service cannot serve, rather than throwing. */
    search(query: string, source: SearchSource): Promise<SearchHit[]>;
}

export const hasSearch = (a: ServiceAdapter): a is ServiceAdapter & SearchCapable =>
    typeof (a as Partial<SearchCapable>).search === 'function';

// --- write capabilities ---

/**
 * What the *arrs hand back when told to do something: a queued command, not a
 * result. The search itself runs asynchronously, which is why `trigger_search`
 * reports "asked Radarr to search" rather than "found a release" — claiming the
 * latter would be a confident lie about work that has not happened yet.
 */
export type CommandHandle = { service: string; commandId: number; name: string; status?: string };

export interface SearchTriggerCapable {
    /** Asks the service to look for releases for one item it already tracks. */
    triggerSearch(id: string): Promise<CommandHandle>;
}

export const hasSearchTrigger = (a: ServiceAdapter): a is ServiceAdapter & SearchTriggerCapable =>
    typeof (a as Partial<SearchTriggerCapable>).triggerSearch === 'function';

/**
 * Starting the library scan whose staleness `getScanState` reports.
 *
 * The two go together deliberately: `diagnose` names a stale scan as the usual
 * reason something downloaded is still not playable, and until 1.0 nothing
 * could act on that — its best answer ended "now go and do it yourself". The
 * services that can be asked are exactly the three that can be read.
 */
export interface LibraryScanCapable {
    /** Queues a rescan and returns; it does not wait for the scan to finish. */
    startLibraryScan(): Promise<CommandHandle>;
}

export const hasLibraryScan = (a: ServiceAdapter): a is ServiceAdapter & LibraryScanCapable =>
    typeof (a as Partial<LibraryScanCapable>).startLibraryScan === 'function';

/**
 * Both flags default to the *least* destructive reading at every layer — the
 * tool schema, the adapter signature and the service call — so a caller that
 * forgets one deletes less than they asked for rather than more.
 */
export type DeleteMediaOptions = {
    /** Delete the files from disk, not just the entry from the *arr's database. */
    deleteFiles: boolean;
    /** Also add an import exclusion, so it is never re-imported automatically. */
    addImportExclusion: boolean;
};

export interface MediaDeleteCapable {
    deleteMedia(id: string, opts: DeleteMediaOptions): Promise<void>;
}

export const hasMediaDelete = (a: ServiceAdapter): a is ServiceAdapter & MediaDeleteCapable =>
    typeof (a as Partial<MediaDeleteCapable>).deleteMedia === 'function';

export type RemoveQueueOptions = {
    /** Also tell the download client to drop it, and delete partial data. */
    removeFromClient: boolean;
    /**
     * Blocklist the release so the *arr will not grab it again. Meaningless on
     * SABnzbd and Transmission, which have no blocklist of their own — the
     * adapters there ignore it, and `remove_queue_item` says so in the preview
     * rather than silently accepting a flag that does nothing.
     */
    blocklist: boolean;
};

export interface QueueRemoveCapable {
    removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void>;
    /** True when this service can actually honour `blocklist`. */
    readonly supportsBlocklist: boolean;
}

export const hasQueueRemove = (a: ServiceAdapter): a is ServiceAdapter & QueueRemoveCapable =>
    typeof (a as Partial<QueueRemoveCapable>).removeQueueItem === 'function';

/**
 * `name` raw and `display` fenced, for the same reason `RootFolder` splits its
 * path — and discovered the same way, by a match that could never succeed.
 * `add_media` matches a requested profile against `name`; comparing against
 * the fenced form meant an exact-name match was structurally impossible, so
 * every name request fell through to substring matching, which is ambiguous
 * exactly where precision matters most.
 */
export type QualityProfile = { id: number; name: string; display: string };

/**
 * Two forms of the same string, deliberately.
 *
 * `path` is exactly what the service reported and is what gets posted back —
 * a fenced string is not a directory, and sending one would create a library
 * folder literally named `<<untrusted:radarr.path>>/movies<</untrusted>>`.
 * `display` is the fenced form for prose that reaches model context. Keeping
 * both is what stops anyone having to un-fence a value, which `fenceText` is
 * deliberately not reversible for.
 */
export type RootFolder = { path: string; display: string; freeSpaceBytes?: number };

/** What an external id resolves to, and whether the service already has it. */
export type AddCandidate = {
    title: string;
    year?: number;
    /** The service's own id when it is already in the library. Radarr and
     *  Sonarr both report `id: 0` on a lookup for something not yet added,
     *  which is how "already there" is told apart from "new". */
    existingId?: number;
};

export type AddMediaOptions = {
    externalId: string;
    qualityProfileId: number;
    rootFolderPath: string;
    monitored: boolean;
    searchNow: boolean;
};

export interface MediaAddCapable {
    listQualityProfiles(): Promise<QualityProfile[]>;
    listRootFolders(): Promise<RootFolder[]>;
    /** Resolves the external id — TMDB for Radarr, TVDB for Sonarr. */
    lookupForAdd(externalId: string): Promise<AddCandidate>;
    addMedia(opts: AddMediaOptions): Promise<{ id: number; title: string }>;
}

export const hasMediaAdd = (a: ServiceAdapter): a is ServiceAdapter & MediaAddCapable =>
    typeof (a as Partial<MediaAddCapable>).addMedia === 'function';

/**
 * The two reversible verdicts on a request. Deliberately not including
 * "delete": approving and declining move a request between states it can be
 * moved back out of, and deleting destroys the record. That difference is a
 * permission tier, so it is also a different capability method and a different
 * tool.
 */
export type RequestVerdict = 'approve' | 'decline';

export interface RequestManageCapable {
    /** Returns the request as it stands afterwards, so the caller can report
     *  what it became rather than what it asked for. */
    respondToRequest(id: string, verdict: RequestVerdict): Promise<MediaRequest>;
    deleteRequest(id: string): Promise<void>;
    /**
     * A human title for a request.
     *
     * Seerr's `/api/v1/request` payload carries **no title at all** — ids and
     * service metadata only, confirmed against a live 3.4.1. So a preview built
     * from the request alone says "request 19", which nobody can meaningfully
     * approve.
     *
     * Resolves undefined rather than throwing: a failed title lookup must not
     * block someone deleting a request.
     */
    describeRequestMedia(request: MediaRequest): Promise<{ title: string; year?: number } | undefined>;
}

export const hasRequestManage = (a: ServiceAdapter): a is ServiceAdapter & RequestManageCapable =>
    typeof (a as Partial<RequestManageCapable>).respondToRequest === 'function';

/**
 * A whole-library read, shaped for the identity resolver rather than for a
 * tool. The resolver joins three of these into one index; nothing else consumes it.
 */
export interface LibraryCapable {
    listLibrary(): Promise<IndexInput[]>;
}

export const hasLibrary = (a: ServiceAdapter): a is ServiceAdapter & LibraryCapable =>
    typeof (a as Partial<LibraryCapable>).listLibrary === 'function';

/**
 * Separate from LibraryCapable because Jellyfin's half is per-user:
 * watch state does not exist without a user, and a shared signature would let
 * a caller forget to supply one.
 */
export interface UserLibraryCapable {
    listUserLibrary(user: ServiceUser): Promise<IndexInput[]>;
}

export const hasUserLibrary = (a: ServiceAdapter): a is ServiceAdapter & UserLibraryCapable =>
    typeof (a as Partial<UserLibraryCapable>).listUserLibrary === 'function';

/**
 * Separate from `UserLibraryCapable` so it can fail on its own. `LibraryLoader`
 * registers this as its own `gather` source, which is what lets an episode-read
 * failure degrade `jellyfin:episodes` while film watch state survives.
 */
export interface UserSeasonsCapable {
    listUserSeasons(user: ServiceUser): Promise<IndexInput[]>;
}

export const hasUserSeasons = (a: ServiceAdapter): a is ServiceAdapter & UserSeasonsCapable =>
    typeof (a as Partial<UserSeasonsCapable>).listUserSeasons === 'function';

export interface DiscoverCapable {
    discover(opts: {
        mediaType: 'movie' | 'tv';
        genre?: string;
        year?: number;
        minRating?: number;
    }): Promise<SearchHit[]>;
}

/**
 * Every adapter's testConnection is the same twenty lines around a different
 * probe. Sharing them means "returns a diagnosis, never throws" is one
 * implementation to test rather than eight to audit.
 */
export async function diagnoseConnection(
    id: string,
    type: ServiceId,
    probe: () => Promise<string | undefined>
): Promise<ConnectionDiagnosis> {
    const started = performance.now();
    try {
        const version = await probe();
        // a connection test distinguishes version-too-old from every other
        // failure. Checked here rather than in each adapter, so no adapter can
        // forget — and after the probe, so an unreachable service reports being
        // unreachable rather than being the wrong version.
        if (version !== undefined) assertVersionSupported(type, version);

        const diagnosis: ConnectionDiagnosis = {
            ok: true,
            service: id,
            latency_ms: Math.round(performance.now() - started)
        };
        if (version !== undefined) diagnosis.version = version;
        return diagnosis;
    } catch (err) {
        const se =
            err instanceof ServiceError
                ? err
                : new ServiceError('UpstreamError', id, (err as Error).message ?? 'unknown', { cause: err });
        const error: ConnectionDiagnosis['error'] = { kind: se.kind, detail: se.detail };
        if (se.remedy !== undefined) error.remedy = se.remedy;
        return { ok: false, service: id, latency_ms: Math.round(performance.now() - started), error };
    }
}
