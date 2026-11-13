import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText, fencer } from '../core/fence.ts';
import { instantOf } from '../core/instant.ts';
import { LOG_LINES, foldLogLines } from './logLines.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type LogCapable,
    type MissingLanguage,
    type RecentLogs,
    type ServiceAdapter,
    type SubtitleCapable,
    type SubtitleGap,
    type SubtitleItem,
    type SubtitleProvider,
    type SubtitleSearchCapable,
    type SubtitleSearchTarget
} from './types.ts';

/**
 * Hand-written, and checked by the contract test against recorded fixtures
 * rather than a spec. Bazarr does serve swagger 2.0 at `/api/swagger.json`,
 * useful for finding endpoints, but codegen here targets OpenAPI 3.
 *
 * Confirmed against a live Bazarr 1.6.0: every payload is wrapped in
 * `{ data: … }`, and the version field is `bazarr_version`.
 */
type Envelope<T> = { data?: T };
/** `timezone` is the zone Bazarr writes its local times in, such as `Europe/Amsterdam`. */
type RawStatus = { bazarr_version?: string; timezone?: string };
type RawHealth = { object?: string; issue?: string };
type RawLogRow = { timestamp?: string; type?: string; message?: string };
/** Python's level names, as the *arrs spell the ones they share. INFO and DEBUG are not faults. */
const LOG_LEVELS = new Map([
    ['WARNING', 'warn'],
    ['ERROR', 'error'],
    ['CRITICAL', 'critical']
]);
type RawMissing = { name?: string; code2?: string; forced?: boolean; hi?: boolean };
type RawWantedMovie = { radarrId?: number; title?: string; sceneName?: string | null; missing_subtitles?: RawMissing[] };
type RawWantedEpisode = {
    sonarrEpisodeId?: number;
    sonarrSeriesId?: number;
    seriesTitle?: string;
    episodeTitle?: string;
    /** Combined, as `"5x2"`: Bazarr has no separate season/episode fields. */
    episode_number?: string;
    sceneName?: string | null;
    missing_subtitles?: RawMissing[];
};

/** A row of `/api/episodes`, which carries the season and episode as numbers and no series title. */
type RawSeriesEpisode = {
    sonarrEpisodeId?: number;
    sonarrSeriesId?: number;
    title?: string;
    season?: number;
    episode?: number;
    sceneName?: string | null;
    missing_subtitles?: RawMissing[];
};
type RawSeries = { sonarrSeriesId?: number; title?: string };

/**
 * Bazarr reports the position as a single `"5x2"` string rather than separate
 * numbers, confirmed against a live Bazarr 1.6.0. Reading `season` and
 * `episode`, which is what this adapter did first, silently returned nothing
 * for every episode.
 */
function parseEpisodeNumber(value: string | undefined): { season?: number; episode?: number } {
    const match = /^(\d+)x(\d+)$/.exec(value ?? '');
    if (match === null) return {};
    return { season: Number(match[1]), episode: Number(match[2]) };
}
type RawProvider = { name?: string; status?: string; retry?: string };

type RawHistory = {
    id?: number;
    action?: number | string;
    title?: string;
    description?: string;
    language?: string;
    provider?: string;
    /** Epoch seconds on some builds, a relative string ("2 days ago") on
     *  others: see `bazarrTimestamp`. */
    timestamp?: number | string;
    /** `MM/DD/YY HH:MM:SS`, as Bazarr's own UI formats it. */
    parsed_timestamp?: string;
};

/** How far `zone`'s wall clock is ahead of UTC at instant `t`, in ms; `undefined` for a zone Intl does not know. */
function zoneOffset(t: number, zone: string): number | undefined {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric'
        }).formatToParts(new Date(t));
        const n = (type: string) => Number(parts.find(p => p.type === type)?.value);
        const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
        return Number.isFinite(wall) ? wall - Math.floor(t / 1000) * 1000 : undefined;
    } catch {
        return undefined;
    }
}

/**
 * ISO 8601, or nothing.
 *
 * Bazarr has shipped two different `timestamp` shapes, and its
 * `parsed_timestamp` is a US-ordered local time with a two-digit year, in the
 * zone `/api/system/status` names. With that zone it becomes `toISOString()`.
 * Without one it stays a local time with no offset rather than claim UTC: a
 * Bazarr in Amsterdam would otherwise be an hour or two out. A row matching
 * neither shape is dropped by the caller rather than dated: a guessed date
 * does not merely mislabel one row, it reorders the answer.
 */
export function bazarrTimestamp(h: { timestamp?: number | string; parsed_timestamp?: string }, zone?: string): string | undefined {
    if (typeof h.timestamp === 'number' && Number.isFinite(h.timestamp)) {
        return new Date(h.timestamp * 1000).toISOString();
    }

    const match = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(h.parsed_timestamp ?? '');
    if (match === null) return undefined;

    const [, month, day, year, hour, minute, second] = match;
    const local = `20${year}-${month}-${day}T${hour}:${minute}:${second}`;
    const wall = Date.parse(`${local}Z`);
    if (!Number.isFinite(wall)) return undefined;
    if (zone === undefined) return local;

    // The offset at the wall time read as UTC is a first guess; across a DST
    // change it can be an hour off, so it is taken again at the result.
    const first = zoneOffset(wall, zone);
    if (first === undefined) return local;
    const settled = zoneOffset(wall - first, zone) ?? first;
    return new Date(wall - settled).toISOString();
}

export class BazarrAdapter
    implements ServiceAdapter, HealthCheckCapable, LogCapable, SubtitleCapable, SubtitleSearchCapable, HistoryCapable
{
    readonly type: ServiceId = 'bazarr';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;
    /** Bazarr's own time zone, read once from its status. */
    #zone: string | undefined;

    constructor(config: ConfigByService['bazarr'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('bazarr', config.name);
        // Bazarr spells the header X-API-KEY, not X-Api-Key. Header names are
        // case-insensitive per RFC 9110, so this is cosmetic, but it matches
        // Bazarr's own documentation, which is what a reader will compare to.
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-API-KEY', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const body = await this.#http.get<Envelope<RawStatus>>('/api/system/status');
        const version = body.data?.bazarr_version;
        if (!version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return version;
    }

    /**
     * Bazarr reports problems rather than a pass/fail per check, so every row
     * returned is a failure. There is no `ok` type to filter out, and the
     * shared HealthCheck shape wants one: `warning` is the honest mapping.
     */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const body = await this.#http.get<Envelope<RawHealth[]>>('/api/system/health');
        return (body.data ?? []).map(row => ({
            service: this.id,
            source: row.object ?? 'bazarr',
            type: 'warning',
            message: fenceText(row.issue ?? '', { service: this.id, field: 'message' })
        }));
    }

    /**
     * Bazarr answers with its whole current log at every level and cannot filter,
     * so the filter and the limit are here, and `total` counts warnings and worse
     * like the other services' logs. It has no logger field, and its times are
     * local with no offset, so they stay that way rather than claim a zone.
     */
    async getRecentLogs(): Promise<RecentLogs> {
        const body = await this.#http.get<Envelope<RawLogRow[]>>('/api/system/logs');
        const lines = (body.data ?? []).flatMap(row => {
            const level = LOG_LEVELS.get(row.type ?? '');
            return level !== undefined && typeof row.timestamp === 'string'
                ? [{ time: row.timestamp.replace(' ', 'T'), level, logger: 'bazarr', message: row.message ?? '' }]
                : [];
        });
        const newest = lines.slice(0, LOG_LINES);
        return { entries: foldLogLines(newest, this.id), read: newest.length, total: lines.length };
    }

    /**
     * Two endpoints, one list. `sceneName` is a release name straight from an
     * indexer, so it is fenced here rather than anywhere downstream.
     *
     * A failure in either throws; the tool converts that into `degraded`,
     * which is where the design spec wants partial-result handling to live.
     */
    async getMissingSubtitles(): Promise<SubtitleGap[]> {
        const [movies, episodes] = await Promise.all([
            this.#http.get<Envelope<RawWantedMovie[]>>('/api/movies/wanted'),
            this.#http.get<Envelope<RawWantedEpisode[]>>('/api/episodes/wanted')
        ]);

        const movieGaps = (movies.data ?? []).flatMap(m => this.#movieGap(m) ?? []);
        const episodeGaps = (episodes.data ?? []).flatMap(e => {
            if (typeof e.sonarrEpisodeId !== 'number') return [];
            const { season, episode } = parseEpisodeNumber(e.episode_number);
            return [
                this.#episodeGap({
                    id: e.sonarrEpisodeId,
                    seriesId: e.sonarrSeriesId,
                    seriesTitle: e.seriesTitle,
                    episodeTitle: e.episodeTitle,
                    season,
                    episode,
                    sceneName: e.sceneName,
                    missing: e.missing_subtitles
                })
            ];
        });

        return [...movieGaps, ...episodeGaps];
    }

    /**
     * One film's or one series' gaps, without reading the whole library's.
     *
     * Confirmed against a live Bazarr 1.6.0: `movies/wanted` honours
     * `radarrid[]`, but `episodes/wanted` ignores `seriesid[]`, so a series is
     * read from `episodes` (which honours it; the rows with a missing subtitle
     * are exactly that series' rows in the wanted list) plus `series` for the
     * title the wanted list would have carried.
     *
     * The answer is filtered by id here as well: a Bazarr that ignores a
     * parameter costs time, never a gap that belongs to another title.
     */
    async getMissingSubtitlesFor(item: SubtitleItem): Promise<SubtitleGap[]> {
        if (item.kind === 'movie') {
            const body = await this.#http.get<Envelope<RawWantedMovie[]>>(`/api/movies/wanted?radarrid[]=${item.id}`);
            return (body.data ?? []).filter(m => m.radarrId === item.id).flatMap(m => this.#movieGap(m) ?? []);
        }

        const [episodes, series] = await Promise.all([
            this.#http.get<Envelope<RawSeriesEpisode[]>>(`/api/episodes?seriesid[]=${item.seriesId}`),
            this.#http.get<Envelope<RawSeries[]>>(`/api/series?seriesid[]=${item.seriesId}`)
        ]);
        const seriesTitle = (series.data ?? []).find(s => s.sonarrSeriesId === item.seriesId)?.title;

        const mine = (episodes.data ?? []).filter(
            e => e.sonarrSeriesId === item.seriesId && typeof e.sonarrEpisodeId === 'number' && (e.missing_subtitles ?? []).length > 0
        );
        // Without the series row the gaps cannot be tied to a title, and the chain would read them as none missing.
        if (seriesTitle === undefined && mine.length > 0) {
            throw new ServiceError('UpstreamError', this.id, `series ${item.seriesId} has episodes but no series row`);
        }

        return mine.flatMap(e =>
            typeof e.sonarrEpisodeId === 'number'
                ? [
                      this.#episodeGap({
                          id: e.sonarrEpisodeId,
                          seriesId: e.sonarrSeriesId,
                          seriesTitle,
                          episodeTitle: e.title,
                          season: e.season,
                          episode: e.episode,
                          sceneName: e.sceneName,
                          missing: e.missing_subtitles
                      })
                  ]
                : []
        );
    }

    /**
     * Checked live against Bazarr 1.6: both routes filter by the id, and
     * answer 200 with no rows for one Bazarr does not have. An episode row
     * carries its series id but not the series title, so that is one more read.
     */
    async readSubtitleItem(kind: 'movie' | 'episode', id: number): Promise<SubtitleGap | undefined> {
        if (kind === 'movie') {
            const body = await this.#http.get<Envelope<RawWantedMovie[]>>(`/api/movies?radarrid[]=${id}`);
            const row = (body.data ?? []).find(m => m.radarrId === id);
            return row === undefined ? undefined : this.#movieGap(row);
        }

        const body = await this.#http.get<Envelope<RawSeriesEpisode[]>>(`/api/episodes?episodeid[]=${id}`);
        const row = (body.data ?? []).find(e => e.sonarrEpisodeId === id);
        if (row === undefined) return undefined;
        const seriesId = row.sonarrSeriesId;
        const series =
            typeof seriesId === 'number' ? await this.#http.get<Envelope<RawSeries[]>>(`/api/series?seriesid[]=${seriesId}`) : undefined;
        return this.#episodeGap({
            id,
            seriesId,
            seriesTitle: (series?.data ?? []).find(s => s.sonarrSeriesId === seriesId)?.title,
            episodeTitle: row.title,
            season: row.season,
            episode: row.episode,
            sceneName: row.sceneName,
            missing: row.missing_subtitles
        });
    }

    #language(m: RawMissing): MissingLanguage {
        return {
            name: m.name ?? 'unknown',
            code2: m.code2 ?? '??',
            forced: m.forced ?? false,
            hearingImpaired: m.hi ?? false
        };
    }

    #movieGap(m: RawWantedMovie): SubtitleGap | undefined {
        if (typeof m.radarrId !== 'number') return undefined;
        const fence = fencer(this.id);
        return {
            service: this.id,
            kind: 'movie',
            id: m.radarrId,
            title: fence(m.title ?? '', 'title'),
            ...(typeof m.sceneName === 'string' ? { releaseName: fence(m.sceneName, 'sceneName') } : {}),
            missing: (m.missing_subtitles ?? []).map(l => this.#language(l))
        };
    }

    #episodeGap(e: {
        id: number;
        seriesId: number | undefined;
        seriesTitle: string | undefined;
        episodeTitle: string | undefined;
        season: number | undefined;
        episode: number | undefined;
        sceneName: string | null | undefined;
        missing: RawMissing[] | undefined;
    }): SubtitleGap {
        const fence = fencer(this.id);
        return {
            service: this.id,
            kind: 'episode',
            id: e.id,
            ...(typeof e.seriesId === 'number' ? { seriesId: e.seriesId } : {}),
            title: fence(e.seriesTitle ?? '', 'seriesTitle'),
            ...(e.episodeTitle === undefined ? {} : { episodeTitle: fence(e.episodeTitle, 'episodeTitle') }),
            ...(e.season === undefined ? {} : { season: e.season }),
            ...(e.episode === undefined ? {} : { episode: e.episode }),
            ...(typeof e.sceneName === 'string' ? { releaseName: fence(e.sceneName, 'sceneName') } : {}),
            missing: (e.missing ?? []).map(l => this.#language(l))
        };
    }

    /**
     * Bazarr reports a healthy provider as `status: "Good"` and an unhealthy
     * one with the provider's own error text, so
     * `healthy` is derived here rather than making every caller know that
     * string. The status text is provider-supplied and therefore fenced.
     *
     * **Compared case-insensitively.** A live Bazarr 1.6.0 returns `"Good"`
     * with a capital G; an exact lowercase match, which is what this did
     * first, reported every healthy provider as broken.
     *
     * `retry` carries a sentinel when nothing is scheduled: `"-"` on the
     * instance captured, `"End of information"` on others seen in the wild.
     * Either would land a sentence in a date field for a model to read as a
     * time, so both are treated as absent.
     */
    async getProviders(): Promise<SubtitleProvider[]> {
        const body = await this.#http.get<Envelope<RawProvider[]>>('/api/providers');
        const NO_RETRY = new Set(['-', 'end of information', '']);

        return (body.data ?? [])
            .filter((p): p is RawProvider & { name: string } => typeof p.name === 'string')
            .map(p => {
                const healthy = (p.status ?? '').toLowerCase() === 'good';
                const retry =
                    p.retry !== undefined && !NO_RETRY.has(p.retry.trim().toLowerCase()) ? p.retry : undefined;
                return {
                    service: this.id,
                    name: p.name,
                    healthy,
                    ...(healthy || p.status === undefined
                        ? {}
                        : { status: fenceText(p.status, { service: this.id, field: 'status' }) }),
                    ...(retry === undefined ? {} : { retryAt: retry })
                };
            });
    }

    /**
     * Bazarr takes every argument in the query string and answers 204. It
     * queues the search, so this resolving means asked, never found.
     */
    async triggerSubtitleSearch(target: SubtitleSearchTarget): Promise<void> {
        const query = new URLSearchParams({
            language: target.language,
            forced: String(target.forced),
            hi: String(target.hearingImpaired)
        });

        if (target.kind === 'movie') {
            query.set('radarrid', String(target.id));
            await this.#http.patch(`/api/movies/subtitles?${query.toString()}`);
            return;
        }

        if (target.seriesId === undefined) {
            throw new ServiceError('NotFound', this.id, 'an episode subtitle search needs the series id as well', {
                remedy: 'Take both ids from get_subtitles.'
            });
        }
        query.set('seriesid', String(target.seriesId));
        query.set('episodeid', String(target.id));
        await this.#http.patch(`/api/episodes/subtitles?${query.toString()}`);
    }

    /**
     * What Bazarr has actually downloaded: the half `get_subtitles` cannot
     * show, since that lists only what is still missing. Films and episodes
     * are two endpoints, one list, exactly as the wanted read is.
     *
     * **Dates are the awkward part.** `timestamp` is a *relative* string
     * ("2 days ago") on the versions seen; `parsed_timestamp` is
     * `MM/DD/YY HH:MM:SS` in Bazarr's own zone. A row whose date cannot be
     * read is dropped rather than dated: an invented date would quietly
     * reorder everything `get_history` merges it with.
     */
    async readHistory(opts: { id?: string; since?: string }): Promise<HistoryEntry[]> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'Bazarr history is not scoped by a Radarr or Sonarr id here', {
                remedy: 'Scope `id` to radarr or sonarr. Bazarr answers for the whole subtitle history.'
            });
        }

        const [movies, episodes, zone] = await Promise.all([
            this.#http.get<Envelope<RawHistory[]>>('/api/movies/history?length=100'),
            this.#http.get<Envelope<RawHistory[]>>('/api/episodes/history?length=100'),
            this.#timeZone()
        ]);

        const rows = [...(movies.data ?? []), ...(episodes.data ?? [])].flatMap((h, index) => {
            const at = bazarrTimestamp(h, zone);
            if (at === undefined) return [];
            if (opts.since !== undefined && instantOf(at) < instantOf(opts.since)) return [];

            const parts = [h.language, h.provider].filter((p): p is string => typeof p === 'string' && p !== '');
            return [
                {
                    service: this.id,
                    id: String(h.id ?? index),
                    at,
                    event: 'subtitle' as const,
                    rawEvent: String(h.action ?? 'subtitle'),
                    title: fenceText(h.title ?? '', { service: this.id, field: 'title' }),
                    ...(parts.length === 0
                        ? {}
                        : { quality: fenceText(parts.join(' · '), { service: this.id, field: 'provider' }) }),
                    ...(h.description
                        ? { reason: fenceText(h.description, { service: this.id, field: 'description' }) }
                        : {})
                }
            ];
        });

        return rows;
    }

    /** Unknown when the status read fails or names no zone; the history then stays in local time. */
    async #timeZone(): Promise<string | undefined> {
        if (this.#zone !== undefined) return this.#zone;
        const body = await this.#http.get<Envelope<RawStatus>>('/api/system/status').catch(() => undefined);
        const zone = body?.data?.timezone;
        if (typeof zone === 'string' && zone !== '') this.#zone = zone;
        return this.#zone;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
