import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiscoverCapable,
    type MediaRequest,
    type RequestManageCapable,
    type RequestStatus,
    type RequestVerdict,
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
    /** TMDB's own score, 0–10. Seerr passes it straight through on both search
     *  and discover, confirmed against the recorded fixtures. */
    voteAverage?: number;
    voteCount?: number;
};

type RawStatus = { version?: string; commitTag?: string };

/** `/movie/{id}/ratingscombined` — Rotten Tomatoes *and* IMDb. `/tv/{id}/ratings`
 *  is the RT half alone; there is no combined endpoint for series. */
type RawCombinedRatings = {
    rt?: { criticsScore?: number; audienceScore?: number };
    imdb?: { criticsScore?: number };
    criticsScore?: number;
};

/**
 * `/movie/{tmdbId}` and `/tv/{tmdbId}` in one shape. Upstream names the title
 * differently per media type — `title`/`releaseDate` for films, `name`/
 * `firstAirDate` for series — so both spellings are read.
 */
type RawMediaDetails = { title?: string; name?: string; releaseDate?: string; firstAirDate?: string };
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
 * `requestedBy` does filter server-side, settled against a live Seerr 3.4.1.
 * The decisive probe filtered by a user with *zero* requests and got zero rows
 * back rather than the full set — a before/after count would have matched
 * either way on the stack it was tested against.
 *
 * The in-memory filter still runs unconditionally: it costs nothing at
 * household volumes, and it means this constant can never silently widen what
 * one user sees of another's requests.
 */
const SEERR_FILTERS_SERVER_SIDE = true;

/**
 * A release year, or nothing.
 *
 * `Number(''.slice(0, 4))` is **0**, not NaN, so a `Number.isFinite` guard lets
 * it through — which is how a live preview read "The Origin of Hide and Seek
 * (0)". Seerr returns an empty `releaseDate` whenever TMDB has no date, which is
 * common. Four leading digits and a plausible value keep absent absent.
 */
const yearOf = (date: string | undefined): number | undefined => {
    if (date === undefined || !/^\d{4}/.test(date)) return undefined;
    const year = Number(date.slice(0, 4));
    // 1878 is the first motion picture; anything below is a data error, not a film.
    return year >= 1878 ? year : undefined;
};

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

export class SeerrAdapter
    implements ServiceAdapter, UserDirectoryCapable, SearchCapable, DiscoverCapable, RequestManageCapable
{
    readonly type: ServiceId = 'seerr';
    readonly id: string = 'seerr';
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
            .map(r => this.#toRequest(r))
            // The in-memory user filter runs unconditionally, even when the
            // server filtered too. It costs nothing, and it means flipping
            // SEERR_FILTERS_SERVER_SIDE can never silently widen what a user sees.
            .filter(r => opts.user === undefined || r.requestedBy.toLowerCase() === opts.user.name.toLowerCase())
            .filter(r => opts.status === undefined || r.status === opts.status);
    }

    /**
     * Shared by the read above and the write below, so a request reported by
     * `get_requests` and the same request reported back by `respond_to_request`
     * cannot disagree about their own shape.
     */
    #toRequest(r: RawRequest & { id: number }): MediaRequest {
        return {
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
        };
    }

    /**
     * Approving is what actually sets a download in motion: Seerr hands the
     * request to Radarr or Sonarr, which searches and grabs. It is still the
     * `safe` tier because the state is reversible from Seerr's own UI and by
     * this same call — but `respond_to_request`'s preview says what it will
     * cost, because "approve" reads much cheaper than it is.
     */
    async respondToRequest(id: string, verdict: RequestVerdict): Promise<MediaRequest> {
        const requestId = Number(id);
        if (!Number.isInteger(requestId)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Seerr request id`, {
                remedy: 'Seerr request ids are integers. Take one from get_requests.'
            });
        }

        // Seerr wants a POST with no meaningful body; it rejects one with no
        // content-type at all, so an empty object is sent rather than nothing.
        const updated = await this.#http.post<RawRequest>(`/api/v1/request/${requestId}/${verdict}`, {});

        // The response is the updated request. If it comes back without an id
        // we cannot honestly report what it became, and saying "approved"
        // anyway would be a claim we did not verify.
        if (typeof updated.id !== 'number') {
            throw new ServiceError('UpstreamError', this.id, `${verdict} returned no request in its response`, {
                remedy: 'The change may still have been applied — call get_requests to check before retrying.'
            });
        }
        return this.#toRequest(updated as RawRequest & { id: number });
    }

    /**
     * One extra call, made only by the write previews and deliberately **not**
     * by `getRequests`: a 500-row request list would mean 500 lookups, while a
     * preview concerns exactly one request and is the place a real title is
     * worth paying for.
     *
     * Movies and series answer on different paths with differently-named title
     * fields — `title`/`releaseDate` against `name`/`firstAirDate` — which is
     * why this cannot be one generic fetch.
     */
    async describeRequestMedia(request: MediaRequest): Promise<{ title: string; year?: number } | undefined> {
        if (request.tmdbId === undefined || request.mediaType === 'unknown') return undefined;

        const path = request.mediaType === 'movie' ? `/api/v1/movie/${request.tmdbId}` : `/api/v1/tv/${request.tmdbId}`;

        try {
            const raw = await this.#http.get<RawMediaDetails>(path);
            const title = raw.title ?? raw.name;
            if (title === undefined || title === '') return undefined;

            const year = yearOf(raw.releaseDate ?? raw.firstAirDate);

            return {
                title: fenceText(title, { service: this.id, field: 'title' }),
                ...(year === undefined ? {} : { year })
            };
        } catch (err) {
            // Degrades rather than propagating: a lookup failure must not stop
            // someone deleting a request. The preview says the title is
            // unavailable instead of inventing one.
            logger.warn({ service: this.id, err, request: request.id }, 'could not resolve a title for a request');
            return undefined;
        }
    }

    async deleteRequest(id: string): Promise<void> {
        const requestId = Number(id);
        if (!Number.isInteger(requestId)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Seerr request id`, {
                remedy: 'Seerr request ids are integers. Take one from get_requests.'
            });
        }
        await this.#http.delete(`/api/v1/request/${requestId}`);
    }

    #toHit(r: RawSearchResult & { id: number }, kind: 'movie' | 'series'): SearchHit {
        // Same `yearOf` as the request lookup, and for the same reason: this
        // path had the identical bug, so an undated title in search_media or
        // discover_media has been reporting `year: 0` since 0.3.
        const year = yearOf(r.releaseDate ?? r.firstAirDate);
        return {
            service: this.id,
            source: 'discover',
            kind,
            id: String(r.id),
            title: fenceText(r.title ?? r.name ?? '', { service: this.id, field: 'title' }),
            ...(year === undefined ? {} : { year }),
            ids: { tmdb: r.id },
            // Seerr is TMDB-backed and hands this over for free on every hit.
            // Worth reading: without it, nothing rates something you do not
            // own, and the alternative was a gigabyte of IMDb dump. A zero is
            // TMDB's "nobody has voted", not a score of zero, so it is dropped
            // rather than reported as the worst film ever made.
            ...(typeof r.voteAverage === 'number' && r.voteAverage > 0
                ? { ratings: { tmdb: r.voteAverage } }
                : {})
        };
    }

    /**
     * Rotten Tomatoes, and for a film IMDb too — the one thing Seerr knows that
     * nothing else here does for a title you do not own.
     *
     * **One HTTP call per title**, which is why it is only ever used for a
     * single item. Calling it across a `lookup_media` page would be fifty
     * requests for one tool call; those hits carry TMDB's `voteAverage` from
     * the search payload instead, which is free.
     *
     * Series get Rotten Tomatoes only. `/tv/{id}/ratings` has no `imdb` half,
     * and there is no `ratingscombined` for TV — so an IMDb rating for a series
     * still comes from the IMDb dataset or from nowhere.
     *
     * Degrades to nothing on failure. A ratings lookup that fails must not take
     * down the details call it was decorating.
     */
    async getRatings(tmdbId: number, kind: 'movie' | 'series'): Promise<Record<string, number>> {
        const path = kind === 'movie' ? `/api/v1/movie/${tmdbId}/ratingscombined` : `/api/v1/tv/${tmdbId}/ratings`;

        let raw: RawCombinedRatings;
        try {
            raw = await this.#http.get<RawCombinedRatings>(path);
        } catch (err) {
            logger.warn({ service: this.id, tmdbId, err }, 'seerr ratings lookup failed; continuing without them');
            return {};
        }

        // `/tv` returns the RT shape unwrapped; `/movie` nests it under `rt`.
        const rt = raw.rt?.criticsScore ?? raw.criticsScore;
        const imdb = raw.imdb?.criticsScore;

        return {
            // A zero is "not scored", the same convention TMDB uses, so it is
            // dropped rather than reported as the worst film ever made.
            ...(typeof rt === 'number' && rt > 0 ? { rottenTomatoes: rt } : {}),
            ...(typeof imdb === 'number' && imdb > 0 ? { imdb } : {})
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
     * rather than by us. Design spec defers rating filters over your *own*
     * library to the IMDb dataset — that is get_library earlier, not this.
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
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
