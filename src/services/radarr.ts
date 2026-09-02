import { instanceId } from '../config/instances.ts';
import type { Instanced, KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import type { IndexInput } from '../core/resolver.ts';
import { addArrMedia, lookupArrForAdd, RADARR_ADD, readQualityProfiles, readRootFolders, readTags } from './arrAdd.ts';
import { readArrHistory } from './arrHistory.ts';
import { refreshArrItem, renameArrItem } from './arrCommands.ts';
import { listArrImportCandidates, runArrManualImport } from './arrManualImport.ts';
import { readArrForUpdate, updateArrMedia } from './arrUpdate.ts';
import { calendarPath, deleteArrMedia, readArrQueue, readRadarrCalendar, removeArrQueueItem } from './arrQueue.ts';
import { readArrBlocklist, removeArrBlocklistItem } from './arrBlocklist.ts';
import { findArrReleases, grabArrRelease } from './arrRelease.ts';
import { readArrWanted } from './arrWanted.ts';
import { flattenRatings, toMergedRatings, type RawRating } from './arrRatings.ts';
import { arrDiskSpace, arrFailedHealthChecks, arrScanState, arrStartLibraryScan, arrVersion } from './arrSystem.ts';
import {
    diagnoseConnection,
    type BlocklistEntry,
    type CalendarCapable,
    type CalendarEntry,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type LibraryCapable,
    type MediaDetailCapable,
    type MediaDetails,
    type QueueCapable,
    type QueueItem,
    type ScanState,
    type ScanStateCapable,
    type AddCandidate,
    type AddMediaOptions,
    type CommandHandle,
    type DeleteMediaOptions,
    type MediaAddCapable,
    type ImportCandidate,
    type LibraryMaintenanceCapable,
    type ManualImportCapable,
    type MediaUpdateCapable,
    type MediaUpdateOptions,
    type MediaUpdateState,
    type MediaDeleteCapable,
    type QualityProfile,
    type QueueRemoveCapable,
    type ReleaseCandidate,
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
    type WantedScope
} from './types.ts';

type RawMovie = {
    id?: number;
    title?: string;
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
    added?: string | null;
    movieFile?: { size?: number; quality?: { quality?: { name?: string } } };
};

import type { components } from './generated/radarr.ts';

/**
 * Generated from the vendored spec, so an upstream field rename becomes a
 * typecheck failure here rather than a runtime surprise for a user.
 */
type RawCommand = components['schemas']['CommandResource'];

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
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        HealthCheckCapable,
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
        ManualImportCapable,
        HistoryCapable,
        WantedCapable,
        ReleaseSearchCapable
{
    readonly type: ServiceId = 'radarr';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;

    /** The whole-library read, shared by `search(_, 'library')` and
     *  `listLibrary` — both hit `/api/v3/movie`. Discarded on config reload
     *  for free: `buildAdapters` constructs a new adapter. */
    readonly #libraryCache = new TtlCache();

    constructor(config: Instanced<KeyedServiceConfig>, fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('radarr', config.name);
        // The instance id, not the type: an error from the 4K instance has to
        // say which one it came from, or two Radarrs produce indistinguishable
        // failures.
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        return arrVersion(this.#http, this.id);
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        return arrDiskSpace(this.#http, this.id);
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        return arrFailedHealthChecks(this.#http, this.id);
    }

    async startLibraryScan(): Promise<CommandHandle> {
        return arrStartLibraryScan(this.#http, this.id, 'RefreshMovie');
    }

    async getScanState(): Promise<ScanState> {
        return arrScanState(this.#http, this.id, LIBRARY_SCAN_TASK);
    }

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id, 'movie');
    }

    async readHistory(opts: { id?: string; since?: string }): Promise<HistoryEntry[]> {
        return readArrHistory(this.#http, this.id, 'movie', opts);
    }

    async readWanted(scope: WantedScope): Promise<WantedItem[]> {
        return readArrWanted(this.#http, this.id, 'movie', scope);
    }

    async findReleases(opts: { id: string; season?: number }): Promise<ReleaseCandidate[]> {
        return findArrReleases(this.#http, this.id, 'movie', opts);
    }

    async grabRelease(opts: { guid: string; indexerId: number }): Promise<void> {
        return grabArrRelease(this.#http, opts);
    }

    async readBlocklist(): Promise<BlocklistEntry[]> {
        return readArrBlocklist(this.#http, this.id, 'movie');
    }

    async removeBlocklistItem(id: string): Promise<void> {
        return removeArrBlocklistItem(this.#http, id);
    }

    readonly supportsBlocklist = true;

    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        return removeArrQueueItem(this.#http, this.id, id, opts);
    }

    async deleteMedia(id: string, opts: DeleteMediaOptions): Promise<void> {
        return deleteArrMedia(this.#http, this.id, 'movie', id, opts);
    }

    async listQualityProfiles(): Promise<QualityProfile[]> {
        return readQualityProfiles(this.#http, this.id);
    }

    async listRootFolders(): Promise<RootFolder[]> {
        return readRootFolders(this.#http, this.id);
    }

    async listTags(): Promise<Tag[]> {
        return readTags(this.#http, this.id);
    }

    async listImportCandidates(downloadId: string): Promise<ImportCandidate[]> {
        return listArrImportCandidates(this.#http, this.id, 'movie', downloadId);
    }

    async runManualImport(downloadId: string): Promise<CommandHandle> {
        return runArrManualImport(this.#http, this.id, 'movie', downloadId);
    }

    async refreshItem(id: string): Promise<CommandHandle> {
        return refreshArrItem(this.#http, this.id, 'movie', id);
    }

    async renameItem(id: string): Promise<CommandHandle> {
        return renameArrItem(this.#http, this.id, 'movie', id);
    }

    async readForUpdate(id: string): Promise<MediaUpdateState> {
        return readArrForUpdate(this.#http, this.id, 'movie', id);
    }

    async updateMedia(id: string, opts: MediaUpdateOptions): Promise<MediaUpdateState> {
        return updateArrMedia(this.#http, this.id, 'movie', id, opts);
    }

    /** Radarr resolves by TMDB id; a TVDB id will simply match nothing. */
    async lookupForAdd(externalId: string): Promise<AddCandidate> {
        return lookupArrForAdd(this.#http, this.id, RADARR_ADD, externalId);
    }

    async addMedia(opts: AddMediaOptions): Promise<{ id: number; title: string }> {
        return addArrMedia(this.#http, this.id, RADARR_ADD, opts);
    }

    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const movies = await this.#http.get<Parameters<typeof readRadarrCalendar>[0]>(calendarPath(range));
        return readRadarrCalendar(movies, this.id);
    }

    async getMediaDetails(id: string): Promise<MediaDetails> {
        const m = await this.#http.get<RawMovie>(`/api/v3/movie/${encodeURIComponent(id)}`);
        const ratings = flattenRatings(m.ratings);

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
            ...(m.movieFile?.size === undefined ? {} : { sizeBytes: m.movieFile.size }),
            ...(m.movieFile?.quality?.quality?.name === undefined
                ? {}
                : { quality: m.movieFile.quality.quality.name }),
            ...(m.path === undefined ? {} : { path: fenceText(m.path, { service: this.id, field: 'path' }) }),
            ids: {
                ...(m.tmdbId === undefined ? {} : { tmdb: m.tmdbId }),
                ...(m.imdbId === undefined ? {} : { imdb: m.imdbId })
            },
            ...(ratings === undefined ? {} : { ratings })
        };
    }

    /**
     * Safe tier: it asks Radarr to look for releases for a film it already
     * tracks. Nothing is deleted or added, and the worst outcome is an unwanted
     * grab, which the queue tools can undo.
     *
     * The id is coerced to a number rather than interpolated: `movieIds` is a
     * JSON array of integers, and a string there is silently accepted by Radarr
     * and matches nothing, which would report a successful search that never
     * ran.
     */
    async triggerSearch(id: string): Promise<CommandHandle> {
        const movieId = Number(id);
        if (!Number.isInteger(movieId)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Radarr movie id`, {
                remedy: 'Radarr movie ids are integers. Take one from `acquisition.id` on get_library or get_media_details.'
            });
        }

        const command = await this.#http.post<RawCommand>('/api/v3/command', {
            name: 'MoviesSearch',
            movieIds: [movieId]
        });

        return {
            service: this.id,
            commandId: command.id ?? 0,
            name: command.name ?? 'MoviesSearch',
            ...(typeof command.status === 'string' ? { status: command.status } : {})
        };
    }

    /** The `/api/v3/movie` read behind both `search(_, 'library')` and
     *  `listLibrary` — Radarr has no server-side filter, so both need the
     *  whole list, and this is where they share one fetch for it. */
    #allMovies(): Promise<RawMovie[]> {
        return this.#libraryCache.get('movies', LIBRARY_TTL_MS, () => this.#http.get<RawMovie[]>('/api/v3/movie'));
    }

    /** Drop the cached whole-library read, e.g. after a write. */
    invalidateLibrary(): void {
        this.#libraryCache.clear();
    }

    /**
     * Profile id → fenced name, cached beside the library read so a build
     * costs one extra call rather than one per film. An empty map on failure:
     * a profile list that times out must not take the whole library with it,
     * and the id alone is still worth reporting.
     */
    async #profileNames(): Promise<Map<number, string>> {
        try {
            const profiles = await this.#libraryCache.get('profiles', LIBRARY_TTL_MS, () =>
                readQualityProfiles(this.#http, this.id)
            );
            return new Map(profiles.map(p => [p.id, p.display]));
        } catch {
            return new Map();
        }
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
            const found = await this.#http.get<RawMovie[]>(
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
            ...(m.monitored === undefined ? {} : { monitored: m.monitored })
        };
    }

    /**
     * The whole film library in one call — Radarr has no server-side filter, so
     * this is the same `/api/v3/movie` read `search` already does, via `#allMovies`.
     */
    async listLibrary(): Promise<IndexInput[]> {
        const [movies, profileNames] = await Promise.all([this.#allMovies(), this.#profileNames()]);

        return movies.map(m => ({
            kind: 'movie' as const,
            title: fenceText(m.title ?? '', { service: this.id, field: 'title' }),
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
            ...((r => (r === undefined ? {} : { ratings: r }))(toMergedRatings(flattenRatings(m.ratings))))
        }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
