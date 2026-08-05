import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { applyLimit } from '../core/shape.ts';
import { readArrQueue, readSonarrCalendar, sonarrCalendarPath } from './arrQueue.ts';
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
    type MediaDetailCapable,
    type MediaDetails,
    type QueueCapable,
    type QueueItem,
    type ScanState,
    type ScanStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
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
    /** Flat, unlike Radarr's per-source map — see `flattenSeriesRating`. */
    ratings?: RawRating;
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

/**
 * The task that rescans the series library, confirmed against a live Sonarr
 * 4.0.19 during the Phase 2a capture run.
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
        SearchCapable
{
    readonly id: ServiceId = 'sonarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('sonarr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
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

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.get<RawTask[]>('/api/v3/system/task');
        const scan = tasks.find(t => t.taskName === LIBRARY_SCAN_TASK);
        const lastCompleted = scan?.lastExecution;
        return { service: this.id, ...(typeof lastCompleted === 'string' ? { lastCompleted } : {}) };
    }

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id);
    }

    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const episodes = await this.#http.get<Parameters<typeof readSonarrCalendar>[0]>(sonarrCalendarPath(range));
        return readSonarrCalendar(episodes, this.id);
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

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
