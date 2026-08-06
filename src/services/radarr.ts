import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import type { IndexInput } from '../core/resolver.ts';
import { addArrMedia, lookupArrForAdd, RADARR_ADD, readQualityProfiles, readRootFolders } from './arrAdd.ts';
import { calendarPath, deleteArrMedia, readArrQueue, readRadarrCalendar, removeArrQueueItem } from './arrQueue.ts';
import { flattenRatings, toMergedRatings, type RawRating } from './arrRatings.ts';
import {
    diagnoseConnection,
    type CalendarCapable,
    type CalendarEntry,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type HealthCheck,
    type HealthCheckCapable,
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
    type MediaDeleteCapable,
    type QualityProfile,
    type QueueRemoveCapable,
    type RootFolder,
    type RemoveQueueOptions,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type SearchTriggerCapable,
    type ServiceAdapter
} from './types.ts';

type RawMovie = {
    id?: number;
    title?: string;
    year?: number;
    overview?: string;
    monitored?: boolean;
    hasFile?: boolean;
    path?: string;
    tmdbId?: number;
    imdbId?: string;
    genres?: string[];
    ratings?: Record<string, RawRating>;
    movieFile?: { size?: number; quality?: { quality?: { name?: string } } };
};

import type { components } from './generated/radarr.ts';

/**
 * Generated from the vendored spec, so an upstream field rename becomes a
 * typecheck failure here rather than a runtime surprise for a user.
 */
type RawStatus = components['schemas']['SystemResource'];
type RawDiskSpace = components['schemas']['DiskSpaceResource'];
type RawHealthCheck = components['schemas']['HealthResource'];
type RawTask = components['schemas']['TaskResource'];
type RawCommand = components['schemas']['CommandResource'];

/**
 * The task that actually rescans the film library, confirmed against a live
 * Radarr 6.3.0 during the Phase 2a capture run.
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
        MediaAddCapable
{
    readonly id: ServiceId = 'radarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('radarr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v3/system/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return status.version;
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        const rows = await this.#http.get<RawDiskSpace[]>('/api/v3/diskspace');
        // The generated types mark these nullable, not merely optional — the
        // spec really does allow nulls. Narrowing on the value rather than on
        // `!== undefined` is what keeps a null out of a `string` field.
        return rows.map(r => ({
            service: this.id,
            ...(typeof r.path === 'string' ? { path: r.path } : {}),
            label: r.label ?? '',
            freeSpace: r.freeSpace ?? 0,
            ...(typeof r.totalSpace === 'number' ? { totalSpace: r.totalSpace } : {})
        }));
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const all = await this.#http.get<RawHealthCheck[]>('/api/v3/health');
        // Radarr generally returns only entries worth surfacing, but some
        // versions include `ok` rows — filter rather than trust.
        return all
            .filter(c => c.type !== 'ok')
            .map(c => ({
                service: this.id,
                source: c.source ?? 'unknown',
                type: c.type ?? 'warning',
                message: c.message ?? ''
            }));
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.get<RawTask[]>('/api/v3/system/task');
        const scan = tasks.find(t => t.taskName === LIBRARY_SCAN_TASK);
        const lastCompleted = scan?.lastExecution;
        return {
            service: this.id,
            ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
        };
    }

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id);
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
     * The first write in the codebase, and the only one Phase 4 ships at the
     * `safe` tier: it asks Radarr to look for releases for a film it already
     * tracks. Nothing is deleted, nothing is added, and the worst outcome is a
     * grab the user did not want — which the queue tools can then undo.
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
                remedy: 'Radarr movie ids are integers. Get one from get_media_details or get_library.'
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

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        const term = query.toLowerCase();

        if (source === 'library') {
            // Radarr has no library search endpoint, so this fetches the whole
            // list. Costly on a 900-film instance and correct today; design
            // spec §16's cache is what makes it cheap, and lands in Phase 3.
            const movies = await this.#http.get<RawMovie[]>('/api/v3/movie');
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
            id: String(m.id ?? m.tmdbId ?? ''),
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
     * this is the same `/api/v3/movie` read `search` already does. §16's cache
     * is what makes it affordable, and it lives in the tool layer.
     */
    async listLibrary(): Promise<IndexInput[]> {
        const movies = await this.#http.get<RawMovie[]>('/api/v3/movie');

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
                monitored: m.monitored ?? false,
                hasFile: m.hasFile ?? false,
                ...(m.movieFile?.quality?.quality?.name === undefined
                    ? {}
                    : { quality: m.movieFile.quality.quality.name }),
                ...(m.movieFile?.size === undefined ? {} : { sizeBytes: m.movieFile.size })
            },
            ...((r => (r === undefined ? {} : { ratings: r }))(toMergedRatings(flattenRatings(m.ratings))))
        }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
