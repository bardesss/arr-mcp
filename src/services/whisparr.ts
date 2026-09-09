import type { Instanced, KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import type { IndexInput, SeasonSummary } from '../core/resolver.ts';
import { applyLimit } from '../core/shape.ts';
import { readArrBlocklist, removeArrBlocklistItem } from './arrBlocklist.ts';
import { readSonarrCalendar, sonarrCalendarPath } from './arrQueue.ts';
import { flattenSeriesRating, type RawRating } from './arrRatings.ts';
import { readQualityProfiles } from './arrAdd.ts';
import { arrDiskSpace, arrFailedHealthChecks, arrScanState, arrStartLibraryScan, arrVersion } from './arrSystem.ts';
import {
    diagnoseConnection,
    type BlocklistCapable,
    type BlocklistEntry,
    type CalendarCapable,
    type CalendarEntry,
    type CommandHandle,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type EpisodeFile,
    type EpisodeFileCapable,
    type HealthCheck,
    type HealthCheckCapable,
    type LibraryCapable,
    type LibraryScanCapable,
    type MediaDetailCapable,
    type MediaDetails,
    type ScanState,
    type ScanStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
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
    /** 0 when the scene has no file — zero, not absence, as in Sonarr. */
    episodeFileId?: number;
};

type RawEpisodeFile = { id?: number; seasonNumber?: number; size?: number };

/** Whisparr's own name for the task, identical to Sonarr's because it is one. */
const LIBRARY_SCAN_TASK = 'RefreshSeries';

/**
 * Whisparr V2 — a Sonarr fork on `/api/v3`, keeping Sonarr's nouns. A site is a
 * series and a scene is an episode, so the shared `arr*` helpers apply with the
 * `'series'` noun and `sizeOnDisk` nests under `statistics` exactly as Sonarr's
 * does.
 *
 * This adapter binds to those helpers the way `sonarr.ts` does rather than
 * sharing a base class with it. The sharing already exists one level down — the
 * `arr*` helpers are the shared code, and `radarr.ts` and `sonarr.ts` already
 * duplicate this binding layer rather than abstract it.
 *
 * **A season here is a release year.** Sites have no seasons, so V2 groups
 * scenes by year and puts that in `seasonNumber`: a live instance reports 2006
 * through 2025, two to seven per site. Everything that merges or sorts on
 * season works unchanged, because the field is a populated integer either way —
 * but a caller passing `season: 1` matches nothing, which is why this adapter
 * implements no season-scoped write yet.
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
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        HealthCheckCapable,
        LibraryScanCapable,
        ScanStateCapable,
        CalendarCapable,
        MediaDetailCapable,
        SearchCapable,
        LibraryCapable,
        EpisodeFileCapable,
        BlocklistCapable
{
    readonly type: ServiceId = 'whisparr';
    readonly instance: string | undefined = undefined;
    readonly id: string = 'whisparr';
    readonly #http: ServiceHttp;

    /** Shared by `search(_, 'library')` and `listLibrary`, both of which read
     *  the whole `/api/v3/series` list — Whisparr has no server-side filter. */
    readonly #libraryCache = new TtlCache();

    constructor(config: Instanced<KeyedServiceConfig>, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    /**
     * Rejects Eros by name rather than letting it through.
     *
     * `assertVersionSupported` only has a floor, and Eros is 3.x — above it. So
     * an Eros instance configured here would connect cleanly and then fail on
     * the first `/series` read, which Eros does not serve. There is nothing in
     * the URL or the credential to tell the two apart, so the version is the
     * only place this can be caught, and it has to say which application it
     * found.
     */
    async getVersion(): Promise<string> {
        const raw = await arrVersion(this.#http, this.id);
        const major = parseVersion(raw)?.[0];
        if (major !== undefined && major !== 2) {
            throw new ServiceError('VersionUnsupported', this.id, `reports version ${raw}`, {
                remedy:
                    'This looks like Whisparr Eros (V3), which is a Radarr fork and a different API. ' +
                    'The `whisparr` service is Whisparr V2 only.'
            });
        }
        return raw;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        return arrDiskSpace(this.#http, this.id);
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        return arrFailedHealthChecks(this.#http, this.id);
    }

    async startLibraryScan(): Promise<CommandHandle> {
        return arrStartLibraryScan(this.#http, this.id, LIBRARY_SCAN_TASK);
    }

    async getScanState(): Promise<ScanState> {
        return arrScanState(this.#http, this.id, LIBRARY_SCAN_TASK);
    }

    async readBlocklist(): Promise<BlocklistEntry[]> {
        return readArrBlocklist(this.#http, this.id, 'series');
    }

    async removeBlocklistItem(id: string): Promise<void> {
        return removeArrBlocklistItem(this.#http, id);
    }

    readonly supportsBlocklist = true;

    /** `releaseDate`, not `airDateUtc`: the shared reader filters out every row
     *  missing the field it is told to date by, so the default would return an
     *  empty calendar here rather than an error. */
    async getCalendar(range: { start: Date; end: Date }): Promise<CalendarEntry[]> {
        const episodes = await this.#http.get<Parameters<typeof readSonarrCalendar>[0]>(sonarrCalendarPath(range));
        return readSonarrCalendar(episodes, this.id, 'releaseDate');
    }

    #numericId(value: string, what: string): number {
        const id = Number(value);
        if (!Number.isInteger(id)) {
            throw new ServiceError('NotFound', this.id, `"${value}" is not a Whisparr ${what} id`, {
                remedy: `Whisparr ${what} ids are integers. Take one from \`acquisition.id\` on get_library or get_media_details.`
            });
        }
        return id;
    }

    async listEpisodeFiles(seriesId: string): Promise<EpisodeFile[]> {
        const id = this.#numericId(seriesId, 'site');
        const files = await this.#http.get<RawEpisodeFile[]>(`/api/v3/episodefile?seriesId=${id}`);

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
        await this.#http.deleteWithBody('/api/v3/episodefile/bulk', { episodeFileIds: fileIds });
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
                // Always 0: Whisparr sends no `episodeNumber`, because scenes
                // are not numbered within their year. Zero is what Sonarr's
                // absent-episode case already produces, so consumers need no
                // second shape — but it means episode number cannot identify a
                // scene here, and only `id` can.
                episode: 0,
                title: fenceText(e.title ?? '', { service: this.id, field: 'episode.title' }),
                ...(e.releaseDate === undefined ? {} : { airDate: e.releaseDate }),
                hasFile: e.hasFile ?? false,
                monitored: e.monitored ?? false,
                ...(e.episodeFileId === undefined ? {} : { episodeFileId: e.episodeFileId })
            })),
            episodeCount: shaped.total,
            episodesTruncated: shaped.truncated
        };
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        const term = query.toLowerCase();

        if (source === 'library') {
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

    #allSeries(): Promise<RawSeries[]> {
        return this.#libraryCache.get('series', LIBRARY_TTL_MS, () => this.#http.get<RawSeries[]>('/api/v3/series'));
    }

    invalidateLibrary(): void {
        this.#libraryCache.clear();
    }

    /** Profile id → fenced name, cached beside the library read. Empty on
     *  failure, as in Radarr and Sonarr: a missing label must not fail a read. */
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

    async listLibrary(): Promise<IndexInput[]> {
        const [series, profileNames] = await Promise.all([this.#allSeries(), this.#profileNames()]);

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
                    ...(s.id === undefined || s.id <= 0 ? {} : { id: String(s.id) }),
                    ...(s.status === undefined ? {} : { status: s.status }),
                    monitored: s.monitored ?? false,
                    // A site has no single file, so "has a file" means "has any
                    // scene on disk" — the same stand-in Sonarr makes for a
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
