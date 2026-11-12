import type { ConfigByService } from '../config/schema.ts';
import { LIBRARY_TTL_MS } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText, fencer } from '../core/fence.ts';
import { ArrAdapterBase } from './arrBase.ts';
import { LIDARR_EXCLUSIONS, addExclusion, findExclusion, removeExclusion } from './arrExclusions.ts';
import type { ImportExclusion } from './types.ts';
import type { IndexInput } from '../core/resolver.ts';
import { readMetadataProfiles, readProfileNames, readQualityProfiles, readRootFolders, readTags } from './arrAdd.ts';
import { findArrBlocklistEntry, readArrBlocklist, removeArrBlocklistItem } from './arrBlocklist.ts';
import { awaitArrCommand, postArrCommand, readArrCommands, refreshArrItem, renameArrItem } from './arrCommands.ts';
import { arrGrabRecorded } from './arrDownloadTrace.ts';
import { readArrHistory } from './arrHistory.ts';
import { listArrImportCandidates, runArrManualImport } from './arrManualImport.ts';
import { deleteArrMedia, lidarrCalendarPath, readArrQueue, readLidarrCalendar, removeArrQueueItem } from './arrQueue.ts';
import { lidarrDate } from './arrRecord.ts';
import { findLidarrReleases, grabLidarrRelease } from './arrRelease.ts';
import { arrRecentLogs, arrStartLibraryScan } from './arrSystem.ts';
import { readArrWanted } from './arrWanted.ts';
import {
    type AddCandidate,
    type AddMediaOptions,
    type ArtistMonitorCapable,
    type ArtistMonitorNewItems,
    type ArtistMonitorPolicy,
    type BlocklistCapable,
    type BlocklistEntry,
    type CalendarCapable,
    type CalendarEntry,
    type CommandHandle,
    type CommandStatus,
    type CommandStatusCapable,
    type DeleteMediaOptions,
    type DiskSpaceCapable,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryQuery,
    type ImportCandidate,
    type ImportMapping,
    type LibraryCapable,
    type LibraryMaintenanceCapable,
    type LibraryScanCapable,
    type LogCapable,
    type ManualImportCapable,
    type MediaAddCapable,
    type MediaDeleteCapable,
    type MediaDetailCapable,
    type MediaDetails,
    type MediaUpdateCapable,
    type MediaUpdateOptions,
    type MediaUpdateState,
    type MetadataProfileCapable,
    type MonitoringCapable,
    type MonitoringTarget,
    type MonitorState,
    type MonitorStateCapable,
    type QualityProfile,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RecentLogs,
    type ReleaseCandidate,
    type ReleaseGrabCapable,
    type ReleaseScope,
    type ReleaseSearchCapable,
    type RemoveQueueOptions,
    type RetagFile,
    type RetagRun,
    type RootFolder,
    type ScanStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type SearchTarget,
    type SearchTriggerCapable,
    type ServiceAdapter,
    type Tag,
    type TagRepairCapable,
    type WantedCapable,
    type WantedItem,
    type WantedScope,
    type Window
} from './types.ts';

/** `RetagTrackResource`. */
type RawRetag = {
    trackFileId?: number;
    albumId?: number;
    path?: string;
    changes?: { field?: string; oldValue?: string; newValue?: string }[];
};

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
    artistId?: number;
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
    metadataProfileId?: number;
    tags?: number[];
    statistics?: { trackFileCount?: number; sizeOnDisk?: number; albumCount?: number };
};

/**
 * A MusicBrainz id, the only external id Lidarr adds by. `add_media` checks the
 * same shape before any call; this is the adapter's own guard.
 */
export const MUSICBRAINZ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read through `lidarrDate`, so an album with no release date has no year rather than year one. */
const yearOf = (releaseDate: string | null | undefined): number | undefined => {
    const match = /^(\d{4})-\d{2}-\d{2}/.exec(lidarrDate(releaseDate) ?? '');
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
 * in `get_stack_health`. All four are the shared helpers, with
 * `resource: 'artist'` where they take one; an import `mapping` is refused,
 * because it names movies and episodes.
 *
 * `DiskSpaceCapable`, `HealthCheckCapable`, `LogCapable` and `ScanStateCapable`
 * are `get_stack_health`'s: the disks, the failing health checks, the recent
 * warnings and errors and the last library scan, through the shared
 * `arrDiskSpace`, `arrFailedHealthChecks`, `arrRecentLogs` and `arrScanState`.
 * Lidarr's `/api/v1/log` takes the same `level=warn` filter and `time` sort as
 * Radarr's (`LogController`, 2.1.3 and 3.1.0).
 *
 * `WantedCapable` and `CalendarCapable` are `get_wanted`'s and
 * `get_calendar`'s: albums, through the shared `readArrWanted` with
 * `kind: 'artist'`, and through `readLidarrCalendar`, next to the Radarr and
 * Sonarr calendar readers in `arrQueue.ts`.
 *
 * `SearchTriggerCapable`, `ReleaseSearchCapable` and `ReleaseGrabCapable` are
 * `trigger_search`'s, `get_releases`' and `grab_release`'s: `ArtistSearch` or
 * `AlbumSearch`, and the release search and grab for the artist or one album,
 * through the shared `postArrCommand` and `arrRelease.ts`.
 *
 * `MediaAddCapable` and `MetadataProfileCapable` are `add_media`'s: an artist
 * added by its MusicBrainz id, with a metadata profile beside the quality
 * profile, root folder and tags. `get_instance_options` lists the last three,
 * as it does for the other services that add.
 *
 * `MediaUpdateCapable` is `update_media`'s: an artist's quality and metadata
 * profiles, root folder, monitoring and tags, changed through the Artist
 * Editor (see `updateMedia`).
 *
 * `MediaDeleteCapable` is `delete_media`'s: the whole artist, through the
 * shared `deleteArrMedia` with `resource: 'artist'`.
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
    extends ArrAdapterBase
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
        LogCapable,
        ScanStateCapable,
        WantedCapable,
        CalendarCapable,
        SearchTriggerCapable,
        ReleaseSearchCapable,
        ReleaseGrabCapable,
        MediaAddCapable,
        MetadataProfileCapable,
        MediaUpdateCapable,
        MediaDeleteCapable,
        TagRepairCapable
{
    protected readonly scanTask = LIBRARY_SCAN_TASK;

    constructor(config: ConfigByService['lidarr'], fetchImpl: typeof fetch = fetch) {
        super('lidarr', config, fetchImpl, { apiRoot: '/api/v1' });
    }

    async getRecentLogs(): Promise<RecentLogs> {
        return arrRecentLogs(this.http, this.id);
    }

    /** Every album, used by `getMediaDetails` for one artist's discography. */
    #albumsOf(artistId: number): Promise<RawAlbum[]> {
        return this.libraryCache.get(`albums:${artistId}`, LIBRARY_TTL_MS, () =>
            this.http.get<RawAlbum[]>(`/api/v1/album?artistId=${artistId}`)
        );
    }

    /** Every artist in the library, unfiltered. */
    #allArtists(): Promise<RawArtist[]> {
        return this.libraryCache.get('artists', LIBRARY_TTL_MS, () => this.http.get<RawArtist[]>('/api/v1/artist'));
    }

    async listLibrary(): Promise<IndexInput[]> {
        const [artists, profileNames] = await Promise.all([
            this.#allArtists(),
            readProfileNames(this.http, this.id, this.libraryCache)
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
     * `discover` is Lidarr's artist lookup, the list `add_media` adds from: a
     * hit not yet in the library carries its MusicBrainz id as `id`, as a
     * Radarr lookup carries its TMDB id, and in `ids.mbid` either way. Only
     * artists: an artist is what Lidarr adds.
     *
     * `library` is matched on the artist name. Unlike Radarr and Sonarr there
     * is no second field to try: "Do I have any Daft Punk" is a library
     * question and the artist row is the answer. An album title is
     * `get_media_details`'s read.
     */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source === 'discover') return this.#discover(query);
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
     * A query naming another service's id (`imdb:tt…`, `tmdb:603`) is not an
     * artist search. Lidarr has no such prefix and runs it as text: live on
     * 3.1.6, `imdb:tt0133093` answered an artist called "imdb".
     */
    async #discover(query: string): Promise<SearchHit[]> {
        if (/^\s*(?:imdb|tmdb|tvdb|tpdb):/i.test(query)) return [];
        const found = await this.http.get<unknown>(`/api/v1/artist/lookup?term=${encodeURIComponent(query)}`);
        if (!Array.isArray(found)) {
            throw new ServiceError('UpstreamError', this.id, '/api/v1/artist/lookup did not return an array');
        }

        return found
            .filter((a): a is RawArtist => typeof a === 'object' && a !== null)
            .filter(a => (a.id ?? 0) > 0 || (a.foreignArtistId ?? '') !== '')
            .map(a => {
                // `id` only for an artist already in the library: Lidarr 3.1.6
                // leaves it out for one that is not, and a 0 must not read as one.
                // No `hasFile`: the lookup maps the artist without its
                // statistics (`ArtistLookupController`), which came back all
                // zero on 2.1.3 and absent on 3.1.6 for an artist with tracks.
                const inLibrary = (a.id ?? 0) > 0;
                return {
                    service: this.id,
                    source: 'discover' as const,
                    kind: 'artist' as const,
                    id: inLibrary ? String(a.id) : (a.foreignArtistId ?? ''),
                    title: fenceText(a.artistName ?? '', { service: this.id, field: 'title' }),
                    ids: artistIds(a),
                    ...(inLibrary ? { monitored: a.monitored ?? false } : {})
                };
            });
    }

    /**
     * One artist, with the albums under it.
     *
     * The library rows on artists, so this is where an album id comes from —
     * `set_monitoring` needs one for `level: "album"` — though a `get_wanted`
     * row's `albumId` and a Lidarr `get_calendar` row's `id` name albums too.
     * Albums are only read at `detail: "full"`, matching episodes on a series,
     * and capped by the same limit.
     */
    async getMediaDetails(
        id: string,
        opts: { includeEpisodes: boolean; episodeLimit: number }
    ): Promise<MediaDetails> {
        const artistId = this.numericId('artist', id);
        const artist = await this.http.get<RawArtist>(`/api/v1/artist/${artistId}`);
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
        const albumId = this.numericId('album', id);
        const album = await this.http.get<RawAlbum>(`/api/v1/album/${albumId}`);
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

        const albumId = this.numericId('album', id);
        await this.http.put('/api/v1/album/monitor', { albumIds: [albumId], monitored: opts.monitored }, true);
        this.libraryCache.clear();
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
        const artists = await this.http.get<RawArtist[]>('/api/v1/artist');

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

        const ids = artistIds.map(id => this.numericId('artist', id));
        await this.http.put(
            '/api/v1/artist/editor',
            {
                artistIds: ids,
                ...(policy.monitored === undefined ? {} : { monitored: policy.monitored }),
                ...(policy.monitorNewItems === undefined ? {} : { monitorNewItems: policy.monitorNewItems })
            },
            true
        );
        this.libraryCache.clear();
    }

    readonly queueKind = 'artist';

    /**
     * Includes rows whose artist was deleted: they sit at importBlocked for
     * good, and are the ones a person most needs to see. Each one carries
     * `orphaned`, read from `artistId`.
     */
    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.http, this.id, this.queueKind);
    }

    /** Lidarr keeps a blocklist, so `remove_queue_item`'s `blocklist` flag is honoured here. */
    readonly supportsBlocklist = true;

    /**
     * Lidarr's `DELETE /api/v1/queue/{id}`, with the two flags sent
     * explicitly. Blocklisting a download that reached the client marks it
     * failed. With Lidarr's Redownload Failed setting on (its default) that
     * also starts a search for the album again: `skipRedownload` is left at its
     * default, false. `remove_queue_item` says when it blocklists nothing.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        return removeArrQueueItem(this.http, this.id, id, opts);
    }

    async grabRecorded(downloadId: string): Promise<boolean> {
        return arrGrabRecorded(this.http, this.id, downloadId);
    }

    /**
     * Scoped with `id` to one artist, through `artistIds`. An album or track id
     * would be a different namespace, and `get_history` does not take one.
     */
    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        return readArrHistory(this.http, this.id, 'artist', opts);
    }

    /** `mediaId` on each row is the artist id, which `get_media_details` takes. */
    async readBlocklist(want?: number): Promise<Window<BlocklistEntry>> {
        return readArrBlocklist(this.http, this.id, 'artist', want);
    }

    async findBlocklistItem(id: string): Promise<BlocklistEntry | undefined> {
        return findArrBlocklistEntry(this.http, this.id, 'artist', id);
    }

    async removeBlocklistItem(id: string): Promise<void> {
        return removeArrBlocklistItem(this.http, id);
    }

    /**
     * `RefreshArtist` with no ids refreshes every artist. Sent through the API
     * it runs as a manual command, so Lidarr then rescans their folders unless
     * "rescan artist folder after refresh" is set to Never (`RefreshArtistService`).
     */
    async startLibraryScan(): Promise<CommandHandle> {
        return arrStartLibraryScan(this.http, this.id, 'RefreshArtist');
    }

    async refreshItem(id: string): Promise<CommandHandle> {
        return refreshArrItem(this.http, this.id, 'artist', id);
    }

    /** Renames every file of the artist to Lidarr's own naming scheme. */
    async renameItem(id: string): Promise<CommandHandle> {
        return renameArrItem(this.http, this.id, 'artist', id);
    }

    async listImportCandidates(downloadId: string, mapping?: ImportMapping[]): Promise<ImportCandidate[]> {
        return listArrImportCandidates(this.http, this.id, 'artist', downloadId, mapping);
    }

    async runManualImport(downloadId: string, mapping?: ImportMapping[], paths?: string[]): Promise<CommandHandle> {
        return runArrManualImport(this.http, this.id, 'artist', downloadId, mapping, paths);
    }

    async listCommands(): Promise<CommandStatus[]> {
        return readArrCommands(this.http, this.id);
    }

    /**
     * Albums Lidarr is still looking for, or holds below the cutoff. Each row
     * names the artist as `id`, and the album as `albumId` and `albumTitle`.
     */
    async readWanted(scope: WantedScope, want?: number): Promise<Window<WantedItem>> {
        return readArrWanted(this.http, this.id, 'artist', scope, want);
    }

    /** Albums released in the window, each with its artist. Monitored only, as Lidarr's own calendar is. */
    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const albums = await this.http.get<Parameters<typeof readLidarrCalendar>[0]>(
            lidarrCalendarPath(this.http.apiRoot, range)
        );
        return readLidarrCalendar(albums, this.id);
    }

    /**
     * `ArtistSearch` takes a bare `artistId` and `AlbumSearch` an `albumIds`
     * array, the same asymmetry as Sonarr's `SeriesSearch` and `EpisodeSearch`.
     * `trigger_search` checks the albums belong to the artist before this runs.
     */
    async triggerSearch(id: string, target?: SearchTarget): Promise<CommandHandle> {
        this.#refuseSeasons(target?.season !== undefined || target?.episodes !== undefined);
        const artistId = this.numericId('artist', id);
        if (target?.albums === undefined) return postArrCommand(this.http, this.id, { name: 'ArtistSearch', artistId });
        // An album named twice is searched once: Lidarr would search it twice.
        const albumIds = [...new Set(target.albums)].map(album => this.numericId('album', album));
        return postArrCommand(this.http, this.id, { name: 'AlbumSearch', albumIds });
    }

    /**
     * The whole artist, or one album when `album` is given. Lidarr searches an
     * album by its id alone, so the album is read first and must be the
     * artist's: a mismatched pair would list releases for, and `grab_release`
     * would then grab for, an artist the caller never named.
     */
    async findReleases(opts: ReleaseScope): Promise<ReleaseCandidate[]> {
        this.#refuseSeasons(opts.season !== undefined || opts.episode !== undefined);
        const artistId = this.numericId('artist', opts.id);
        if (opts.album === undefined) return findLidarrReleases(this.http, this.id, { artistId });

        const albumId = this.numericId('album', opts.album);
        const album = await this.http.get<RawAlbum>(`/api/v1/album/${albumId}`);
        if (album.artistId !== artistId) {
            throw new ServiceError('NotFound', this.id, `album ${albumId} is not one of artist ${artistId}'s albums`, {
                remedy: 'Take the album id from get_media_details on that artist, at detail: "full".'
            });
        }
        return findLidarrReleases(this.http, this.id, { artistId, albumId });
    }

    /** Given the release-search timeout: see `grabLidarrRelease`. */
    async grabRelease(opts: { guid: string; indexerId: number }): Promise<void> {
        await grabLidarrRelease(this.http, this.id, opts);
    }

    async listQualityProfiles(): Promise<QualityProfile[]> {
        return readQualityProfiles(this.http, this.id);
    }

    /** Each carries the metadata profile it names as its default, if any. */
    async listRootFolders(): Promise<RootFolder[]> {
        return readRootFolders(this.http, this.id);
    }

    async listTags(): Promise<Tag[]> {
        return readTags(this.http, this.id);
    }

    async listMetadataProfiles(): Promise<QualityProfile[]> {
        return readMetadataProfiles(this.http, this.id);
    }

    async findImportExclusion(externalId: string): Promise<ImportExclusion | undefined> {
        return findExclusion(this.http, LIDARR_EXCLUSIONS, externalId);
    }

    async addImportExclusion(externalId: string, label: { title: string; year?: number }): Promise<void> {
        await addExclusion(this.http, LIDARR_EXCLUSIONS, externalId, label);
    }

    async removeImportExclusion(exclusionId: number): Promise<void> {
        await removeExclusion(this.http, LIDARR_EXCLUSIONS, exclusionId);
    }

    async lookupForAdd(externalId: string): Promise<AddCandidate> {
        const raw = await this.#lookupArtist(externalId);
        return {
            title: fenceText(raw.artistName ?? '', { service: this.id, field: 'title' }),
            ...((raw.id ?? 0) > 0 ? { existingId: raw.id } : {}),
            // An artist has neither a TMDB nor a TVDB id, and the cross-checks
            // these feed speak for Radarr and Sonarr only.
            ids: {}
        };
    }

    /**
     * The lookup body, posted back with this server's choices on top, as
     * Radarr's and Sonarr's adds post theirs. `id` and `path` are dropped: the
     * lookup's `path` is a guess that `rootFolderPath` replaces, and an `id`
     * would read as an existing artist.
     *
     * `monitor: "none"` also adds the artist itself unmonitored
     * (`AddArtistService`), which is why `add_media` refuses it unless
     * `monitored: false` says so.
     */
    async addMedia(opts: AddMediaOptions): Promise<{ id: number; title: string }> {
        if (opts.metadataProfileId === undefined) {
            throw new ServiceError('NotFound', this.id, 'Lidarr needs a metadata profile to add an artist', {
                remedy: 'Name one with `metadata_profile`.'
            });
        }

        const raw = await this.#lookupArtist(opts.externalId);
        if ((raw.id ?? 0) > 0) {
            throw new ServiceError('UpstreamError', this.id, 'that artist is already in lidarr', {
                remedy: 'It was added between the preview and the confirmation, so nothing was changed here.'
            });
        }

        const { id: _id, path: _path, ...rest } = raw;
        const created = await this.http.post<RawArtist>('/api/v1/artist', {
            ...rest,
            qualityProfileId: opts.qualityProfileId,
            metadataProfileId: opts.metadataProfileId,
            rootFolderPath: opts.rootFolderPath,
            monitored: opts.monitored,
            ...(opts.monitorNewItems === undefined ? {} : { monitorNewItems: opts.monitorNewItems }),
            tags: opts.tagIds ?? [],
            addOptions: {
                ...(opts.monitor === undefined ? {} : { monitor: opts.monitor }),
                searchForMissingAlbums: opts.searchNow
            }
        });
        if (typeof created.id !== 'number' || created.id <= 0) {
            throw new ServiceError('UpstreamError', this.id, 'lidarr returned no id for the added artist', {
                remedy: 'It may still have been added — check with search_media before trying again.'
            });
        }

        this.libraryCache.clear();
        return { id: created.id, title: fenceText(created.artistName ?? '', { service: this.id, field: 'title' }) };
    }

    /** Read from the artist itself, not the library cache: a write must
     *  preview against what Lidarr holds now. */
    async readForUpdate(id: string): Promise<MediaUpdateState> {
        const artistId = this.numericId('artist', id);
        return this.#updateState(await this.http.get<RawArtist>(`/api/v1/artist/${artistId}`));
    }

    /**
     * Through Lidarr's Artist Editor, `PUT /artist/editor`, as `update_media`
     * writes an artist's policy, not `PUT /artist/{id}`: that one replaces the
     * whole artist and queues a `MoveArtist` on every call, even with
     * `moveFiles=false` and the path unchanged, where the editor moves only
     * when given a root folder. The editor sets only the fields it is sent, so
     * there is nothing to read back first, and `tags` replace the set as on
     * Radarr and Sonarr (`applyTags: "replace"`).
     *
     * Unlike `PUT /artist/{id}`, the editor publishes no `ArtistEditedEvent`,
     * so a new metadata profile starts no refresh: it applies at the artist's
     * next one (`ArtistEditedService`, `ArtistService.UpdateArtists`).
     */
    async updateMedia(id: string, opts: MediaUpdateOptions): Promise<MediaUpdateState> {
        const artistId = this.numericId('artist', id);
        const updated = await this.http.put<RawArtist[]>('/api/v1/artist/editor', {
            artistIds: [artistId],
            ...(opts.monitored === undefined ? {} : { monitored: opts.monitored }),
            ...(opts.qualityProfileId === undefined ? {} : { qualityProfileId: opts.qualityProfileId }),
            ...(opts.metadataProfileId === undefined ? {} : { metadataProfileId: opts.metadataProfileId }),
            ...(opts.rootFolderPath === undefined ? {} : { rootFolderPath: opts.rootFolderPath }),
            ...(opts.tagIds === undefined ? {} : { tags: opts.tagIds, applyTags: 'replace' }),
            // Only ever true beside a new root folder, as on Radarr and Sonarr.
            moveFiles: opts.rootFolderPath !== undefined && opts.moveFiles
        });
        this.libraryCache.clear();

        // The editor answers with the artists it updated. A build that answers
        // something else is read back rather than reported as every field cleared.
        const row = Array.isArray(updated) ? updated.find(a => a.id === artistId) : undefined;
        return row === undefined ? this.readForUpdate(id) : this.#updateState(row);
    }

    #updateState(raw: RawArtist): MediaUpdateState {
        return {
            title: fenceText(raw.artistName ?? '', { service: this.id, field: 'title' }),
            monitored: raw.monitored ?? false,
            ...(raw.qualityProfileId === undefined ? {} : { qualityProfileId: raw.qualityProfileId }),
            ...(raw.metadataProfileId === undefined ? {} : { metadataProfileId: raw.metadataProfileId }),
            ...(isKnownNewItems(raw.monitorNewItems) ? { monitorNewItems: raw.monitorNewItems } : {}),
            ...(raw.path === undefined ? {} : { path: fenceText(raw.path, { service: this.id, field: 'path' }) }),
            tagIds: raw.tags ?? []
        };
    }

    /**
     * Lidarr's exact-id lookup, `lidarr:<mbid>`: it answers the library's own
     * artist when there is one, carrying its `id`, and otherwise the metadata
     * server's (`SkyHookProxy.SearchForNewArtist`). An unknown id answers `[]`.
     */
    async #lookupArtist(externalId: string): Promise<RawArtist> {
        if (!MUSICBRAINZ_ID.test(externalId)) {
            throw new ServiceError('NotFound', this.id, `"${externalId}" is not a MusicBrainz artist id`, {
                remedy: 'Lidarr adds by MusicBrainz artist id, a GUID. search_media `source: "discover"` returns one under `ids.mbid`.'
            });
        }

        const mbid = externalId.toLowerCase();
        const found = await this.http.get<unknown>(`/api/v1/artist/lookup?term=lidarr:${mbid}`);
        const first: unknown = Array.isArray(found) ? found[0] : undefined;
        const artist = typeof first === 'object' && first !== null ? (first as RawArtist) : undefined;
        // The library's own artist also answers an id it used to have
        // (`ArtistRepository.FindById` reads `OldForeignArtistIds`), under its
        // current id. It is still that artist, so it is reported as already there.
        const inLibrary = (artist?.id ?? 0) > 0;
        if (
            artist === undefined ||
            typeof artist.artistName !== 'string' ||
            (!inLibrary && (artist.foreignArtistId ?? '').toLowerCase() !== mbid)
        ) {
            throw new ServiceError('NotFound', this.id, `MusicBrainz artist ${mbid} matched nothing`, {
                remedy: 'Check the id with search_media `source: "discover"`. An artist merged on MusicBrainz answers under its new id, so look it up again by name.'
            });
        }
        return artist;
    }

    /**
     * The whole artist, with Lidarr's own flags: `deleteFiles` and
     * `addImportListExclusion`, Sonarr's spelling of the exclusion.
     */
    async deleteMedia(id: string, opts: DeleteMediaOptions): Promise<void> {
        await deleteArrMedia(this.http, this.id, 'artist', id, opts);
        this.libraryCache.clear();
    }

    /**
     * Lidarr's own retag preview: only the files whose embedded tags differ
     * from its metadata (`RetagTrackController`). A tag the file lacks comes
     * with no `oldValue`, read here as empty.
     */
    async previewRetag(id: string, albumId?: number): Promise<RetagFile[]> {
        const artistId = this.numericId('artist', id);
        // With `albumId`, Lidarr reads that album's files alone and ignores the
        // artist (`RetagTrackController`, the same on 2.1.3).
        const album = albumId === undefined ? '' : `&albumId=${this.numericId('album', String(albumId))}`;
        const rows = await this.http.get<RawRetag[]>(`/api/v1/retag?artistId=${artistId}${album}`);
        if (!Array.isArray(rows)) {
            throw new ServiceError('UpstreamError', this.id, '/api/v1/retag did not return an array');
        }
        const fence = fencer(this.id);
        return rows
            .filter((r): r is RawRetag & { trackFileId: number } => typeof r?.trackFileId === 'number')
            .map(r => ({
                trackFileId: r.trackFileId,
                ...(typeof r.albumId === 'number' && Number.isInteger(r.albumId) && r.albumId > 0 ? { albumId: r.albumId } : {}),
                path: fence(r.path ?? '', 'path'),
                changes: (r.changes ?? []).map(c => ({
                    field: c.field ?? '',
                    oldValue: fence(c.oldValue ?? '', 'oldValue'),
                    newValue: fence(c.newValue ?? '', 'newValue')
                }))
            }));
    }

    /** A setting Lidarr did not report stays unknown rather than read as off: off is the value that drops the scrub warning. */
    async readTagSettings(): Promise<{ scrubAudioTags: boolean | undefined; writeAudioTags: string }> {
        const config = await this.http.get<{ scrubAudioTags?: unknown; writeAudioTags?: unknown } | null>('/api/v1/config/metadataprovider');
        const scrub = config?.scrubAudioTags;
        const write = config?.writeAudioTags;
        return { scrubAudioTags: typeof scrub === 'boolean' ? scrub : undefined, writeAudioTags: typeof write === 'string' ? write : 'unknown' };
    }

    /**
     * `RetagFiles` for those track files, waited on. It writes with `force`, so
     * it runs whatever "Tag Audio Files with Metadata" says, as Lidarr's own
     * Retag button does (`AudioTagService`). Once Lidarr has queued it, a wait
     * that fails is not a write that failed: the command can still run.
     */
    async retagFiles(id: string, trackFileIds: readonly number[]): Promise<RetagRun> {
        const artistId = this.numericId('artist', id);
        const handle = await postArrCommand(this.http, this.id, { name: 'RetagFiles', artistId, files: [...trackFileIds] });
        let row: Awaited<ReturnType<typeof awaitArrCommand>>;
        try {
            row = await awaitArrCommand(this.http, this.id, handle.commandId);
        } catch (err) {
            return { settled: false, commandId: handle.commandId, reason: err instanceof Error ? err.message : String(err) };
        }
        return {
            settled: true,
            status: row.status,
            ...(row.message === undefined ? {} : { message: fenceText(row.message, { service: this.id, field: 'message' }) })
        };
    }

    /** An artist has albums, not seasons or episodes. Refused rather than
     *  widened, which would search the whole artist instead. */
    #refuseSeasons(given: boolean): void {
        if (!given) return;
        throw new ServiceError('NotFound', this.id, 'a Lidarr artist has no seasons or episodes', {
            remedy: 'Drop `season` and `episode`. To search specific albums, pass their ids: `albums` on trigger_search, `album` on get_releases and grab_release.'
        });
    }
}
