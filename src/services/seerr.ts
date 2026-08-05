import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiscoverCapable,
    type MediaRequest,
    type RequestStatus,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter,
    type ServiceUser,
    type UserDirectoryCapable
} from './types.ts';

type RawSearchResult = {
    id?: number;
    mediaType?: string;
    title?: string;
    name?: string;
    releaseDate?: string;
    firstAirDate?: string;
};

type RawStatus = { version?: string; commitTag?: string };
type RawRequest = {
    id?: number;
    status?: number;
    createdAt?: string;
    media?: { tmdbId?: number; tvdbId?: number | null; mediaType?: string; title?: string };
    requestedBy?: { id?: number; displayName?: string; username?: string; email?: string };
};
type RawRequestPage = { results?: RawRequest[] };

/** Seerr's numeric request statuses. */
const STATUS: Record<number, RequestStatus> = { 1: 'pending', 2: 'approved', 3: 'declined' };

/**
 * Design spec §21.4, settled 2026-08-06 against Seerr 3.4.1: passing
 * `requestedBy` does filter server-side. Verified against a live 2-user
 * stack where every recorded request happened to belong to one user, which
 * made a naive before/after count comparison uninformative (it would match
 * whether or not the server filtered). The decisive probe instead filtered
 * by the *other* user — one with zero requests — and got back zero rows
 * rather than the full unfiltered set, which only happens if the server
 * parsed and applied `requestedBy`.
 *
 * The in-memory filter still runs unconditionally — it costs nothing at
 * household volumes, and it means this constant can never silently widen
 * what one user sees of another's requests.
 */
const SEERR_FILTERS_SERVER_SIDE = true;

/** Narrowed through a typed helper: an inline ternary widens this to `string`. */
const mediaTypeOf = (value: string | undefined): MediaRequest['mediaType'] =>
    value === 'movie' || value === 'tv' ? value : 'unknown';
type RawUser = { id?: number; displayName?: string; username?: string; email?: string };
type RawUserPage = { results?: RawUser[] };

/**
 * Seerr users may have no display name. The email local part is the fallback
 * its own UI shows, so matching that avoids presenting a name the user has
 * never seen anywhere else.
 */
const nameOf = (u: RawUser): string | undefined => u.displayName ?? u.username ?? u.email?.split('@')[0];

export class SeerrAdapter implements ServiceAdapter, UserDirectoryCapable, SearchCapable, DiscoverCapable {
    readonly id: ServiceId = 'seerr';
    readonly #http: ServiceHttp;

    constructor(config: MultiUserServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('seerr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        }
        return status.version;
    }

    async listUsers(): Promise<ServiceUser[]> {
        const page = await this.#http.get<RawUserPage>('/api/v1/user');
        return (page.results ?? [])
            .map(u => ({ id: u.id, name: nameOf(u) }))
            .filter((u): u is { id: number; name: string } => u.id !== undefined && u.name !== undefined)
            .map(u => ({ id: String(u.id), name: u.name }));
    }

    async getRequests(opts: { user?: ServiceUser; status?: RequestStatus }): Promise<MediaRequest[]> {
        const params = new URLSearchParams({ take: '500' });
        if (SEERR_FILTERS_SERVER_SIDE && opts.user !== undefined) params.set('requestedBy', opts.user.id);

        const page = await this.#http.get<RawRequestPage>(`/api/v1/request?${params.toString()}`);

        return (page.results ?? [])
            .filter((r): r is RawRequest & { id: number } => typeof r.id === 'number')
            .map(r => ({
                service: this.id,
                id: r.id,
                status: STATUS[r.status ?? -1] ?? ('unknown' as const),
                mediaType: mediaTypeOf(r.media?.mediaType),
                ...(r.media?.tmdbId === undefined ? {} : { tmdbId: r.media.tmdbId }),
                // Seerr's MediaInfo carries tvdbId nullable (specs/seerr.json):
                // populated for tv media, always null for movies. Matching the
                // movie fixture, which carries the key present but null.
                ...(r.media?.tvdbId === undefined || r.media?.tvdbId === null ? {} : { tvdbId: r.media.tvdbId }),
                ...(r.media?.title === undefined
                    ? {}
                    : { title: fenceText(r.media.title, { service: this.id, field: 'title' }) }),
                requestedBy: nameOf(r.requestedBy ?? {}) ?? 'unknown',
                ...(r.createdAt === undefined ? {} : { requestedAt: r.createdAt })
            }))
            // The in-memory user filter runs unconditionally, even when the
            // server filtered too. It costs nothing, and it means flipping
            // SEERR_FILTERS_SERVER_SIDE can never silently widen what a user sees.
            .filter(r => opts.user === undefined || r.requestedBy.toLowerCase() === opts.user.name.toLowerCase())
            .filter(r => opts.status === undefined || r.status === opts.status);
    }

    #toHit(r: RawSearchResult & { id: number }, kind: 'movie' | 'series'): SearchHit {
        const date = r.releaseDate ?? r.firstAirDate;
        return {
            service: this.id,
            source: 'discover',
            kind,
            id: String(r.id),
            title: fenceText(r.title ?? r.name ?? '', { service: this.id, field: 'title' }),
            ...(date === undefined ? {} : { year: Number(date.slice(0, 4)) }),
            ids: { tmdb: r.id }
        };
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'discover') return [];

        const page = await this.#http.get<{ results?: RawSearchResult[] }>(
            `/api/v1/search?query=${encodeURIComponent(query)}`
        );

        return (page.results ?? [])
            .filter((r): r is RawSearchResult & { id: number } => typeof r.id === 'number')
            .map(r => this.#toHit(r, r.mediaType === 'tv' ? 'series' : 'movie'));
    }

    /**
     * Seerr's discover is TMDB-backed, so the rating floor is applied by TMDB
     * rather than by us. Design spec §7 defers rating filters over your *own*
     * library to the IMDb dataset — that is get_library in Phase 3, not this.
     */
    async discover(opts: {
        mediaType: 'movie' | 'tv';
        genre?: string;
        year?: number;
        minRating?: number;
    }): Promise<SearchHit[]> {
        const params = new URLSearchParams();
        if (opts.genre !== undefined) params.set('genre', opts.genre);
        if (opts.minRating !== undefined) params.set('voteAverageGte', String(opts.minRating));
        if (opts.year !== undefined) {
            const [gte, lte] =
                opts.mediaType === 'movie'
                    ? ['primaryReleaseDateGte', 'primaryReleaseDateLte']
                    : ['firstAirDateGte', 'firstAirDateLte'];
            params.set(gte, `${opts.year}-01-01`);
            params.set(lte, `${opts.year}-12-31`);
        }

        const endpoint = opts.mediaType === 'movie' ? 'movies' : 'tv';
        const page = await this.#http.get<{ results?: RawSearchResult[] }>(
            `/api/v1/discover/${endpoint}?${params.toString()}`
        );

        return (page.results ?? [])
            .filter((r): r is RawSearchResult & { id: number } => typeof r.id === 'number')
            .map(r => this.#toHit(r, opts.mediaType === 'tv' ? 'series' : 'movie'));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
