import type { ConfigByService } from '../config/schema.ts';
import { LIBRARY_TTL_MS } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ArrAdapterBase } from './arrBase.ts';
import { seasonsOf, seriesHit } from './arrSeries.ts';
import type { IndexInput } from '../core/resolver.ts';
import { applyLimit } from '../core/shape.ts';
import { findArrBlocklistEntry, readArrBlocklist, removeArrBlocklistItem } from './arrBlocklist.ts';
import { readSeedCriteria } from './arrSeedCriteria.ts';
import { deleteArrMedia, readArrQueue, readSonarrCalendar, removeArrQueueItem, sonarrCalendarPath } from './arrQueue.ts';
import { audioLanguagesByFileId } from './arrMediaInfo.ts';
import { flattenSeriesRating, type RawRating } from './arrRatings.ts';
import {
    addArrMedia,
    lookupArrForAdd,
    readProfileNames,
    readQualityProfiles,
    readRootFolders,
    readTags,
    WHISPARR_ADD
} from './arrAdd.ts';
import { readArrProfileDiagnostics, readArrQualityProfile, updateArrQualityProfile } from './arrProfiles.ts';
import { postArrCommand, readArrCommands, refreshArrItem, renameArrItem } from './arrCommands.ts';
import { readArrHistory } from './arrHistory.ts';
import { arrGrabRecorded, traceArrDownload } from './arrDownloadTrace.ts';
import { findArrReleases, grabArrRelease } from './arrRelease.ts';
import { arrRecentLogs, arrStartLibraryScan, arrVersion } from './arrSystem.ts';
import {
    type AddCandidate,
    type AddMediaOptions,
    type BlocklistCapable,
    type BlocklistEntry,
    type Window,
    type IndexerSeedCriteria,
    type SeedCriteriaCapable,
    type CalendarCapable,
    type CalendarEntry,
    type CommandHandle,
    type CommandStatus,
    type CommandStatusCapable,
    type DownloadTrace,
    type DownloadTraceCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryQuery,
    type LogCapable,
    type RecentLogs,
    type DeleteMediaOptions,
    type DiskSpaceCapable,
    type EpisodeFile,
    type EpisodeFileCapable,
    type HealthCheckCapable,
    type LibraryCapable,
    type LibraryMaintenanceCapable,
    type LibraryScanCapable,
    type MediaAddCapable,
    type MediaDeleteCapable,
    type MediaDetailCapable,
    type MediaDetails,
    type MonitoringCapable,
    type MonitoringTarget,
    type ArrQualityProfileRecord,
    type ProfileDiagnosticsCapable,
    type ProfileDiagnosticsData,
    type ProfileFixCapable,
    type QualityProfile,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type ReleaseCandidate,
    type ReleaseScope,
    type ReleaseGrabCapable,
    type ReleaseSearchCapable,
    type RemoveQueueOptions,
    type RootFolder,
    type ScanStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type SearchTarget,
    type SearchTriggerCapable,
    type ServiceAdapter,
    type Tag
} from './types.ts';
import { parseVersion } from './versions.ts';

type RawSeries = {
    id?: number;
    title?: string;
    year?: number;
    overview?: string;
    monitored?: boolean;
    status?: string;
    path?: string;
    added?: string | null;
    genres?: string[];
    tvdbId?: number;
    imdbId?: string;
    qualityProfileId?: number;
    ratings?: RawRating;
    statistics?: { episodeFileCount?: number; sizeOnDisk?: number };
    seasons?: {
        seasonNumber?: number;
        monitored?: boolean;
        statistics?: { episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number };
    }[];
};

/**
 * Two fields Sonarr has and Whisparr does not, both confirmed absent from every
 * row of a live capture rather than inferred from the spec:
 *
 * - **No `episodeNumber`.** Scenes are not numbered within their year.
 * - **No `airDateUtc`.** A scene is dated by `releaseDate`, and as a bare date
 *   (`2026-09-02`) rather than a UTC timestamp.
 */
type RawEpisode = {
    id?: number;
    seasonNumber?: number;
    title?: string;
    releaseDate?: string;
    hasFile?: boolean;
    monitored?: boolean;
    /** 0 when the scene has no file: zero, not absence, as in Sonarr. */
    episodeFileId?: number;
};

type RawEpisodeFile = { id?: number; seasonNumber?: number; size?: number };

/** Whisparr's own name for the task, identical to Sonarr's because it is one. */
const LIBRARY_SCAN_TASK = 'RefreshSeries';

/**
 * Whisparr V2: a Sonarr fork on `/api/v3`, keeping Sonarr's nouns. A site is a
 * series and a scene is an episode, so the shared `arr*` helpers apply with the
 * `'series'` noun and `sizeOnDisk` nests under `statistics` exactly as Sonarr's
 * does.
 *
 * The shared binding (http, cache, version, disk, health, scan state) lives in
 * `ArrAdapterBase`.
 *
 * **A season here is a release year.** Sites have no seasons, so V2 groups
 * scenes by year and puts that in `seasonNumber`: a live instance reports 2006
 * through 2025, two to seven per site. Everything that merges or sorts on
 * season works unchanged, because the field is a populated integer either way,
 * but a caller passing `season: 1` matches nothing. The season-scoped writes
 * (set_monitoring, trigger_search, delete_episode_files) therefore refuse a
 * season the site does not have and list the years it does, rather than
 * writing a no-op and reporting success.
 *
 * **V2 only.** Whisparr ships as two incompatible applications answering on the
 * same path with the same header: V2 (this one) and V3 "Eros", a Radarr fork
 * whose scenes are `/movie` entries. Eros is a separate service id, not a
 * variant probed for at runtime, so every endpoint here stays static and no
 * fixture has to be invented for a shape nobody ran.
 *
 * Single-instance for the same reason: the one deployment that would want two
 * Whisparrs is V2 beside Eros during a migration, and that is already two keys.
 */
export class WhisparrAdapter
    extends ArrAdapterBase
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        HealthCheckCapable,
        LogCapable,
        HistoryCapable,
        DownloadTraceCapable,
        CommandStatusCapable,
        LibraryScanCapable,
        ScanStateCapable,
        CalendarCapable,
        MediaAddCapable,
        MediaDeleteCapable,
        MediaDetailCapable,
        SearchCapable,
        LibraryCapable,
        EpisodeFileCapable,
        BlocklistCapable,
        QueueCapable,
        QueueRemoveCapable,
        LibraryMaintenanceCapable,
        MonitoringCapable,
        SearchTriggerCapable,
        ReleaseSearchCapable,
        ReleaseGrabCapable,
        ProfileDiagnosticsCapable,
        ProfileFixCapable,
        SeedCriteriaCapable
{
    protected readonly scanTask = LIBRARY_SCAN_TASK;

    constructor(config: ConfigByService['whisparr'], fetchImpl: typeof fetch = fetch) {
        super('whisparr', config, fetchImpl);
    }

    /**
     * Rejects Eros by name rather than letting it through.
     *
     * `assertVersionSupported` only has a floor, and Eros is 3.x: above it. So
     * an Eros instance configured here would connect cleanly and then fail on
     * the first `/series` read, which Eros does not serve. There is nothing in
     * the URL or the credential to tell the two apart, so the version is the
     * only place this can be caught, and it has to say which application it
     * found.
     */
    override async getVersion(): Promise<string> {
        const raw = await arrVersion(this.http, this.id);
        const parsed = parseVersion(raw);
        const major = parsed?.[0];
        if (parsed !== undefined && major !== 2) {
            throw new ServiceError('VersionUnsupported', this.id, `reports version ${parsed.join('.')}`, {
                remedy:
                    'This looks like Whisparr Eros (V3), which is a Radarr fork and a different API. ' +
                    'The `whisparr` service is Whisparr V2 only.'
            });
        }
        return raw;
    }

    async getRecentLogs(): Promise<RecentLogs> {
        return arrRecentLogs(this.http, this.id);
    }

    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        return readArrHistory(this.http, this.id, 'series', opts, 'seriesEndpoint');
    }

    async traceDownload(downloadId: string): Promise<DownloadTrace | undefined> {
        return traceArrDownload(this.http, this.id, 'series', downloadId, 'seriesEndpoint');
    }

    async listCommands(): Promise<CommandStatus[]> {
        return readArrCommands(this.http, this.id);
    }

    async startLibraryScan(): Promise<CommandHandle> {
        return arrStartLibraryScan(this.http, this.id, LIBRARY_SCAN_TASK);
    }

    readonly queueKind = 'series';

    async getQueue(): Promise<QueueItem[]> {
        return readArrQueue(this.http, this.id, this.queueKind);
    }

    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        return removeArrQueueItem(this.http, this.id, id, opts);
    }

    async grabRecorded(downloadId: string): Promise<boolean> {
        return arrGrabRecorded(this.http, this.id, downloadId);
    }

    /** Deletes the whole site. Sonarr's `series` resource: Whisparr keeps the noun. */
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

    async readQualityProfile(id: number): Promise<ArrQualityProfileRecord> {
        return readArrQualityProfile(this.http, id);
    }

    async updateQualityProfile(profile: ArrQualityProfileRecord): Promise<void> {
        return updateArrQualityProfile(this.http, profile);
    }

    /** Sonarr resolves by TVDB id: Whisparr reuses the same field for its own
     *  scene-database id, per WHISPARR_ADD. */
    async lookupForAdd(externalId: string): Promise<AddCandidate> {
        return lookupArrForAdd(this.http, this.id, WHISPARR_ADD, externalId);
    }

    async addMedia(opts: AddMediaOptions): Promise<{ id: number; title: string }> {
        return addArrMedia(this.http, this.id, WHISPARR_ADD, opts);
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

    /** `releaseDate`, not `airDateUtc`: the shared reader filters out every row
     *  missing the field it is told to date by, so the default would return an
     *  empty calendar here rather than an error. */
    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const episodes = await this.http.get<Parameters<typeof readSonarrCalendar>[0]>(sonarrCalendarPath(this.http.apiRoot, range));
        return readSonarrCalendar(episodes, this.id, 'releaseDate');
    }

    async listEpisodeFiles(seriesId: string): Promise<EpisodeFile[]> {
        const id = this.numericId('site', seriesId);
        const files = await this.http.get<RawEpisodeFile[]>(`/api/v3/episodefile?seriesId=${id}`);

        return files
            .filter((f): f is RawEpisodeFile & { id: number } => typeof f.id === 'number')
            .map(f => ({
                id: f.id,
                season: f.seasonNumber ?? 0,
                ...(f.size === undefined ? {} : { sizeBytes: f.size })
            }));
    }

    async deleteEpisodeFiles(fileIds: number[]): Promise<void> {
        if (fileIds.length === 0) return;
        await this.http.deleteWithBody('/api/v3/episodefile/bulk', { episodeFileIds: fileIds });
    }

    /**
     * Sonarr's shape exactly, and for Sonarr's reason: the PUT replaces the
     * series wholesale, so the site is read back and returned with one field
     * changed. `opts.season` is a release year.
     */
    async setMonitoring(id: string, opts: MonitoringTarget): Promise<void> {
        if (opts.episodeIds !== undefined) {
            const episodeIds = opts.episodeIds.map(e => this.numericId('scene', e));
            await this.http.put('/api/v3/episode/monitor', { episodeIds, monitored: opts.monitored }, true);
            return;
        }

        const seriesId = this.numericId('site', id);
        const series = await this.http.get<RawSeries & { id: number }>(`/api/v3/series/${seriesId}`);

        if (opts.season === undefined) {
            await this.http.put(`/api/v3/series/${seriesId}`, { ...series, monitored: opts.monitored }, true);
            return;
        }

        const seasons = (series.seasons ?? []).map(s =>
            s.seasonNumber === opts.season ? { ...s, monitored: opts.monitored } : s
        );
        await this.http.put(`/api/v3/series/${seriesId}`, { ...series, seasons }, true);
    }

    /**
     * Sonarr's command names and payloads, which V2 inherits unchanged. None
     * of the three has been posted from here against a live instance, because
     * each runs a real search on the operator's indexers; the shapes are the
     * ones `sonarr.ts` uses, with `seasonNumber` carrying a release year.
     */
    async triggerSearch(id: string, target?: SearchTarget): Promise<CommandHandle> {
        const seriesId = this.numericId('site', id);
        const payload =
            target?.episodes !== undefined
                ? { name: 'EpisodeSearch', episodeIds: target.episodes.map(e => this.numericId('scene', e)) }
                : target?.season !== undefined
                  ? { name: 'SeasonSearch', seriesId, seasonNumber: target.season }
                  : { name: 'SeriesSearch', seriesId };

        return postArrCommand(this.http, this.id, payload);
    }

    async refreshItem(id: string): Promise<CommandHandle> {
        return refreshArrItem(this.http, this.id, 'series', id);
    }

    async renameItem(id: string): Promise<CommandHandle> {
        return renameArrItem(this.http, this.id, 'series', id);
    }

    async findReleases(opts: ReleaseScope): Promise<ReleaseCandidate[]> {
        return findArrReleases(this.http, this.id, 'site', opts);
    }

    async grabRelease(opts: { guid: string; indexerId: number }): Promise<void> {
        return grabArrRelease(this.http, opts);
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
                    // Always 0: Whisparr sends no `episodeNumber`, because scenes
                    // are not numbered within their year. Zero is what Sonarr's
                    // absent-episode case already produces, so consumers need no
                    // second shape, but it means episode number cannot identify a
                    // scene here, and only `id` can.
                    episode: 0,
                    title: fenceText(e.title ?? '', { service: this.id, field: 'episode.title' }),
                    ...(e.releaseDate === undefined ? {} : { airDate: e.releaseDate }),
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

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        const term = query.toLowerCase();

        if (source === 'library') {
            const series = await this.#allSeries();
            return series.filter(s => (s.title ?? '').toLowerCase().includes(term)).map(s => seriesHit(this.id, s, 'library'));
        }

        if (source === 'discover') {
            const found = await this.http.get<RawSeries[]>(
                `/api/v3/series/lookup?term=${encodeURIComponent(query)}`
            );
            return found.map(s => seriesHit(this.id, s, 'discover'));
        }

        return [];
    }

    /** The `/api/v3/series` read behind both `search(_, 'library')` and
     *  `listLibrary`: Whisparr has no server-side filter, so both need the
     *  whole list, and this is where they share one fetch for it. */
    #allSeries(): Promise<RawSeries[]> {
        return this.libraryCache.get('series', LIBRARY_TTL_MS, () => this.http.get<RawSeries[]>('/api/v3/series'));
    }

    async listLibrary(): Promise<IndexInput[]> {
        const [series, profileNames] = await Promise.all([this.#allSeries(), readProfileNames(this.http, this.id, this.libraryCache)]);

        return series.map(s => {
            const seasons = seasonsOf(s);
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
                    ...(s.id === undefined || s.id <= 0 ? {} : { id: String(s.id) }),
                    ...(s.status === undefined ? {} : { status: s.status }),
                    monitored: s.monitored ?? false,
                    // A site has no single file, so "has a file" means "has any
                    // scene on disk": the same stand-in Sonarr makes for a
                    // series, and the same reason there is no quality here.
                    hasFile: (s.statistics?.episodeFileCount ?? 0) > 0,
                    ...(s.qualityProfileId === undefined ? {} : { qualityProfileId: s.qualityProfileId }),
                    ...((name => (name === undefined ? {} : { qualityProfile: name }))(
                        s.qualityProfileId === undefined ? undefined : profileNames.get(s.qualityProfileId)
                    )),
                    ...(s.path === undefined ? {} : { path: fenceText(s.path, { service: this.id, field: 'path' }) }),
                    ...(s.added === undefined || s.added === null ? {} : { addedAt: s.added }),
                    ...(s.statistics?.sizeOnDisk === undefined ? {} : { sizeBytes: s.statistics.sizeOnDisk })
                },
                ...((r => (r === undefined ? {} : { ratings: r }))(
                    (raw => (raw?.tvdb === undefined ? undefined : { tvdb: raw.tvdb }))(flattenSeriesRating(s.ratings))
                )),
                ...(seasons === undefined ? {} : { seasons })
            };
        });
    }
}
