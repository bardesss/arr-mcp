import { aliasesOf } from '../core/titleMatch.ts';
import type { ConfigByService } from '../config/schema.ts';
import { LIBRARY_TTL_MS } from '../core/cache.ts';
import { ArrAdapterBase } from './arrBase.ts';
import { fenceText } from '../core/fence.ts';
import type { RawImage } from '../core/display.ts';
import { arrDisplay } from './arrDisplay.ts';
import type { IndexInput } from '../core/resolver.ts';
import {
    addArrMedia,
    lookupArrForAdd,
    RADARR_ADD,
    readProfileNames,
    readQualityProfiles,
    readRootFolders,
    readTags
} from './arrAdd.ts';
import { readArrProfileDiagnostics } from './arrProfiles.ts';
import { readArrHistory } from './arrHistory.ts';
import { traceArrDownload } from './arrDownloadTrace.ts';
import { postArrCommand, readArrCommands, refreshArrItem, renameArrItem } from './arrCommands.ts';
import { listArrImportCandidates, runArrManualImport } from './arrManualImport.ts';
import { readArrForUpdate, updateArrMedia } from './arrUpdate.ts';
import { calendarPath, deleteArrMedia, readArrQueue, readRadarrCalendar, removeArrQueueItem } from './arrQueue.ts';
import { findArrBlocklistEntry, readArrBlocklist, removeArrBlocklistItem } from './arrBlocklist.ts';
import { readSeedCriteria } from './arrSeedCriteria.ts';
import { findArrReleases, grabArrRelease } from './arrRelease.ts';
import { readArrWanted } from './arrWanted.ts';
import { readAudioLanguages, type RawMediaInfo } from './arrMediaInfo.ts';
import { flattenRatings, toMergedRatings, type RawRating } from './arrRatings.ts';
import { arrRecentLogs, arrStartLibraryScan } from './arrSystem.ts';
import {
    type BlocklistEntry,
    type IndexerSeedCriteria,
    type SeedCriteriaCapable,
    type CalendarCapable,
    type CalendarEntry,
    type DiskSpaceCapable,
    type DownloadTrace,
    type DownloadTraceCapable,
    type HealthCheckCapable,
    type LogCapable,
    type RecentLogs,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryQuery,
    type LibraryCapable,
    type MediaDetailCapable,
    type MediaDetails,
    type QueueCapable,
    type QueueItem,
    type ScanStateCapable,
    type AddCandidate,
    type AddMediaOptions,
    type CommandHandle,
    type CommandStatus,
    type CommandStatusCapable,
    type DeleteMediaOptions,
    type MediaAddCapable,
    type ImportCandidate,
    type ImportMapping,
    type LibraryMaintenanceCapable,
    type ManualImportCapable,
    type MediaUpdateCapable,
    type MediaUpdateOptions,
    type MediaUpdateState,
    type MediaDeleteCapable,
    type ProfileDiagnosticsCapable,
    type ProfileDiagnosticsData,
    type QualityProfile,
    type QueueRemoveCapable,
    type ReleaseCandidate,
    type ReleaseScope,
    type ReleaseSearchCapable,
    type RootFolder,
    type Tag,
    type RemoveQueueOptions,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type SearchTriggerCapable,
    type ServiceAdapter,
    type WantedCapable,
    type WantedItem,
    type WantedScope,
    type Window
} from './types.ts';

type RawMovie = {
    id?: number;
    title?: string;
    /** In the film's own language; `title` follows Radarr's metadata language. */
    originalTitle?: string | null;
    alternateTitles?: { title?: string | null }[] | null;
    year?: number;
    overview?: string;
    monitored?: boolean;
    status?: string;
    hasFile?: boolean;
    path?: string;
    tmdbId?: number;
    imdbId?: string;
    genres?: string[];
    qualityProfileId?: number;
    ratings?: Record<string, RawRating>;
    /** Minutes; `0` when Radarr does not know. */
    runtime?: number;
    images?: RawImage[] | null;
    added?: string | null;
    movieFile?: { size?: number; quality?: { quality?: { name?: string } }; mediaInfo?: RawMediaInfo };
};

/**
 * The task that actually rescans the film library, confirmed against a live
 * Radarr 6.3.0 during a live capture.
 *
 * Matched exactly, never by pattern. A live instance runs eleven scheduled
 * tasks, three of which contain "Refresh": `RefreshMovie` is the library scan,
 * but `RefreshMonitoredDownloads` polls the download queue every minute and
 * `RefreshCollections` syncs collections. Taking the most recent match
 * reported the library as scanned a minute ago when it had in fact been
 * scanned 23 hours earlier — scan staleness that can never look stale is worse
 * than not reporting it at all.
 */
const LIBRARY_SCAN_TASK = 'RefreshMovie';

export class RadarrAdapter
    extends ArrAdapterBase
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        HealthCheckCapable,
        LogCapable,
        ScanStateCapable,
        QueueCapable,
        CalendarCapable,
        MediaDetailCapable,
        SearchCapable,
        LibraryCapable,
        SearchTriggerCapable,
        QueueRemoveCapable,
        MediaDeleteCapable,
        MediaAddCapable,
        MediaUpdateCapable,
        LibraryMaintenanceCapable,
        CommandStatusCapable,
        ManualImportCapable,
        HistoryCapable,
        DownloadTraceCapable,
        WantedCapable,
        ReleaseSearchCapable,
        ProfileDiagnosticsCapable,
        SeedCriteriaCapable
{
    protected readonly scanTask = LIBRARY_SCAN_TASK;

    constructor(config: ConfigByService['radarr'], fetchImpl: typeof fetch = fetch) {
        super('radarr', config, fetchImpl);
    }

    async getRecentLogs(): Promise<RecentLogs> {
        return arrRecentLogs(this.http, this.id);
    }

    async startLibraryScan(): Promise<CommandHandle> {
        return arrStartLibraryScan(this.http, this.id, 'RefreshMovie');
    }

    readonly queueKind = 'movie';

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.http, this.id, this.queueKind);
    }

    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        return readArrHistory(this.http, this.id, 'movie', opts);
    }

    async traceDownload(downloadId: string): Promise<DownloadTrace | undefined> {
        return traceArrDownload(this.http, this.id, 'movie', downloadId);
    }

    async readWanted(scope: WantedScope, want?: number): Promise<Window<WantedItem>> {
        return readArrWanted(this.http, this.id, 'movie', scope, want);
    }

    async findReleases(opts: ReleaseScope): Promise<ReleaseCandidate[]> {
        return findArrReleases(this.http, this.id, 'movie', opts);
    }

    async grabRelease(opts: { guid: string; indexerId: number }): Promise<void> {
        return grabArrRelease(this.http, opts);
    }

    async readBlocklist(want?: number): Promise<Window<BlocklistEntry>> {
        return readArrBlocklist(this.http, this.id, 'movie', want);
    }

    async findBlocklistItem(id: string): Promise<BlocklistEntry | undefined> {
        return findArrBlocklistEntry(this.http, this.id, 'movie', id);
    }

    async getSeedCriteria(): Promise<IndexerSeedCriteria[]> {
        return readSeedCriteria(this.http, this.id, 'arr');
    }

    async removeBlocklistItem(id: string): Promise<void> {
        return removeArrBlocklistItem(this.http, id);
    }

    readonly supportsBlocklist = true;

    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        return removeArrQueueItem(this.http, this.id, id, opts);
    }

    async deleteMedia(id: string, opts: DeleteMediaOptions): Promise<void> {
        return deleteArrMedia(this.http, this.id, 'movie', id, opts);
    }

    async listQualityProfiles(): Promise<QualityProfile[]> {
        return readQualityProfiles(this.http, this.id);
    }

    async listRootFolders(): Promise<RootFolder[]> {
        return readRootFolders(this.http, this.id);
    }

    async listTags(): Promise<Tag[]> {
        return readTags(this.http, this.id);
    }

    async readProfileDiagnostics(): Promise<ProfileDiagnosticsData> {
        return readArrProfileDiagnostics(this.http);
    }

    async listCommands(): Promise<CommandStatus[]> {
        return readArrCommands(this.http, this.id);
    }

    async listImportCandidates(downloadId: string, mapping?: ImportMapping[]): Promise<ImportCandidate[]> {
        return listArrImportCandidates(this.http, this.id, 'movie', downloadId, mapping);
    }

    async runManualImport(downloadId: string, mapping?: ImportMapping[], paths?: string[]): Promise<CommandHandle> {
        return runArrManualImport(this.http, this.id, 'movie', downloadId, mapping, paths);
    }

    async refreshItem(id: string): Promise<CommandHandle> {
        return refreshArrItem(this.http, this.id, 'movie', id);
    }

    async renameItem(id: string): Promise<CommandHandle> {
        return renameArrItem(this.http, this.id, 'movie', id);
    }

    async readForUpdate(id: string): Promise<MediaUpdateState> {
        return readArrForUpdate(this.http, this.id, 'movie', id);
    }

    async updateMedia(id: string, opts: MediaUpdateOptions): Promise<MediaUpdateState> {
        return updateArrMedia(this.http, this.id, 'movie', id, opts);
    }

    /** Radarr resolves by TMDB id; a TVDB id will simply match nothing. */
    async lookupForAdd(externalId: string): Promise<AddCandidate> {
        return lookupArrForAdd(this.http, this.id, RADARR_ADD, externalId);
    }

    async addMedia(opts: AddMediaOptions): Promise<{ id: number; title: string }> {
        return addArrMedia(this.http, this.id, RADARR_ADD, opts);
    }

    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const movies = await this.http.get<Parameters<typeof readRadarrCalendar>[0]>(calendarPath(this.http.apiRoot, range));
        return readRadarrCalendar(movies, this.id);
    }

    async getMediaDetails(id: string): Promise<MediaDetails> {
        const m = await this.http.get<RawMovie>(`/api/v3/movie/${this.numericId('movie', id)}`);
        const ratings = flattenRatings(m.ratings);
        // No second read, unlike Sonarr's: Radarr embeds the file in the movie.
        const audioLanguages = readAudioLanguages(m.movieFile?.mediaInfo);

        return {
            service: this.id,
            kind: 'movie',
            id,
            title: fenceText(m.title ?? '', { service: this.id, field: 'title' }),
            ...(m.year === undefined ? {} : { year: m.year }),
            ...(m.overview === undefined
                ? {}
                : { overview: fenceText(m.overview, { service: this.id, field: 'overview' }) }),
            ...(m.monitored === undefined ? {} : { monitored: m.monitored }),
            ...(m.status === undefined ? {} : { status: m.status }),
            ...(m.hasFile === undefined ? {} : { hasFile: m.hasFile }),
            ...(audioLanguages === undefined ? {} : { audioLanguages }),
            ...(m.movieFile?.size === undefined ? {} : { sizeBytes: m.movieFile.size }),
            ...(m.movieFile?.quality?.quality?.name === undefined
                ? {}
                : { quality: m.movieFile.quality.quality.name }),
            ...(m.path === undefined ? {} : { path: fenceText(m.path, { service: this.id, field: 'path' }) }),
            ids: {
                ...(m.tmdbId === undefined ? {} : { tmdb: m.tmdbId }),
                ...(m.imdbId === undefined ? {} : { imdb: m.imdbId })
            },
            ...(ratings === undefined ? {} : { ratings }),
            ...((display => (display === undefined ? {} : { display }))(arrDisplay(m, this.id, 'movie')))
        };
    }

    /**
     * Safe tier: it asks Radarr to look for releases for a film it already
     * tracks. Nothing is deleted or added, and the worst outcome is an unwanted
     * grab, which the queue tools can undo.
     *
     * The id is checked by `arrItemId` and sent as a number: `movieIds` is a
     * JSON array of integers, and a string there is silently accepted by Radarr
     * and matches nothing, which would report a successful search that never
     * ran.
     */
    async triggerSearch(id: string): Promise<CommandHandle> {
        const movieId = this.numericId('movie', id);

        return postArrCommand(this.http, this.id, { name: 'MoviesSearch', movieIds: [movieId] });
    }

    /** The `/api/v3/movie` read behind both `search(_, 'library')` and
     *  `listLibrary` — Radarr has no server-side filter, so both need the
     *  whole list, and this is where they share one fetch for it. */
    #allMovies(): Promise<RawMovie[]> {
        return this.libraryCache.get('movies', LIBRARY_TTL_MS, () => this.http.get<RawMovie[]>('/api/v3/movie'));
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        const term = query.toLowerCase();

        if (source === 'library') {
            // Radarr has no library search endpoint, so this filters the whole
            // list. `#allMovies` caches that read, shared with `listLibrary`.
            const movies = await this.#allMovies();
            return movies.filter(m => (m.title ?? '').toLowerCase().includes(term)).map(m => this.#toHit(m, 'library'));
        }

        if (source === 'discover') {
            const found = await this.http.get<RawMovie[]>(
                `/api/v3/movie/lookup?term=${encodeURIComponent(query)}`
            );
            return found.map(m => this.#toHit(m, 'discover'));
        }

        return [];
    }

    #toHit(m: RawMovie, source: SearchSource): SearchHit {
        return {
            service: this.id,
            source,
            kind: 'movie',
            // `?? ` alone would keep a zero: a lookup omits `id` for something
            // not in the library, but a build that sends 0 instead must not
            // produce the id "0". Matches arrAdd's own `> 0` guard.
            id: String((m.id !== undefined && m.id > 0 ? m.id : undefined) ?? m.tmdbId ?? ''),
            title: fenceText(m.title ?? '', { service: this.id, field: 'title' }),
            ...(m.year === undefined ? {} : { year: m.year }),
            ids: {
                ...(m.tmdbId === undefined ? {} : { tmdb: m.tmdbId }),
                ...(m.imdbId === undefined ? {} : { imdb: m.imdbId })
            },
            ...(m.hasFile === undefined ? {} : { hasFile: m.hasFile }),
            ...(m.monitored === undefined ? {} : { monitored: m.monitored }),
            ...((display => (display === undefined ? {} : { display }))(
                arrDisplay(m, this.id, 'movie', { lookup: source === 'discover' })
            ))
        };
    }

    /**
     * The whole film library in one call — Radarr has no server-side filter, so
     * this is the same `/api/v3/movie` read `search` already does, via `#allMovies`.
     */
    async listLibrary(): Promise<IndexInput[]> {
        const [movies, profileNames] = await Promise.all([this.#allMovies(), readProfileNames(this.http, this.id, this.libraryCache)]);

        return movies.map(m => ({
            kind: 'movie' as const,
            title: fenceText(m.title ?? '', { service: this.id, field: 'title' }),
            ...((aliases => (aliases.length === 0 ? {} : { aliases }))(
                aliasesOf(m.title, [m.originalTitle, ...(m.alternateTitles ?? []).map(a => a.title)])
            )),
            ...(m.year === undefined ? {} : { year: m.year }),
            ...(m.genres === undefined
                ? {}
                : { genres: m.genres.map(g => fenceText(g, { service: this.id, field: 'genre' })) }),
            ids: {
                ...(m.tmdbId === undefined ? {} : { tmdb: m.tmdbId }),
                ...(m.imdbId === undefined ? {} : { imdb: m.imdbId })
            },
            acquisition: {
                service: this.id,
                // `> 0` for the reason `#toHit` gives: a build that sends 0
                // instead of omitting the field must not produce the id "0".
                ...(m.id === undefined || m.id <= 0 ? {} : { id: String(m.id) }),
                ...(m.status === undefined ? {} : { status: m.status }),
                monitored: m.monitored ?? false,
                hasFile: m.hasFile ?? false,
                ...(m.qualityProfileId === undefined ? {} : { qualityProfileId: m.qualityProfileId }),
                ...((name => (name === undefined ? {} : { qualityProfile: name }))(
                    m.qualityProfileId === undefined ? undefined : profileNames.get(m.qualityProfileId)
                )),
                ...(m.path === undefined ? {} : { path: fenceText(m.path, { service: this.id, field: 'path' }) }),
                ...(m.added === undefined || m.added === null ? {} : { addedAt: m.added }),
                ...(m.movieFile?.quality?.quality?.name === undefined
                    ? {}
                    : { quality: m.movieFile.quality.quality.name }),
                ...(m.movieFile?.size === undefined ? {} : { sizeBytes: m.movieFile.size })
            },
            ...((r => (r === undefined ? {} : { ratings: r }))(toMergedRatings(flattenRatings(m.ratings)))),
            ...((display => (display === undefined ? {} : { display }))(arrDisplay(m, this.id, 'movie')))
        }));
    }
}
