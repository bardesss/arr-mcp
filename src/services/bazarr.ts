import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
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
    type SubtitleProvider
} from './types.ts';

/**
 * Hand-written: Bazarr publishes no OpenAPI document (design spec §21.1), so
 * these shapes come from recorded fixtures and the contract test checks them
 * against those fixtures rather than against a spec.
 *
 * Confirmed against a live Bazarr 1.6.0: every payload is wrapped in
 * `{ data: … }`, and the version field is `bazarr_version`.
 */
type Envelope<T> = { data?: T };
type RawStatus = { bazarr_version?: string };
type RawHealth = { object?: string; issue?: string };
type RawMissing = { name?: string; code2?: string; forced?: boolean; hi?: boolean };
type RawWantedMovie = { radarrId?: number; title?: string; sceneName?: string; missing_subtitles?: RawMissing[] };
type RawWantedEpisode = {
    sonarrEpisodeId?: number;
    seriesTitle?: string;
    episodeTitle?: string;
    season?: number;
    episode?: number;
    sceneName?: string;
    missing_subtitles?: RawMissing[];
};
type RawProvider = { name?: string; status?: string; retry?: string };

export class BazarrAdapter implements ServiceAdapter, HealthCheckCapable, SubtitleCapable {
    readonly id: ServiceId = 'bazarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        // Bazarr spells the header X-API-KEY, not X-Api-Key. Header names are
        // case-insensitive per RFC 9110, so this is cosmetic — but it matches
        // Bazarr's own documentation, which is what a reader will compare to.
        this.#http = new ServiceHttp('bazarr', config, apiKeyHeader('X-API-KEY', config.api_key), fetchImpl);
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
                ...(m.sceneName === undefined ? {} : { releaseName: fence('sceneName', m.sceneName) }),
                missing: (m.missing_subtitles ?? []).map(language)
            }));

        const episodeGaps: SubtitleGap[] = (episodes.data ?? [])
            .filter((e): e is RawWantedEpisode & { sonarrEpisodeId: number } => typeof e.sonarrEpisodeId === 'number')
            .map(e => ({
                service: this.id,
                kind: 'episode' as const,
                id: e.sonarrEpisodeId,
                title: fence('seriesTitle', e.seriesTitle ?? ''),
                ...(e.episodeTitle === undefined ? {} : { episodeTitle: fence('episodeTitle', e.episodeTitle) }),
                ...(e.season === undefined ? {} : { season: e.season }),
                ...(e.episode === undefined ? {} : { episode: e.episode }),
                ...(e.sceneName === undefined ? {} : { releaseName: fence('sceneName', e.sceneName) }),
                missing: (e.missing_subtitles ?? []).map(language)
            }));

        return [...movieGaps, ...episodeGaps];
    }

    /**
     * §12's "provider state". Bazarr reports a healthy provider as
     * `status: "good"` and an unhealthy one with the provider's own error text,
     * so `healthy` is derived here rather than making every caller know that
     * string. The status text is provider-supplied and therefore fenced.
     *
     * `retry` is the literal "End of information" when nothing is scheduled —
     * treating that as a timestamp would put a sentence into a date field and
     * a model would read it as a time.
     */
    async getProviders(): Promise<SubtitleProvider[]> {
        const body = await this.#http.get<Envelope<RawProvider[]>>('/api/providers');

        return (body.data ?? [])
            .filter((p): p is RawProvider & { name: string } => typeof p.name === 'string')
            .map(p => {
                const healthy = p.status === 'good';
                const retry = p.retry !== undefined && p.retry !== 'End of information' ? p.retry : undefined;
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

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
