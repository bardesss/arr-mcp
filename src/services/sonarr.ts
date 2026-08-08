import { instanceId } from '../config/instances.ts';
import type { Instanced, KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { applyLimit } from '../core/shape.ts';
import type { IndexInput } from '../core/resolver.ts';
import { addArrMedia, lookupArrForAdd, readQualityProfiles, readRootFolders, SONARR_ADD } from './arrAdd.ts';
import { deleteArrMedia, readArrQueue, readSonarrCalendar, removeArrQueueItem, sonarrCalendarPath } from './arrQueue.ts';
import { flattenSeriesRating, type RawRating } from './arrRatings.ts';
import type { components } from './generated/sonarr.ts';
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

type RawSeries = {
    id?: number;
    title?: string;
    year?: number;
    overview?: string;
    monitored?: boolean;
    path?: string;
    tvdbId?: number;
    imdbId?: string;
    genres?: string[];
    /** Flat, unlike Radarr's per-source map — see `flattenSeriesRating`. */
    ratings?: RawRating;
    added?: string | null;
    statistics?: { sizeOnDisk?: number; episodeFileCount?: number };
};

type RawEpisode = {
    id?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    title?: string;
    airDateUtc?: string;
    hasFile?: boolean;
    monitored?: boolean;
};

type RawStatus = components['schemas']['SystemResource'];
type RawDiskSpace = components['schemas']['DiskSpaceResource'];
type RawHealthCheck = components['schemas']['HealthResource'];
type RawTask = components['schemas']['TaskResource'];
type RawCommand = components['schemas']['CommandResource'];

/**
 * The task that rescans the series library, confirmed against a live Sonarr
 * 4.0.19 during a live capture.
 *
 * Matched exactly, never by pattern — for the same reason as Radarr's
 * `RefreshMovie`. A live instance runs eleven tasks, and
 * `RefreshMonitoredDownloads` polls the download queue every minute. Taking the
 * most recent match reported the library as scanned minutes ago when the real
 * scan was nine hours old.
 */
const LIBRARY_SCAN_TASK = 'RefreshSeries';

export class SonarrAdapter
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
    readonly type: ServiceId = 'sonarr';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;

    constructor(config: Instanced<KeyedServiceConfig>, fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('sonarr', config.name);
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
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
        // The generated types mark these nullable, not merely optional.
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
        return all
            .filter(c => c.type !== 'ok')
            .map(c => ({
                service: this.id,
                source: c.source ?? 'unknown',
                type: String(c.type ?? 'warning'),
                message: c.message ?? ''
            }));
    }

    /**
     * Queues the same command `getScanState` reads the last run of, so what
     * this starts and what that reports can never drift apart.
     */
    async startLibraryScan(): Promise<CommandHandle> {
        const command = await this.#http.post<RawCommand>('/api/v3/command', { name: 'RefreshSeries' });

        return {
            service: this.id,
            commandId: command.id ?? 0,
            name: command.name ?? 'RefreshSeries',
            ...(typeof command.status === 'string' ? { status: command.status } : {})
        };
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.get<RawTask[]>('/api/v3/system/task');
        const scan = tasks.find(t => t.taskName === LIBRARY_SCAN_TASK);
        const lastCompleted = scan?.lastExecution;
        return { service: this.id, ...(typeof lastCompleted === 'string' ? { lastCompleted } : {}) };
    }

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id);
    }

    readonly supportsBlocklist = true;

    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        return removeArrQueueItem(this.#http, this.id, id, opts);
    }

    /** Deletes the whole series. Sonarr has no per-episode delete on this path,
     *  which is why `delete_media` refuses to pretend otherwise. */
    async deleteMedia(id: string, opts: DeleteMediaOptions): Promise<void> {
        return deleteArrMedia(this.#http, this.id, 'series', id, opts);
    }

    async listQualityProfiles(): Promise<QualityProfile[]> {
        return readQualityProfiles(this.#http, this.id);
    }

    async listRootFolders(): Promise<RootFolder[]> {
        return readRootFolders(this.#http, this.id);
    }

    /** Sonarr resolves by TVDB id, not TMDB — Radarr's id will match nothing. */
    async lookupForAdd(externalId: string): Promise<AddCandidate> {
        return lookupArrForAdd(this.#http, this.id, SONARR_ADD, externalId);
    }

    async addMedia(opts: AddMediaOptions): Promise<{ id: number; title: string }> {
        return addArrMedia(this.#http, this.id, SONARR_ADD, opts);
    }

    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const episodes = await this.#http.get<Parameters<typeof readSonarrCalendar>[0]>(sonarrCalendarPath(range));
        return readSonarrCalendar(episodes, this.id);
    }

    /**
     * Radarr's counterpart, with the one asymmetry upstream insists on:
     * `SeriesSearch` takes a bare `seriesId`, not an array, where Radarr's
     * `MoviesSearch` takes `movieIds: []`. Passing Radarr's shape here is
     * accepted and searches nothing.
     *
     * Whole-series scope is deliberate for this first slice: per-episode search
     * is a different command (`EpisodeSearch`) keyed on episode ids, and
     * conflating the two behind one argument is how a model asking for one
     * episode triggers a season-wide grab.
     */
    async triggerSearch(id: string): Promise<CommandHandle> {
        const seriesId = Number(id);
        if (!Number.isInteger(seriesId)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Sonarr series id`, {
                remedy: 'Sonarr series ids are integers. Get one from get_media_details or get_library.'
            });
        }

        const command = await this.#http.post<RawCommand>('/api/v3/command', {
            name: 'SeriesSearch',
            seriesId
        });

        return {
            service: this.id,
            commandId: command.id ?? 0,
            name: command.name ?? 'SeriesSearch',
            ...(typeof command.status === 'string' ? { status: command.status } : {})
        };
    }

    async getMediaDetails(id: string, opts: { includeEpisodes: boolean; episodeLimit: number }): Promise<MediaDetails> {
        const s = await this.#http.get<RawSeries>(`/api/v3/series/${encodeURIComponent(id)}`);
        const ratings = flattenSeriesRating(s.ratings);

        const base: MediaDetails = {
            service: this.id,
            kind: 'series',
            id,
            title: fenceText(s.title ?? '', { service: this.id, field: 'title' }),
            ...(s.year === undefined ? {} : { year: s.year }),
            ...(s.overview === undefined
                ? {}
                : { overview: fenceText(s.overview, { service: this.id, field: 'overview' }) }),
            ...(s.monitored === undefined ? {} : { monitored: s.monitored }),
            ...(s.statistics?.sizeOnDisk === undefined ? {} : { sizeBytes: s.statistics.sizeOnDisk }),
            ...(s.path === undefined ? {} : { path: fenceText(s.path, { service: this.id, field: 'path' }) }),
            ids: {
                ...(s.tvdbId === undefined ? {} : { tvdb: s.tvdbId }),
                ...(s.imdbId === undefined ? {} : { imdb: s.imdbId })
            },
            ...(ratings === undefined ? {} : { ratings })
        };

        if (!opts.includeEpisodes) return base;

        // A long-running series is hundreds of episodes; the same truncation
        // contract applies here as to any other list.
        const episodes = await this.#http.get<RawEpisode[]>(`/api/v3/episode?seriesId=${encodeURIComponent(id)}`);
        const shaped = applyLimit(
            episodes.filter((e): e is RawEpisode & { id: number } => typeof e.id === 'number'),
            opts.episodeLimit
        );

        return {
            ...base,
            episodes: shaped.items.map(e => ({
                id: e.id,
                season: e.seasonNumber ?? 0,
                episode: e.episodeNumber ?? 0,
                title: fenceText(e.title ?? '', { service: this.id, field: 'episode.title' }),
                ...(e.airDateUtc === undefined ? {} : { airDate: e.airDateUtc }),
                hasFile: e.hasFile ?? false,
                monitored: e.monitored ?? false
            })),
            episodeCount: shaped.total,
            episodesTruncated: shaped.truncated
        };
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        const term = query.toLowerCase();

        if (source === 'library') {
            const series = await this.#http.get<RawSeries[]>('/api/v3/series');
            return series.filter(s => (s.title ?? '').toLowerCase().includes(term)).map(s => this.#toHit(s, 'library'));
        }

        if (source === 'discover') {
            const found = await this.#http.get<RawSeries[]>(
                `/api/v3/series/lookup?term=${encodeURIComponent(query)}`
            );
            return found.map(s => this.#toHit(s, 'discover'));
        }

        return [];
    }

    #toHit(s: RawSeries, source: SearchSource): SearchHit {
        return {
            service: this.id,
            source,
            kind: 'series',
            id: String(s.id ?? s.tvdbId ?? ''),
            title: fenceText(s.title ?? '', { service: this.id, field: 'title' }),
            ...(s.year === undefined ? {} : { year: s.year }),
            ids: {
                ...(s.tvdbId === undefined ? {} : { tvdb: s.tvdbId }),
                ...(s.imdbId === undefined ? {} : { imdb: s.imdbId })
            },
            ...(s.monitored === undefined ? {} : { monitored: s.monitored })
        };
    }

    async listLibrary(): Promise<IndexInput[]> {
        const series = await this.#http.get<RawSeries[]>('/api/v3/series');

        return series.map(s => ({
            kind: 'series' as const,
            title: fenceText(s.title ?? '', { service: this.id, field: 'title' }),
            ...(s.year === undefined ? {} : { year: s.year }),
            ...(s.genres === undefined
                ? {}
                : { genres: s.genres.map(g => fenceText(g, { service: this.id, field: 'genre' })) }),
            ids: {
                ...(s.tvdbId === undefined ? {} : { tvdb: s.tvdbId }),
                ...(s.imdbId === undefined ? {} : { imdb: s.imdbId })
            },
            acquisition: {
                service: this.id,
                monitored: s.monitored ?? false,
                // A series has no single file, so "has a file" means "has any
                // episode on disk". No quality either: it is per-episode, which
                // is why this makes the quality filter films-only.
                hasFile: (s.statistics?.episodeFileCount ?? 0) > 0,
                ...(s.added === undefined || s.added === null ? {} : { addedAt: s.added }),
                ...(s.statistics?.sizeOnDisk === undefined ? {} : { sizeBytes: s.statistics.sizeOnDisk })
            },
            // Flat, and labelled tvdb. Treating it as a per-source map is the
            // 0.3.0 defect that reported a source called `votes` worth 164018.
            ...((r => (r === undefined ? {} : { ratings: r }))(
                (raw => (raw?.tvdb === undefined ? undefined : { tvdb: raw.tvdb }))(flattenSeriesRating(s.ratings))
            ))
        }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
