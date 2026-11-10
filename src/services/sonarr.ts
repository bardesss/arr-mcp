import { aliasesOf } from '../core/titleMatch.ts';
import type { ConfigByService } from '../config/schema.ts';
import { LIBRARY_TTL_MS } from '../core/cache.ts';
import { ArrAdapterBase } from './arrBase.ts';
import { SONARR_EXCLUSIONS, addExclusion, findExclusion, removeExclusion } from './arrExclusions.ts';
import type { ImportExclusion } from './types.ts';
import { seasonsOf, seriesHit } from './arrSeries.ts';
import { fenceText } from '../core/fence.ts';
import type { RawImage } from '../core/display.ts';
import { arrDisplay } from './arrDisplay.ts';
import { applyLimit } from '../core/shape.ts';
import type { IndexInput } from '../core/resolver.ts';
import {
    addArrMedia,
    lookupArrForAdd,
    readProfileNames,
    readQualityProfiles,
    readRootFolders,
    readTags,
    SONARR_ADD
} from './arrAdd.ts';
import { readArrProfileDiagnostics } from './arrProfiles.ts';
import { readArrHistory } from './arrHistory.ts';
import { traceArrDownload } from './arrDownloadTrace.ts';
import { postArrCommand, readArrCommands, refreshArrItem, renameArrItem } from './arrCommands.ts';
import {
    listArrImportCandidates,
    planArrEpisodeRemap,
    runArrEpisodeRemap,
    runArrManualImport
} from './arrManualImport.ts';
import { readArrForUpdate, updateArrMedia } from './arrUpdate.ts';
import { deleteArrMedia, readArrQueue, readSonarrCalendar, removeArrQueueItem, sonarrCalendarPath } from './arrQueue.ts';
import { findArrBlocklistEntry, readArrBlocklist, removeArrBlocklistItem } from './arrBlocklist.ts';
import { readSeedCriteria } from './arrSeedCriteria.ts';
import { findArrReleases, grabArrRelease } from './arrRelease.ts';
import { readArrWanted } from './arrWanted.ts';
import { audioLanguagesByFileId } from './arrMediaInfo.ts';
import { flattenSeriesRating, type RawRating } from './arrRatings.ts';
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
    type EpisodeFile,
    type EpisodeFileCapable,
    type MediaAddCapable,
    type ImportCandidate,
    type ImportMapping,
    type LibraryMaintenanceCapable,
    type EpisodeReassignment,
    type EpisodeRemapCapable,
    type EpisodeRemapOutcome,
    type EpisodeRemapPlan,
    type ManualImportCapable,
    type MediaUpdateCapable,
    type MediaUpdateOptions,
    type MediaUpdateState,
    type MediaDeleteCapable,
    type MonitoringCapable,
    type MonitoringTarget,
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
    type SearchTarget,
    type SearchTriggerCapable,
    type ServiceAdapter,
    type WantedCapable,
    type WantedItem,
    type WantedScope,
    type Window
} from './types.ts';

type RawSeries = {
    id?: number;
    title?: string;
    alternateTitles?: { title?: string | null }[] | null;
    year?: number;
    overview?: string;
    monitored?: boolean;
    status?: string;
    path?: string;
    tvdbId?: number;
    /** 0 when Sonarr has none. */
    tmdbId?: number;
    imdbId?: string;
    genres?: string[];
    qualityProfileId?: number;
    /** Flat, unlike Radarr's per-source map — see `flattenSeriesRating`. */
    ratings?: RawRating;
    added?: string | null;
    statistics?: { sizeOnDisk?: number; episodeFileCount?: number; episodeCount?: number; seasonCount?: number };
    images?: RawImage[] | null;
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
        EpisodeRemapCapable,
        MonitoringCapable,
        EpisodeFileCapable,
        HistoryCapable,
        DownloadTraceCapable,
        WantedCapable,
        ReleaseSearchCapable,
        ProfileDiagnosticsCapable,
        SeedCriteriaCapable
{
    protected readonly scanTask = LIBRARY_SCAN_TASK;

    constructor(config: ConfigByService['sonarr'], fetchImpl: typeof fetch = fetch) {
        super('sonarr', config, fetchImpl);
    }

    async getRecentLogs(): Promise<RecentLogs> {
        return arrRecentLogs(this.http, this.id);
    }

    async startLibraryScan(): Promise<CommandHandle> {
        return arrStartLibraryScan(this.http, this.id, 'RefreshSeries');
    }

    readonly queueKind = 'series';

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.http, this.id, this.queueKind);
    }

    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        return readArrHistory(this.http, this.id, 'series', opts);
    }

    async traceDownload(downloadId: string): Promise<DownloadTrace | undefined> {
        return traceArrDownload(this.http, this.id, 'series', downloadId);
    }

    async readWanted(scope: WantedScope, want?: number): Promise<Window<WantedItem>> {
        return readArrWanted(this.http, this.id, 'series', scope, want);
    }

    async findReleases(opts: ReleaseScope): Promise<ReleaseCandidate[]> {
        return findArrReleases(this.http, this.id, 'series', opts);
    }

    async grabRelease(opts: { guid: string; indexerId: number }): Promise<void> {
        return grabArrRelease(this.http, opts);
    }

    async readBlocklist(want?: number): Promise<Window<BlocklistEntry>> {
        return readArrBlocklist(this.http, this.id, 'series', want);
    }

    async findBlocklistItem(id: string): Promise<BlocklistEntry | undefined> {
        return findArrBlocklistEntry(this.http, this.id, 'series', id);
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

    /** Deletes the whole series. Sonarr has no per-episode delete on this path,
     *  which is why `delete_media` refuses to pretend otherwise. */
    async deleteMedia(id: string, opts: DeleteMediaOptions): Promise<void> {
        return deleteArrMedia(this.http, this.id, 'series', id, opts);
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
        return listArrImportCandidates(this.http, this.id, 'series', downloadId, mapping);
    }

    async runManualImport(downloadId: string, mapping?: ImportMapping[], paths?: string[]): Promise<CommandHandle> {
        return runArrManualImport(this.http, this.id, 'series', downloadId, mapping, paths);
    }

    async planEpisodeRemap(seriesId: string, reassignments: EpisodeReassignment[]): Promise<EpisodeRemapPlan> {
        return planArrEpisodeRemap(this.http, this.id, seriesId, reassignments);
    }

    async runEpisodeRemap(seriesId: string, reassignments: EpisodeReassignment[]): Promise<EpisodeRemapOutcome> {
        return runArrEpisodeRemap(this.http, this.id, seriesId, reassignments);
    }

    async refreshItem(id: string): Promise<CommandHandle> {
        return refreshArrItem(this.http, this.id, 'series', id);
    }

    async renameItem(id: string): Promise<CommandHandle> {
        return renameArrItem(this.http, this.id, 'series', id);
    }

    async readForUpdate(id: string): Promise<MediaUpdateState> {
        return readArrForUpdate(this.http, this.id, 'series', id);
    }

    async updateMedia(id: string, opts: MediaUpdateOptions): Promise<MediaUpdateState> {
        return updateArrMedia(this.http, this.id, 'series', id, opts);
    }

    /** Sonarr resolves by TVDB id, not TMDB — Radarr's id will match nothing. */
    async findImportExclusion(externalId: string): Promise<ImportExclusion | undefined> {
        return findExclusion(this.http, SONARR_EXCLUSIONS, externalId);
    }

    async addImportExclusion(externalId: string, label: { title: string; year?: number }): Promise<void> {
        await addExclusion(this.http, SONARR_EXCLUSIONS, externalId, label);
    }

    async removeImportExclusion(exclusionId: number): Promise<void> {
        await removeExclusion(this.http, SONARR_EXCLUSIONS, exclusionId);
    }

    async lookupForAdd(externalId: string): Promise<AddCandidate> {
        return lookupArrForAdd(this.http, this.id, SONARR_ADD, externalId);
    }

    async addMedia(opts: AddMediaOptions): Promise<{ id: number; title: string }> {
        return addArrMedia(this.http, this.id, SONARR_ADD, opts);
    }

    /**
     * Three targets, one method, because they are one decision: what to
     * monitor. Episode ids take their own endpoint; the series and season forms
     * both round-trip the series resource, because Sonarr's PUT replaces it
     * wholesale and a partial body would blank every field left out.
     */
    async setMonitoring(id: string, opts: MonitoringTarget): Promise<void> {
        if (opts.episodeIds !== undefined) {
            const episodeIds = opts.episodeIds.map(e => this.numericId('episode', e));
            await this.http.put('/api/v3/episode/monitor', { episodeIds, monitored: opts.monitored }, true);
            return;
        }

        const seriesId = this.numericId('series', id);
        const series = await this.http.get<RawSeries & { id: number }>(`/api/v3/series/${seriesId}`);

        if (opts.season === undefined) {
            await this.http.put(`/api/v3/series/${seriesId}`, { ...series, monitored: opts.monitored }, true);
            return;
        }

        // Only the named season changes. Rewriting them all would unmonitor the
        // whole show while reporting that one season had been touched.
        const seasons = (series.seasons ?? []).map(s =>
            s.seasonNumber === opts.season ? { ...s, monitored: opts.monitored } : s
        );
        await this.http.put(`/api/v3/series/${seriesId}`, { ...series, seasons }, true);
    }

    async listEpisodeFiles(seriesId: string): Promise<EpisodeFile[]> {
        const id = this.numericId('series', seriesId);
        const files = await this.http.getArray<RawEpisodeFile>(`/api/v3/episodefile?seriesId=${id}`);

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
        await this.http.deleteWithBody('/api/v3/episodefile/bulk', { episodeFileIds: fileIds });
    }

    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const episodes = await this.http.get<Parameters<typeof readSonarrCalendar>[0]>(sonarrCalendarPath(this.http.apiRoot, range));
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
        const seriesId = this.numericId('series', id);

        const payload =
            target?.episodes !== undefined
                ? { name: 'EpisodeSearch', episodeIds: target.episodes.map(e => this.numericId('episode', e)) }
                : target?.season !== undefined
                  ? { name: 'SeasonSearch', seriesId, seasonNumber: target.season }
                  : { name: 'SeriesSearch', seriesId };

        return postArrCommand(this.http, this.id, payload);
    }

    async getMediaDetails(id: string, opts: { includeEpisodes: boolean; episodeLimit: number }): Promise<MediaDetails> {
        const s = await this.http.get<RawSeries>(`/api/v3/series/${this.numericId('series', id)}`);
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
            ...(s.status === undefined ? {} : { status: s.status }),
            ...(s.statistics?.sizeOnDisk === undefined ? {} : { sizeBytes: s.statistics.sizeOnDisk }),
            ...(s.path === undefined ? {} : { path: fenceText(s.path, { service: this.id, field: 'path' }) }),
            ids: {
                ...(s.tvdbId === undefined ? {} : { tvdb: s.tvdbId }),
                // Sonarr's 0 is "none", and a 0 here would be asked of Reclaimerr as a real id.
                ...(s.tmdbId === undefined || s.tmdbId <= 0 ? {} : { tmdb: s.tmdbId }),
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
                  }),
            ...((display => (display === undefined ? {} : { display }))(arrDisplay(s, this.id, 'series')))
        };

        if (!opts.includeEpisodes) return base;

        // A long-running series is hundreds of episodes; the same truncation
        // contract applies here as to any other list.
        const [episodes, audio] = await Promise.all([
            this.http.get<RawEpisode[]>(`/api/v3/episode?seriesId=${encodeURIComponent(id)}`),
            audioLanguagesByFileId(this.http, this.id, id)
        ]);
        const shaped = applyLimit(
            episodes.filter((e): e is RawEpisode & { id: number } => typeof e.id === 'number'),
            opts.episodeLimit
        );

        return {
            ...base,
            episodes: shaped.items.map(e => {
                const languages = e.episodeFileId === undefined ? undefined : audio.get(e.episodeFileId);
                return {
                    id: e.id,
                    season: e.seasonNumber ?? 0,
                    episode: e.episodeNumber ?? 0,
                    title: fenceText(e.title ?? '', { service: this.id, field: 'episode.title' }),
                    ...(e.airDateUtc === undefined ? {} : { airDate: e.airDateUtc }),
                    hasFile: e.hasFile ?? false,
                    monitored: e.monitored ?? false,
                    ...(e.episodeFileId === undefined ? {} : { episodeFileId: e.episodeFileId }),
                    ...(languages === undefined ? {} : { audioLanguages: languages })
                };
            }),
            episodeCount: shaped.total,
            episodesTruncated: shaped.truncated
        };
    }

    /** The `/api/v3/series` read behind both `search(_, 'library')` and
     *  `listLibrary` — Sonarr has no server-side filter, so both need the
     *  whole list, and this is where they share one fetch for it. */
    #allSeries(): Promise<RawSeries[]> {
        return this.libraryCache.get('series', LIBRARY_TTL_MS, () => this.http.get<RawSeries[]>('/api/v3/series'));
    }

    /** The shared hit plus Sonarr's display block. */
    #toHit(s: RawSeries, source: SearchSource): SearchHit {
        const display = arrDisplay(s, this.id, 'series', { lookup: source === 'discover' });
        return { ...seriesHit(this.id, s, source), ...(display === undefined ? {} : { display }) };
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
            const found = await this.http.get<RawSeries[]>(
                `/api/v3/series/lookup?term=${encodeURIComponent(query)}`
            );
            return found.map(s => this.#toHit(s, 'discover'));
        }

        return [];
    }

    /** The whole series library in one call, via `#allSeries` — the same read
     *  `search(_, 'library')` shares. */
    async listLibrary(): Promise<IndexInput[]> {
        const [series, profileNames] = await Promise.all([this.#allSeries(), readProfileNames(this.http, this.id, this.libraryCache)]);

        return series.map(s => {
            const seasons = seasonsOf(s);
            return {
                kind: 'series' as const,
                title: fenceText(s.title ?? '', { service: this.id, field: 'title' }),
                ...((aliases => (aliases.length === 0 ? {} : { aliases }))(
                    aliasesOf(s.title, (s.alternateTitles ?? []).map(a => a.title))
                )),
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
                    ...(s.id === undefined || s.id <= 0 ? {} : { id: String(s.id) }),
                    ...(s.status === undefined ? {} : { status: s.status }),
                    monitored: s.monitored ?? false,
                    // A series has no single file, so "has a file" means "has any
                    // episode on disk". No quality either: it is per-episode, which
                    // is why this makes the quality filter films-only.
                    hasFile: (s.statistics?.episodeFileCount ?? 0) > 0,
                    ...(s.qualityProfileId === undefined ? {} : { qualityProfileId: s.qualityProfileId }),
                    ...((name => (name === undefined ? {} : { qualityProfile: name }))(
                        s.qualityProfileId === undefined ? undefined : profileNames.get(s.qualityProfileId)
                    )),
                    ...(s.path === undefined ? {} : { path: fenceText(s.path, { service: this.id, field: 'path' }) }),
                    ...(s.added === undefined || s.added === null ? {} : { addedAt: s.added }),
                    ...(s.statistics?.sizeOnDisk === undefined ? {} : { sizeBytes: s.statistics.sizeOnDisk })
                },
                // Flat, and labelled tvdb. Treating it as a per-source map is the
                // 0.3.0 defect that reported a source called `votes` worth 164018.
                ...((r => (r === undefined ? {} : { ratings: r }))(
                    (raw => (raw?.tvdb === undefined ? undefined : { tvdb: raw.tvdb }))(flattenSeriesRating(s.ratings))
                )),
                ...(seasons === undefined ? {} : { seasons }),
                ...((display => (display === undefined ? {} : { display }))(arrDisplay(s, this.id, 'series')))
            };
        });
    }
}
