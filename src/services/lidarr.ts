import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import type { IndexInput } from '../core/resolver.ts';
import { readProfileNames } from './arrAdd.ts';
import { readArrBlocklist, removeArrBlocklistItem } from './arrBlocklist.ts';
import { readArrCommands, refreshArrItem, renameArrItem } from './arrCommands.ts';
import { readArrHistory } from './arrHistory.ts';
import { listArrImportCandidates, runArrManualImport } from './arrManualImport.ts';
import { readArrQueue, removeArrQueueItem } from './arrQueue.ts';
import { arrDiskSpace, arrFailedHealthChecks, arrScanState, arrStartLibraryScan, arrVersion } from './arrSystem.ts';
import {
    diagnoseConnection,
    type ArtistMonitorCapable,
    type ArtistMonitorNewItems,
    type ArtistMonitorPolicy,
    type BlocklistCapable,
    type BlocklistEntry,
    type CommandHandle,
    type CommandStatus,
    type CommandStatusCapable,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryQuery,
    type ImportCandidate,
    type ImportMapping,
    type LibraryCapable,
    type LibraryMaintenanceCapable,
    type LibraryScanCapable,
    type ManualImportCapable,
    type MediaDetailCapable,
    type MediaDetails,
    type MonitoringCapable,
    type MonitoringTarget,
    type MonitorState,
    type MonitorStateCapable,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RemoveQueueOptions,
    type ScanState,
    type ScanStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter,
    type Window
} from './types.ts';

/**
 * Whether Lidarr named a policy this code knows. Anything else stays `unknown`
 * rather than being read as the safe value.
 */
const isKnownNewItems = (value: string | undefined): value is ArtistMonitorNewItems =>
    value === 'all' || value === 'none' || value === 'new';

/**
 * The fields `listLibrary` reads. Named after `AlbumResource` in
 * `specs/lidarr.json`; anything not listed here is not needed by that mapper.
 */
type RawAlbum = {
    id?: number;
    title?: string;
    foreignAlbumId?: string;
    releaseDate?: string | null;
    albumType?: string;
    monitored?: boolean;
    genres?: string[];
    statistics?: { trackFileCount?: number; sizeOnDisk?: number };
    artist?: { id?: number; artistName?: string; qualityProfileId?: number; path?: string };
};

/**
 * The fields `listLibrary` reads, named after `ArtistResource` in
 * `specs/lidarr.json`. An artist is the row because it is the level the
 * MusicBrainz artist id lives at, and that id is what joins music to a media
 * server. Albums are one call below it — see `getMediaDetails`.
 */
type RawArtist = {
    id?: number;
    artistName?: string;
    foreignArtistId?: string;
    status?: string;
    monitored?: boolean;
    monitorNewItems?: string;
    added?: string;
    genres?: string[];
    path?: string;
    qualityProfileId?: number;
    statistics?: { trackFileCount?: number; sizeOnDisk?: number; albumCount?: number };
};

const yearOf = (releaseDate: string | null | undefined): number | undefined => {
    if (typeof releaseDate !== 'string') return undefined;
    const match = /^(\d{4})-\d{2}-\d{2}/.exec(releaseDate);
    return match?.[1] === undefined ? undefined : Number(match[1]);
};

/**
 * The artist's MusicBrainz id, which `ArtistResource.foreignArtistId` holds.
 *
 * This is the whole reason an artist is the row: Jellyfin and Plex both expose
 * the same id for an album artist, so the join that merges a *arr with a media
 * server finally has a key for music. Nothing is invented when it is absent — a
 * row with no MBID simply does not join.
 */
const artistIds = (artist: RawArtist): IndexInput['ids'] =>
    artist.foreignArtistId === undefined || artist.foreignArtistId === '' ? {} : { mbid: artist.foreignArtistId };

/**
 * The album's own MusicBrainz id, and the only external id Lidarr reports.
 * Nothing is invented as a fallback: the internal `id` is Lidarr's, and
 * publishing it as an external id would let an album fuse with a film that
 * happens to carry the same integer.
 */
const albumMbId = (album: RawAlbum): { mbid?: string } =>
    album.foreignAlbumId === undefined || album.foreignAlbumId === '' ? {} : { mbid: album.foreignAlbumId };

/** Any track on disk, which is what `has_file` means for a series too. */
const hasAnyTrack = (album: RawAlbum): boolean => (album.statistics?.trackFileCount ?? 0) > 0;

/**
 * The task whose last run is the last library scan: `RescanFolders`, Lidarr's
 * daily scan of every root folder for files (`TaskManager`, `DiskScanService`,
 * Lidarr 3.1.0).
 *
 * Not `RefreshArtist`, though that is Sonarr's `RefreshSeries` counterpart.
 * Sonarr's scheduled refresh rescans the disk unless "rescan after refresh"
 * forbids it, but Lidarr's also skips the rescan whenever the refresh updated
 * no metadata (`RefreshArtistService.RescanArtists`), so its last run can be
 * newer than the last time anything looked at the disk. Lidarr schedules the
 * disk scan as its own task instead, and that is the one this reads.
 *
 * A `trigger_scan` library scan still shows here: `startLibraryScan` sends
 * `RefreshArtist`, which runs as a manual command, and a manual refresh queues a
 * `RescanFolders` of every root folder unless "rescan artist folder after
 * refresh" is Never. Every `RescanFolders` run sets this task's time
 * (`TaskManager`), including the one Lidarr queues when an artist is added,
 * which scans that artist's folder alone.
 *
 * So the time is when a `RescanFolders` last finished, even one that failed
 * (`CommandExecutor` reports it either way), and not always a full scan; the
 * task list cannot tell which:
 * - A scan stops at a missing root folder and skips an empty one, but either
 *   way it completes (`DiskScanService.Scan`), so an unmounted music share can
 *   show a scan from today. Lidarr's root-folder health check, every six
 *   hours, reports a missing root folder that holds artists in `failures`; it
 *   does not report an empty one.
 * - The daily scan is scheduled from the last run (`TaskManager.GetPending`),
 *   so the one-folder scan after an artist is added also postpones it: an
 *   import list that adds an artist every day keeps the scheduled scan from
 *   running while the time stays recent, and the whole library is then read
 *   only when the daily `RefreshArtist` updates some metadata.
 * - A new install sets the time when it creates the task, so for up to a day
 *   it reports a scan that has not run.
 *
 * Matched exactly, never by pattern, for Sonarr's reason: a live Lidarr runs
 * `RefreshMonitoredDownloads` every minute, and a loose match would report the
 * library as scanned minutes ago.
 */
const LIBRARY_SCAN_TASK = 'RescanFolders';

/**
 * Lidarr. It claims `LibraryCapable`, `SearchCapable`, `MediaDetailCapable`,
 * `MonitoringCapable`, `MonitorStateCapable`, `ArtistMonitorCapable`,
 * `QueueCapable`, `QueueRemoveCapable`, `HistoryCapable` and
 * `BlocklistCapable`. The last four are the shared `arr*` helpers with
 * `kind: 'artist'`, so Lidarr's queue, history and blocklist read and write
 * the way Radarr's and Sonarr's do.
 * `CONTRIBUTING.md` lists the API traps for the adapter that adds the next
 * write, and the endpoints still waiting on a library with real activity.
 *
 * `LibraryScanCapable`, `LibraryMaintenanceCapable`, `ManualImportCapable` and
 * `CommandStatusCapable` are `trigger_scan`'s: rescan the library or refresh
 * one artist (the rescan after it still reads every root folder), rename an
 * artist's files, import a finished download by its id, and follow the command
 * in `stack_health`. All four are the shared helpers, with
 * `resource: 'artist'` where they take one; an import `mapping` is refused,
 * because it names movies and episodes.
 *
 * `DiskSpaceCapable`, `HealthCheckCapable` and `ScanStateCapable` are
 * `stack_health`'s: the disks, the failing health checks and the last library
 * scan, through the shared `arrDiskSpace`, `arrFailedHealthChecks` and
 * `arrScanState`.
 *
 * An artist is the row rather than a track or an album, for the reason Radarr
 * and Sonarr row on a film and a series: it is the level a person asks about,
 * it is what joins to a media server on the MusicBrainz artist id, and Lidarr
 * reports its monitoring, file state and add date. The albums are one call
 * down, under `getMediaDetails`, so the library stays 1,600 rows rather than
 * 36,000.
 *
 * It can be configured more than once, as `lidarr/<name>`. The id reaches
 * `ServiceHttp` and every error below, so a failure blames the instance that
 * failed rather than a bare `lidarr`.
 */
export class LidarrAdapter
    implements
        ServiceAdapter,
        LibraryCapable,
        SearchCapable,
        MediaDetailCapable,
        MonitoringCapable,
        MonitorStateCapable,
        ArtistMonitorCapable,
        QueueCapable,
        QueueRemoveCapable,
        HistoryCapable,
        BlocklistCapable,
        LibraryScanCapable,
        LibraryMaintenanceCapable,
        ManualImportCapable,
        CommandStatusCapable,
        DiskSpaceCapable,
        HealthCheckCapable,
        ScanStateCapable
{
    readonly type: ServiceId = 'lidarr';
    readonly instance: string | undefined;
    readonly id: string;

    readonly #http: ServiceHttp;

    /** The whole-album read, shared by every `listLibrary` in a snapshot. */
    readonly #libraryCache = new TtlCache();

    constructor(config: ConfigByService['lidarr'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('lidarr', config.name);
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl, {
            apiRoot: '/api/v1'
        });
    }

    async getVersion(): Promise<string> {
        return arrVersion(this.#http, this.id);
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        return arrDiskSpace(this.#http, this.id);
    }

    /** Only the checks that are failing; their text is fenced, as Radarr's and Sonarr's is. */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        return arrFailedHealthChecks(this.#http, this.id);
    }

    async getScanState(): Promise<ScanState> {
        return arrScanState(this.#http, this.id, LIBRARY_SCAN_TASK);
    }

    /** Every album, used by `getMediaDetails` for one artist's discography. */
    #albumsOf(artistId: number): Promise<RawAlbum[]> {
        return this.#libraryCache.get(`albums:${artistId}`, LIBRARY_TTL_MS, () =>
            this.#http.get<RawAlbum[]>(`/api/v1/album?artistId=${artistId}`)
        );
    }

    /** Every artist in the library, unfiltered. */
    #allArtists(): Promise<RawArtist[]> {
        return this.#libraryCache.get('artists', LIBRARY_TTL_MS, () => this.#http.get<RawArtist[]>('/api/v1/artist'));
    }

    invalidateLibrary(): void {
        this.#libraryCache.clear();
    }

    async listLibrary(): Promise<IndexInput[]> {
        const [artists, profileNames] = await Promise.all([
            this.#allArtists(),
            readProfileNames(this.#http, this.id, this.#libraryCache)
        ]);

        return artists
            // A row with no usable id is one nothing can be asked about, so it
            // is not a row — every other field on it would still be right.
            .filter((a): a is RawArtist & { id: number } => (a.id ?? 0) > 0)
            .map(artist => {
                const qualityProfileId = artist.qualityProfileId;
                return {
                    kind: 'artist' as const,
                    title: fenceText(artist.artistName ?? '', { service: this.id, field: 'title' }),
                    ids: artistIds(artist),
                    acquisition: {
                        service: this.id,
                        id: String(artist.id),
                        // Lidarr's own artist status: `continuing` or `ended`,
                        // passed through as Sonarr's is.
                        ...(artist.status === undefined ? {} : { status: artist.status }),
                        monitored: artist.monitored ?? false,
                        // Any track on disk, which is what `has_file` means for
                        // a series too.
                        hasFile: (artist.statistics?.trackFileCount ?? 0) > 0,
                        ...(qualityProfileId === undefined ? {} : { qualityProfileId }),
                        ...((name => (name === undefined ? {} : { qualityProfile: name }))(
                            qualityProfileId === undefined ? undefined : profileNames.get(qualityProfileId)
                        )),
                        ...(artist.path === undefined ? {} : { path: fenceText(artist.path, { service: this.id, field: 'path' }) }),
                        ...(artist.added === undefined ? {} : { addedAt: artist.added }),
                        ...(artist.statistics?.sizeOnDisk === undefined
                            ? {}
                            : { sizeBytes: artist.statistics.sizeOnDisk })
                    },
                    ...(artist.genres === undefined
                        ? {}
                        : { genres: artist.genres.map(g => fenceText(g, { service: this.id, field: 'genre' })) }),
                    // Album count is the one number an artist row owes a reader:
                    // "do I have their discography" is the music question, and
                    // `get_media_details` is where the albums themselves live.
                    ...(artist.statistics?.albumCount === undefined ? {} : { albumCount: artist.statistics.albumCount })
                };
            });
    }

    /**
     * `library` only. Lidarr's lookup endpoints return artists to add, and
     * nothing here adds music, so a discover search has no honest answer and
     * returns none.
     *
     * Matched on the artist name. Unlike Radarr and Sonarr there is no second
     * field to try: "Do I have any Daft Punk" is a library question and the
     * artist row is the answer. An album title is `get_media_details`'s read.
     */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];

        const term = query.toLowerCase();
        const artists = await this.#allArtists();

        return artists
            .filter((a): a is RawArtist & { id: number } => (a.id ?? 0) > 0)
            .filter(a => (a.artistName ?? '').toLowerCase().includes(term))
            .map(a => ({
                service: this.id,
                source,
                kind: 'artist' as const,
                id: String(a.id),
                title: fenceText(a.artistName ?? '', { service: this.id, field: 'title' }),
                ids: artistIds(a),
                hasFile: (a.statistics?.trackFileCount ?? 0) > 0,
                monitored: a.monitored ?? false
            }));
    }

    /**
     * One artist, with the albums under it.
     *
     * The library rows on artists, so this is where an album id comes from —
     * `set_monitoring` needs one for `level: "album"`, and nothing else in the
     * tool surface returns an album id once the library stopped rowing on
     * albums. Albums are only read at `detail: "full"`, matching episodes on a
     * series, and capped by the same limit.
     */
    async getMediaDetails(
        id: string,
        opts: { includeEpisodes: boolean; episodeLimit: number }
    ): Promise<MediaDetails> {
        const artistId = this.#numericId(id, 'artist');
        const artist = await this.#http.get<RawArtist>(`/api/v1/artist/${artistId}`);
        const title = fenceText(artist.artistName ?? '', { service: this.id, field: 'title' });

        const albums = opts.includeEpisodes ? (await this.#albumsOf(artistId)).filter(a => (a.id ?? 0) > 0) : [];

        return {
            service: this.id,
            kind: 'artist',
            id: String(artist.id ?? artistId),
            title,
            ...(artist.status === undefined ? {} : { status: artist.status }),
            monitored: artist.monitored ?? false,
            hasFile: (artist.statistics?.trackFileCount ?? 0) > 0,
            ...(artist.statistics?.sizeOnDisk === undefined ? {} : { sizeBytes: artist.statistics.sizeOnDisk }),
            ...(artist.path === undefined ? {} : { path: fenceText(artist.path, { service: this.id, field: 'path' }) }),
            ids: artistIds(artist),
            ...(artist.statistics?.albumCount === undefined ? {} : { albumCount: artist.statistics.albumCount }),
            ...(opts.includeEpisodes
                ? {
                      albums: albums.slice(0, opts.episodeLimit).map(album => ({
                          id: String(album.id),
                          title: fenceText(album.title ?? '', { service: this.id, field: 'title' }),
                          ...((year => (year === undefined ? {} : { year }))(yearOf(album.releaseDate))),
                          ...(album.albumType === undefined ? {} : { albumType: album.albumType }),
                          monitored: album.monitored ?? false,
                          hasFile: hasAnyTrack(album),
                          ...albumMbId(album)
                      })),
                      albumsTruncated: albums.length > opts.episodeLimit
                  }
                : {})
        };
    }

    /**
     * The two facts `set_monitoring` needs about one album, read from the album
     * itself rather than from the whole-library cache: a write must preview
     * against what Lidarr holds *now*, and a stale TTL row would let a stale
     * `monitored` stand in for the truth and report a real change as a no-op.
     */
    async getMonitorState(id: string): Promise<MonitorState> {
        const albumId = this.#numericId(id, 'album');
        const album = await this.#http.get<RawAlbum>(`/api/v1/album/${albumId}`);
        const title = fenceText(album.title ?? '', { service: this.id, field: 'title' });
        const artist = album.artist?.artistName;
        const year = yearOf(album.releaseDate);

        return {
            label: `${title}${artist === undefined ? '' : ` — ${fenceText(artist, { service: this.id, field: 'artist' })}`}${
                year === undefined ? '' : ` (${year})`
            }`,
            monitored: album.monitored ?? false
        };
    }

    /**
     * One album's own flag, via the endpoint built for it. Lidarr's album monitor
     * route takes a list; a single id is the one-element case rather than a
     * special one, so the bulk form stays available without a second path.
     */
    async setMonitoring(id: string, opts: MonitoringTarget): Promise<void> {
        this.refusePartialSelection({ season: opts.season, episodeIds: opts.episodeIds });

        const albumId = this.#numericId(id, 'album');
        await this.#http.put('/api/v1/album/monitor', { albumIds: [albumId], monitored: opts.monitored }, true);
        this.#libraryCache.clear();
    }

    /**
     * `season` and `episodeIds` are refused rather than ignored: an album has
     * neither, and a write that accepted them would report success while having
     * monitored the whole album the caller meant to leave alone.
     */
    refusePartialSelection(selection: { season?: number | undefined; episodeIds?: readonly string[] | undefined }): void {
        if (selection.season === undefined && selection.episodeIds === undefined) return;
        // A plain Error, like every other argument refusal in `set_monitoring`.
        // A `ServiceError` would prefix the service and read as "lidarr not
        // found", which is the confusion this whole class of refusal exists to
        // avoid.
        throw new Error(
            'A Lidarr album has no seasons and no episode ids. An album is monitored whole: send only `monitored`. ' +
                'Track-level selection is not a Lidarr concept.'
        );
    }

    /**
     * Every artist's standing policy. Read whole rather than one at a time: the
     * question is always "is anything still set to auto-monitor", which is a
     * question about the set, and Lidarr has no filtered artist read.
     */
    async listArtistMonitorPolicies(): Promise<ArtistMonitorPolicy[]> {
        const artists = await this.#http.get<RawArtist[]>('/api/v1/artist');

        return artists
            .filter((a): a is RawArtist & { id: number } => typeof a.id === 'number' && a.id > 0)
            .map(a => ({
                artistId: String(a.id),
                artistName: fenceText(a.artistName ?? '', { service: this.id, field: 'artist' }),
                monitored: a.monitored ?? false,
                monitorNewItems: isKnownNewItems(a.monitorNewItems) ? a.monitorNewItems : 'unknown'
            }));
    }

    /**
     * Lidarr's Artist Editor, which is the bulk path: one call reaches every
     * artist named, which is the only way a library of a thousand artists reaches
     * a stable policy without a thousand writes.
     *
     * An empty list issues nothing, for the same reason `deleteEpisodeFiles`
     * gives: an editor call naming no artist is a request with no purpose, and
     * Lidarr's behaviour for it is not worth discovering against a live library.
     */
    async setArtistMonitorPolicy(
        artistIds: string[],
        policy: { monitored?: boolean; monitorNewItems?: ArtistMonitorNewItems }
    ): Promise<void> {
        if (artistIds.length === 0) return;

        const ids = artistIds.map(id => this.#numericId(id, 'artist'));
        await this.#http.put(
            '/api/v1/artist/editor',
            {
                artistIds: ids,
                ...(policy.monitored === undefined ? {} : { monitored: policy.monitored }),
                ...(policy.monitorNewItems === undefined ? {} : { monitorNewItems: policy.monitorNewItems })
            },
            true
        );
        this.#libraryCache.clear();
    }

    readonly queueKind = 'artist';

    /**
     * Includes rows whose artist was deleted: they sit at importBlocked for
     * good, and are the ones a person most needs to see. Each one carries
     * `orphaned`, read from `artistId`.
     */
    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id, this.queueKind);
    }

    /** Lidarr keeps a blocklist, so `remove_queue_item`'s `blocklist` flag is honoured here. */
    readonly supportsBlocklist = true;

    /**
     * Lidarr's `DELETE /api/v1/queue/{id}`, with the two flags sent
     * explicitly. Blocklisting marks the download failed. With Lidarr's
     * "redownload failed" setting on (its default) that also starts a search
     * for the album again: `skipRedownload` is left at its default, false.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        return removeArrQueueItem(this.#http, this.id, id, opts);
    }

    /**
     * Scoped with `id` to one artist, through `artistIds`. An album or track id
     * would be a different namespace, and `get_history` does not take one.
     */
    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        return readArrHistory(this.#http, this.id, 'artist', opts);
    }

    /** `mediaId` on each row is the artist id, which `get_media_details` takes. */
    async readBlocklist(): Promise<BlocklistEntry[]> {
        return readArrBlocklist(this.#http, this.id, 'artist');
    }

    async removeBlocklistItem(id: string): Promise<void> {
        return removeArrBlocklistItem(this.#http, id);
    }

    /**
     * `RefreshArtist` with no ids refreshes every artist. Sent through the API
     * it runs as a manual command, so Lidarr then rescans their folders unless
     * "rescan artist folder after refresh" is set to Never (`RefreshArtistService`).
     */
    async startLibraryScan(): Promise<CommandHandle> {
        return arrStartLibraryScan(this.#http, this.id, 'RefreshArtist');
    }

    async refreshItem(id: string): Promise<CommandHandle> {
        return refreshArrItem(this.#http, this.id, 'artist', id);
    }

    /** Renames every file of the artist to Lidarr's own naming scheme. */
    async renameItem(id: string): Promise<CommandHandle> {
        return renameArrItem(this.#http, this.id, 'artist', id);
    }

    async listImportCandidates(downloadId: string, mapping?: ImportMapping[]): Promise<ImportCandidate[]> {
        return listArrImportCandidates(this.#http, this.id, 'artist', downloadId, mapping);
    }

    async runManualImport(downloadId: string, mapping?: ImportMapping[]): Promise<CommandHandle> {
        return runArrManualImport(this.#http, this.id, 'artist', downloadId, mapping);
    }

    async listCommands(): Promise<CommandStatus[]> {
        return readArrCommands(this.#http, this.id);
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    #numericId(value: string, what: string): number {
        const id = Number(value);
        if (!Number.isInteger(id)) {
            throw new ServiceError('NotFound', this.id, `"${value}" is not a Lidarr ${what} id`, {
                remedy: `Lidarr ${what} ids are integers. Take one from \`acquisition.id\` on get_library.`
            });
        }
        return id;
    }
}
