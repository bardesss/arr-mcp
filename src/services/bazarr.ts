import { instanceId } from '../config/instances.ts';
import type { Instanced, KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type MissingLanguage,
    type ServiceAdapter,
    type SubtitleCapable,
    type SubtitleGap,
    type SubtitleProvider,
    type SubtitleSearchCapable,
    type SubtitleSearchTarget
} from './types.ts';

/**
 * Hand-written, and checked by the contract test against recorded fixtures
 * rather than a spec. Bazarr does serve swagger 2.0 at `/api/swagger.json` —
 * useful for finding endpoints — but codegen here targets OpenAPI 3.
 *
 * Confirmed against a live Bazarr 1.6.0: every payload is wrapped in
 * `{ data: … }`, and the version field is `bazarr_version`.
 */
type Envelope<T> = { data?: T };
type RawStatus = { bazarr_version?: string };
type RawHealth = { object?: string; issue?: string };
type RawMissing = { name?: string; code2?: string; forced?: boolean; hi?: boolean };
type RawWantedMovie = { radarrId?: number; title?: string; sceneName?: string | null; missing_subtitles?: RawMissing[] };
type RawWantedEpisode = {
    sonarrEpisodeId?: number;
    sonarrSeriesId?: number;
    seriesTitle?: string;
    episodeTitle?: string;
    /** Combined, as `"5x2"` — Bazarr has no separate season/episode fields. */
    episode_number?: string;
    sceneName?: string | null;
    missing_subtitles?: RawMissing[];
};

/**
 * Bazarr reports the position as a single `"5x2"` string rather than separate
 * numbers, confirmed against a live Bazarr 1.6.0. Reading `season` and
 * `episode` — which is what this adapter did first — silently returned nothing
 * for every episode.
 */
function parseEpisodeNumber(value: string | undefined): { season?: number; episode?: number } {
    const match = /^(\d+)x(\d+)$/.exec(value ?? '');
    if (match === null) return {};
    return { season: Number(match[1]), episode: Number(match[2]) };
}
type RawProvider = { name?: string; status?: string; retry?: string };

export class BazarrAdapter implements ServiceAdapter, HealthCheckCapable, SubtitleCapable, SubtitleSearchCapable {
    readonly type: ServiceId = 'bazarr';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;

    constructor(config: Instanced<KeyedServiceConfig>, fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('bazarr', config.name);
        // Bazarr spells the header X-API-KEY, not X-Api-Key. Header names are
        // case-insensitive per RFC 9110, so this is cosmetic — but it matches
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
     * shared HealthCheck shape wants one — `warning` is the honest mapping.
     */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const body = await this.#http.get<Envelope<RawHealth[]>>('/api/system/health');
        return (body.data ?? []).map(row => ({
            service: this.id,
            source: row.object ?? 'bazarr',
            type: 'warning',
            message: row.issue ?? ''
        }));
    }

    /**
     * Two endpoints, one list. `sceneName` is a release name straight from an
     * indexer, so it is fenced here rather than anywhere downstream.
     *
     * A failure in either throws; the tool converts that into `degraded`,
     * which is where the design spec wants partial-result handling to live.
     */
    async getMissingSubtitles(): Promise<SubtitleGap[]> {
        const fence = (field: string, value: string) => fenceText(value, { service: this.id, field });

        const [movies, episodes] = await Promise.all([
            this.#http.get<Envelope<RawWantedMovie[]>>('/api/movies/wanted'),
            this.#http.get<Envelope<RawWantedEpisode[]>>('/api/episodes/wanted')
        ]);

        const language = (m: RawMissing): MissingLanguage => ({
            name: m.name ?? 'unknown',
            code2: m.code2 ?? '??',
            forced: m.forced ?? false,
            hearingImpaired: m.hi ?? false
        });

        const movieGaps: SubtitleGap[] = (movies.data ?? [])
            .filter((m): m is RawWantedMovie & { radarrId: number } => typeof m.radarrId === 'number')
            .map(m => ({
                service: this.id,
                kind: 'movie' as const,
                id: m.radarrId,
                title: fence('title', m.title ?? ''),
                ...(typeof m.sceneName === 'string' ? { releaseName: fence('sceneName', m.sceneName) } : {}),
                missing: (m.missing_subtitles ?? []).map(language)
            }));

        const episodeGaps: SubtitleGap[] = (episodes.data ?? [])
            .filter((e): e is RawWantedEpisode & { sonarrEpisodeId: number } => typeof e.sonarrEpisodeId === 'number')
            .map(e => {
                const { season, episode } = parseEpisodeNumber(e.episode_number);
                return {
                    service: this.id,
                    kind: 'episode' as const,
                    id: e.sonarrEpisodeId,
                    ...(typeof e.sonarrSeriesId === 'number' ? { seriesId: e.sonarrSeriesId } : {}),
                    title: fence('seriesTitle', e.seriesTitle ?? ''),
                    ...(e.episodeTitle === undefined ? {} : { episodeTitle: fence('episodeTitle', e.episodeTitle) }),
                    ...(season === undefined ? {} : { season }),
                    ...(episode === undefined ? {} : { episode }),
                    ...(typeof e.sceneName === 'string' ? { releaseName: fence('sceneName', e.sceneName) } : {}),
                    missing: (e.missing_subtitles ?? []).map(language)
                };
            });

        return [...movieGaps, ...episodeGaps];
    }

    /**
     * Bazarr reports a healthy provider as `status: "Good"` and an unhealthy
     * one with the provider's own error text, so
     * `healthy` is derived here rather than making every caller know that
     * string. The status text is provider-supplied and therefore fenced.
     *
     * **Compared case-insensitively.** A live Bazarr 1.6.0 returns `"Good"`
     * with a capital G; an exact lowercase match — which is what this did
     * first — reported every healthy provider as broken.
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

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
