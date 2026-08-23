import { instanceId } from '../config/instances.ts';
import type { Instanced, KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { applyLimit } from '../core/shape.ts';
import type { IndexInput, SeasonSummary } from '../core/resolver.ts';
import { addArrMedia, lookupArrForAdd, readQualityProfiles, readRootFolders, SONARR_ADD } from './arrAdd.ts';
import { readArrHistory } from './arrHistory.ts';
import { deleteArrMedia, readArrQueue, readSonarrCalendar, removeArrQueueItem, sonarrCalendarPath } from './arrQueue.ts';
import { findArrReleases } from './arrRelease.ts';
import { readArrWanted } from './arrWanted.ts';
import { flattenSeriesRating, type RawRating } from './arrRatings.ts';
import { arrDiskSpace, arrFailedHealthChecks, arrScanState, arrStartLibraryScan, arrVersion } from './arrSystem.ts';
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
    type EpisodeFile,
    type EpisodeFileCapable,
    type MediaAddCapable,
    type MediaDeleteCapable,
    type MonitoringCapable,
    type MonitoringTarget,
    type QualityProfile,
    type QueueRemoveCapable,
    type ReleaseCandidate,
    type ReleaseSearchCapable,
    type RootFolder,
    type RemoveQueueOptions,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type SearchTarget,
    type SearchTriggerCapable,
    type ServiceAdapter,
    type WantedCapable,
    type WantedItem,
    type WantedScope
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
    /**
     * Present in every `/api/v3/series` response and unread until now.
     * `totalEpisodeCount` is TVDB's number for the season, which is why this
     * server needs no TVDB client of its own.
     */
    seasons?: {
        seasonNumber?: number;
        monitored?: boolean;
        statistics?: { episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number };
    }[];
};

type RawEpisode = {
    id?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    title?: string;
    airDateUtc?: string;
    hasFile?: boolean;
    monitored?: boolean;
    /** 0 when the episode has no file — Sonarr uses zero, not absence. */
    episodeFileId?: number;
};

type RawEpisodeFile = { id?: number; seasonNumber?: number; size?: number };

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
        MediaAddCapable,
        MonitoringCapable,
        EpisodeFileCapable,
        HistoryCapable,
        WantedCapable,
        ReleaseSearchCapable
{
    readonly type: ServiceId = 'sonarr';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;

    /** The whole-library read, shared by `search(_, 'library')` and
     *  `listLibrary` — both hit `/api/v3/series`. Discarded on config reload
     *  for free: `buildAdapters` constructs a new adapter. */
    readonly #libraryCache = new TtlCache();

    constructor(config: Instanced<KeyedServiceConfig>, fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('sonarr', config.name);
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
        return arrStartLibraryScan(this.#http, this.id, 'RefreshSeries');
    }

    async getScanState(): Promise<ScanState> {
        return arrScanState(this.#http, this.id, LIBRARY_SCAN_TASK);
    }

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.#http, this.id, 'series');
    }

    async readHistory(opts: { id?: string; since?: string }): Promise<HistoryEntry[]> {
        return readArrHistory(this.#http, this.id, 'series', opts);
    }

    async readWanted(scope: WantedScope): Promise<WantedItem[]> {
        return readArrWanted(this.#http, this.id, 'series', scope);
    }

    async findReleases(opts: { id: string; season?: number }): Promise<ReleaseCandidate[]> {
        return findArrReleases(this.#http, this.id, 'series', opts);
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

    /** Shared by every write here: refuse before issuing, never after. */
    #numericId(value: string, what: string): number {
        const id = Number(value);
        if (!Number.isInteger(id)) {
            throw new ServiceError('NotFound', this.id, `"${value}" is not a Sonarr ${what} id`, {
                remedy: `Sonarr ${what} ids are integers. Get one from get_media_details or get_library.`
            });
        }
        return id;
    }

    /**
     * Three targets, one method, because they are one decision: what to
     * monitor. Episode ids take their own endpoint; the series and season forms
     * both round-trip the series resource, because Sonarr's PUT replaces it
     * wholesale and a partial body would blank every field left out.
     */
    async setMonitoring(id: string, opts: MonitoringTarget): Promise<void> {
        if (opts.episodeIds !== undefined) {
            const episodeIds = opts.episodeIds.map(e => this.#numericId(e, 'episode'));
            await this.#http.put('/api/v3/episode/monitor', { episodeIds, monitored: opts.monitored }, true);
            return;
        }

        const seriesId = this.#numericId(id, 'series');
        const series = await this.#http.get<RawSeries & { id: number }>(`/api/v3/series/${seriesId}`);

        if (opts.season === undefined) {
            await this.#http.put(`/api/v3/series/${seriesId}`, { ...series, monitored: opts.monitored }, true);
            return;
        }

        // Only the named season changes. Rewriting them all would unmonitor the
        // whole show while reporting that one season had been touched.
        const seasons = (series.seasons ?? []).map(s =>
            s.seasonNumber === opts.season ? { ...s, monitored: opts.monitored } : s
        );
        await this.#http.put(`/api/v3/series/${seriesId}`, { ...series, seasons }, true);
    }

    async listEpisodeFiles(seriesId: string): Promise<EpisodeFile[]> {
        const id = this.#numericId(seriesId, 'series');
        const files = await this.#http.get<RawEpisodeFile[]>(`/api/v3/episodefile?seriesId=${id}`);

        return files
            .filter((f): f is RawEpisodeFile & { id: number } => typeof f.id === 'number')
            .map(f => ({
                id: f.id,
                season: f.seasonNumber ?? 0,
                ...(f.size === undefined ? {} : { sizeBytes: f.size })
            }));
    }

    /** Bulk, in one call. An empty list issues nothing: a delete with no ids is
     *  a request with no purpose, and Sonarr's behaviour for it is not worth
     *  discovering in production. */
    async deleteEpisodeFiles(fileIds: number[]): Promise<void> {
        if (fileIds.length === 0) return;
        await this.#http.deleteWithBody('/api/v3/episodefile/bulk', { episodeFileIds: fileIds });
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
     * `target` picks a different command entirely rather than overloading
     * `id` — conflating whole-series and per-episode scope behind one
     * argument is how a model asking for one episode triggers a season-wide
     * grab. `SeasonSearch` and `EpisodeSearch` are spec-derived: unlike
     * `SeriesSearch`, no live call has confirmed their payload shape, because
     * posting one runs a real search on the user's stack.
     */
    async triggerSearch(id: string, target?: SearchTarget): Promise<CommandHandle> {
        const seriesId = Number(id);
        if (!Number.isInteger(seriesId)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Sonarr series id`, {
                remedy: 'Sonarr series ids are integers. Get one from get_media_details or get_library.'
            });
        }

        const payload =
            target?.episodes !== undefined
                ? { name: 'EpisodeSearch', episodeIds: target.episodes.map(Number) }
                : target?.season !== undefined
                  ? { name: 'SeasonSearch', seriesId, seasonNumber: target.season }
                  : { name: 'SeriesSearch', seriesId };

        const command = await this.#http.post<RawCommand>('/api/v3/command', payload);

        return {
            service: this.id,
            commandId: command.id ?? 0,
            name: command.name ?? payload.name,
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
            ...(ratings === undefined ? {} : { ratings }),
            ...(s.seasons === undefined
                ? {}
                : {
                      seasons: s.seasons
                          .filter((x): x is typeof x & { seasonNumber: number } => typeof x.seasonNumber === 'number')
                          .map(x => ({ season: x.seasonNumber, monitored: x.monitored ?? false }))
                          .sort((a, b) => a.season - b.season)
                  })
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
                monitored: e.monitored ?? false,
                ...(e.episodeFileId === undefined ? {} : { episodeFileId: e.episodeFileId })
            })),
            episodeCount: shaped.total,
            episodesTruncated: shaped.truncated
        };
    }

    /** The `/api/v3/series` read behind both `search(_, 'library')` and
     *  `listLibrary` — Sonarr has no server-side filter, so both need the
     *  whole list, and this is where they share one fetch for it. */
    #allSeries(): Promise<RawSeries[]> {
        return this.#libraryCache.get('series', LIBRARY_TTL_MS, () => this.#http.get<RawSeries[]>('/api/v3/series'));
    }

    /** Drop the cached whole-library read, e.g. after a write. */
    invalidateLibrary(): void {
        this.#libraryCache.clear();
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        const term = query.toLowerCase();

        if (source === 'library') {
            // Sonarr has no library search endpoint, so this filters the whole
            // list. `#allSeries` caches that read, shared with `listLibrary`.
            const series = await this.#allSeries();
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
            // `?? ` alone would keep a zero: a lookup omits `id` for something
            // not in the library, but a build that sends 0 instead must not
            // produce the id "0". Matches arrAdd's own `> 0` guard.
            id: String((s.id !== undefined && s.id > 0 ? s.id : undefined) ?? s.tvdbId ?? ''),
            title: fenceText(s.title ?? '', { service: this.id, field: 'title' }),
            ...(s.year === undefined ? {} : { year: s.year }),
            ids: {
                ...(s.tvdbId === undefined ? {} : { tvdb: s.tvdbId }),
                ...(s.imdbId === undefined ? {} : { imdb: s.imdbId })
            },
            ...(s.monitored === undefined ? {} : { monitored: s.monitored })
        };
    }

    /**
     * Sonarr's half of a season row: the three denominators and the monitoring
     * flag, no watch state. Sorted by season number so responses are stable
     * across calls and diffable in tests — Sonarr's own order is not guaranteed.
     *
     * `monitored` is carried here as well as on `getMediaDetails` so that
     * `seasons[].monitored` means one thing on both forms `get_media_details`
     * can return. Omitted when Sonarr did not report it, never defaulted to
     * `false` — see `SeasonSummary`.
     */
    #seasonsOf(raw: RawSeries): SeasonSummary[] | undefined {
        if (raw.seasons === undefined) return undefined;
        const rows = raw.seasons
            .filter((s): s is typeof s & { seasonNumber: number } => typeof s.seasonNumber === 'number')
            .map(s => ({
                season: s.seasonNumber,
                ...(s.monitored === undefined ? {} : { monitored: s.monitored }),
                ...(s.statistics?.episodeFileCount === undefined ? {} : { onDisk: s.statistics.episodeFileCount }),
                ...(s.statistics?.episodeCount === undefined ? {} : { aired: s.statistics.episodeCount }),
                ...(s.statistics?.totalEpisodeCount === undefined ? {} : { total: s.statistics.totalEpisodeCount })
            }))
            .sort((a, b) => a.season - b.season);
        return rows.length === 0 ? undefined : rows;
    }

    /** The whole series library in one call, via `#allSeries` — the same read
     *  `search(_, 'library')` shares. */
    async listLibrary(): Promise<IndexInput[]> {
        const series = await this.#allSeries();

        return series.map(s => {
            const seasons = this.#seasonsOf(s);
            return {
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
                )),
                ...(seasons === undefined ? {} : { seasons })
            };
        });
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
