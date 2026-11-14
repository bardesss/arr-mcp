import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { mapLimit } from '../core/gather.ts';
import { BACKDROP_SIZE, POSTER_SIZE, compactDisplay, tmdbImageUrl, type Display } from '../core/display.ts';
import { logger } from '../core/logger.ts';
import { LOG_LINES, foldLogLines } from './logLines.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type CreateRequestOptions,
    type DiscoverCapable,
    type DiscoverPage,
    type DiscoverWindow,
    type IssueCapable,
    type LogCapable,
    type MediaIssue,
    type MediaRequest,
    type RecentLogs,
    type RequestLookupCapable,
    type RequestManageCapable,
    type TitleRequests,
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
    /** TMDB's own score, 0 to 10. Seerr passes it straight through on both search
     *  and discover, confirmed against the recorded fixtures. */
    voteAverage?: number;
    voteCount?: number;
    overview?: string;
    /** TMDB image paths, `/abc.jpg`. */
    posterPath?: string | null;
    backdropPath?: string | null;
};

type RawStatus = { version?: string; commitTag?: string };

/** `/movie/{id}/ratingscombined`: Rotten Tomatoes *and* IMDb. `/tv/{id}/ratings`
 *  is the RT half alone; there is no combined endpoint for series. */
type RawCombinedRatings = {
    rt?: { criticsScore?: number; audienceScore?: number };
    imdb?: { criticsScore?: number };
    criticsScore?: number;
};

/**
 * `/movie/{tmdbId}` and `/tv/{tmdbId}` in one shape. Upstream names the title
 * differently per media type: `title`/`releaseDate` for films, `name`/
 * `firstAirDate` for series, so both spellings are read.
 */
type RawMediaDetails = {
    title?: string;
    name?: string;
    releaseDate?: string;
    firstAirDate?: string;
    seasons?: { seasonNumber?: number }[];
};
type RawRequest = {
    id?: number;
    status?: number;
    createdAt?: string;
    media?: { tmdbId?: number; tvdbId?: number | null; mediaType?: string; title?: string };
    requestedBy?: { id?: number; displayName?: string; username?: string; email?: string };
    seasons?: { seasonNumber?: number }[];
};

/** Seerr's numeric request statuses. The spec's prose names only the first three; its `filter` enum and live rows have all five. */
const STATUS: Record<number, RequestStatus> = { 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed' };

/**
 * Seerr validates query strings against its OpenAPI document and answers 400
 * "must be url encoded" for a raw `! ' ( ) *`, which `encodeURIComponent`
 * leaves alone. "Dune (2021)" is an ordinary thing to search for.
 */
const strictEncode = (value: string): string =>
    encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const seasonNumbers = (seasons: { seasonNumber?: number }[] | undefined): number[] =>
    (seasons ?? []).map(s => s.seasonNumber).filter((n): n is number => typeof n === 'number');

type RawIssue = {
    id?: number;
    issueType?: number;
    status?: number;
    createdAt?: string;
    /**
     * A MediaInfo, not a titled row: the recorded fixture carries `id`,
     * `mediaType`, `tmdbId` and `tvdbId` (null for movies) and no title at
     * all (specs/seerr.json: `Issue.media` is a `MediaInfo`). `title` stays
     * read for tolerance: older payloads and hand-written shapes may carry
     * one, but the title a caller sees comes from the media detail endpoint
     * in `getIssues`, not from here.
     */
    media?: { id?: number; mediaType?: string; tmdbId?: number; tvdbId?: number | null; title?: string };
    createdBy?: { displayName?: string; username?: string; email?: string };
    comments?: { message?: string }[];
};

/** Seerr numbers both of these, and a model handed `issueType: 2` cannot say
 *  what is wrong with the film. */
const ISSUE_TYPE: Record<number, string> = { 1: 'video', 2: 'audio', 3: 'subtitle', 4: 'other' };
const ISSUE_STATUS: Record<number, string> = { 1: 'open', 2: 'resolved' };

/** Detail reads in flight while resolving issue titles: the same cap as the metadata sweep's SERIES_CONCURRENCY. */
const ISSUE_TITLE_CONCURRENCY = 4;

/** An argument twenty comments long is not what the caller asked for. */
const ISSUE_COMMENT_CAP = 3;

/**
 * `requestedBy` does filter server-side, settled against a live Seerr 3.4.1.
 * The decisive probe filtered by a user with *zero* requests and got zero rows
 * back rather than the full set: a before/after count would have matched
 * either way on the stack it was tested against.
 *
 * The in-memory filter still runs unconditionally: it costs nothing at
 * household volumes, and it means this constant can never silently widen what
 * one user sees of another's requests.
 */
const SEERR_FILTERS_SERVER_SIDE = true;

/** Rows per request while paging. Large enough that a household is one call,
 *  small enough that a page is not a large response to hold. */
const PAGE_SIZE = 100;

/** TMDB's genre list changes on the order of years, not requests. */
const GENRE_TTL_MS = 24 * 60 * 60 * 1000;
/** TMDB's fixed page length, and the last page it will serve. */
const TMDB_PAGE_SIZE = 20;
const TMDB_MAX_PAGES = 500;
/** Pages read at once when a window spans several; Seerr asks TMDB for each. */
const TMDB_PAGE_READS = 4;
/** Pages one call reads at most, so a big `limit` is not dozens of TMDB round trips; the rest is one `offset` away. */
export const TMDB_PAGES_PER_CALL = 5;

type RawResultsPage = { results?: RawSearchResult[]; totalPages?: number; totalResults?: number };
const FIRST_PAGE: DiscoverWindow = { offset: 0, limit: TMDB_PAGE_SIZE };

type RawGenre = { id?: number; name?: string };
type GenreTable = { byLowerName: Map<string, number>; names: string[] };

/**
 * A release year, or nothing.
 *
 * `Number(''.slice(0, 4))` is **0**, not NaN, so a `Number.isFinite` guard lets
 * it through, which is how a live preview read "The Origin of Hide and Seek
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

/** Every paginated Seerr list answers with this envelope. */
type PageInfo = { results?: number };
type RawLogRow = { timestamp?: string; level?: string; label?: string; message?: string; errorMessage?: unknown };

/**
 * Seerr users may have no display name. The email local part is the fallback
 * its own UI shows, so matching that avoids presenting a name the user has
 * never seen anywhere else.
 */
const nameOf = (u: RawUser): string | undefined => u.displayName ?? u.username ?? u.email?.split('@')[0];

export class SeerrAdapter
    implements ServiceAdapter, LogCapable, UserDirectoryCapable, SearchCapable, DiscoverCapable, RequestManageCapable, RequestLookupCapable, IssueCapable
{
    readonly type: ServiceId = 'seerr';
    readonly id: string = 'seerr';
    readonly #http: ServiceHttp;
    readonly #genreCache = new TtlCache();

    constructor(config: ConfigByService['seerr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('seerr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        }
        return status.version;
    }

    /**
     * `filter=warn` means warnings and worse. The answer is `pageInfo` and
     * `results`, not the bare array `specs/seerr.json` documents. A row also
     * carries whatever the line was logged with, whole library items included, so
     * only these fields are read. `errorMessage` is the reason, and `message`
     * often only says which job failed, so it is kept the way the *arrs keep
     * theirs: appended to the message.
     */
    async getRecentLogs(): Promise<RecentLogs> {
        const page = await this.#http.get<{ pageInfo?: PageInfo; results?: RawLogRow[] }>(
            `/api/v1/settings/logs?take=${LOG_LINES}&skip=0&filter=warn`
        );
        const rows = page.results ?? [];
        const lines = rows.flatMap(r => {
            if (typeof r.timestamp !== 'string') return [];
            const message = r.message ?? '';
            return [
                {
                    time: r.timestamp,
                    level: r.level ?? 'warn',
                    logger: r.label ?? 'unknown',
                    message: typeof r.errorMessage === 'string' ? `${message}: ${r.errorMessage}` : message
                }
            ];
        });
        return { entries: foldLogLines(lines, this.id), read: rows.length, total: page.pageInfo?.results ?? rows.length };
    }

    /**
     * Every row, not the first page.
     *
     * Seerr paginates (/user defaults to 10) and a first-page-only read is a
     * truncation that reads as absence. Same shape as the *arr queue reader in
     * arrQueue.ts: an empty page ends it whatever the count says, so a service
     * that disagrees with its own total cannot spin here.
     */
    async #allPages<T>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<T[]> {
        const out: T[] = [];
        for (let skip = 0; ; skip += PAGE_SIZE) {
            const query = new URLSearchParams(params);
            query.set('take', String(PAGE_SIZE));
            query.set('skip', String(skip));

            const page = await this.#http.get<{ pageInfo?: PageInfo; results?: T[] }>(
                `${path}?${query.toString()}`
            );
            const got = page.results ?? [];
            out.push(...got);

            const total = page.pageInfo?.results;
            if (got.length === 0 || total === undefined || out.length >= total) break;
        }
        return out;
    }

    async listUsers(): Promise<ServiceUser[]> {
        const rows = await this.#allPages<RawUser>('/api/v1/user');
        return rows
            .map(u => ({ id: u.id, name: nameOf(u) }))
            .filter((u): u is { id: number; name: string } => u.id !== undefined && u.name !== undefined)
            .map(u => ({ id: String(u.id), name: u.name }));
    }

    async getRequests(opts: { user?: ServiceUser; status?: RequestStatus }): Promise<MediaRequest[]> {
        const params = new URLSearchParams();
        if (SEERR_FILTERS_SERVER_SIDE && opts.user !== undefined) params.set('requestedBy', opts.user.id);

        // `filter` pushed down where Seerr has a matching value.
        //
        // This used to be the difference between an answer and an empty list:
        // the read was one page of the newest 500, so a household with more
        // lifetime requests than that got nothing for `status: pending` once
        // its pending ones fell outside the window. Now that the read pages to
        // completion, pushing down is an efficiency rather than a correctness
        // fix: it still fetches fewer rows.
        //
        // `declined` is deliberately absent: Seerr's filter vocabulary has no
        // value for it, and mapping it onto a near-miss like `deleted` would
        // answer a different question. It stays an in-memory filter, and now
        // one that sees every row rather than the newest page.
        //
        // Seerr's `approved` filter leaves out completed requests, and this
        // module's `approved` means the same: a request handed on and not
        // yet fulfilled.
        const SERVER_SIDE_STATUS: Partial<Record<RequestStatus, string>> = {
            pending: 'pending',
            approved: 'approved',
            failed: 'failed',
            completed: 'completed'
        };
        const pushedDown = opts.status === undefined ? undefined : SERVER_SIDE_STATUS[opts.status];
        if (SEERR_FILTERS_SERVER_SIDE && pushedDown !== undefined) params.set('filter', pushedDown);

        const rows = await this.#allPages<RawRequest>('/api/v1/request', params);

        return rows
            .filter((r): r is RawRequest & { id: number } => typeof r.id === 'number')
            .map(r => this.#toRequest(r))
            // The in-memory user filter runs unconditionally, even when the
            // server filtered too. It costs nothing, and it means flipping
            // SEERR_FILTERS_SERVER_SIDE can never silently widen what a user sees.
            .filter(r => opts.user === undefined || r.requestedById === opts.user.id)
            .filter(r => opts.status === undefined || r.status === opts.status);
    }

    /**
     * One request by id. A guess at an id is cheap to get wrong, so a missing
     * request is `undefined` rather than an error, and an id that cannot be a
     * Seerr id never costs a call.
     */
    async getRequest(id: string): Promise<MediaRequest | undefined> {
        if (!/^[0-9]+$/.test(id) || !Number.isSafeInteger(Number(id))) return undefined;
        try {
            // The canonical number, so "031" reads request 31.
            const body = await this.#http.get<RawRequest>(`/api/v1/request/${Number(id)}`);
            return typeof body.id === 'number' ? this.#toRequest(body as RawRequest & { id: number }) : undefined;
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'NotFound') return undefined;
            throw err;
        }
    }

    /**
     * A title's own requests, read from its detail: `mediaInfo.requests` lists
     * every request for that title, so the duplicate check costs one call
     * however long the request history is. Errors propagate; the caller decides
     * what a failed lookup means.
     *
     * The nested rows carry no tmdbId or mediaType of their own that can be
     * trusted, so the arguments decide both.
     */
    async getMediaRequests(mediaType: 'movie' | 'tv', tmdbId: number): Promise<TitleRequests> {
        const path = mediaType === 'movie' ? `/api/v1/movie/${tmdbId}` : `/api/v1/tv/${tmdbId}`;
        const raw = await this.#http.get<
            RawMediaDetails & { mediaInfo?: { tvdbId?: number | null; requests?: RawRequest[] } }
        >(path);

        const title = raw.title ?? raw.name;
        const year = yearOf(raw.releaseDate ?? raw.firstAirDate);
        const requests = (raw.mediaInfo?.requests ?? [])
            .filter((r): r is RawRequest & { id: number } => typeof r.id === 'number')
            .map(r => {
                const request = this.#toRequest({
                    ...r,
                    media: { ...(r.media ?? {}), tvdbId: raw.mediaInfo?.tvdbId ?? null, tmdbId, mediaType }
                });
                const seasons = seasonNumbers(r.seasons);
                return mediaType === 'tv' && seasons.length > 0 ? { ...request, seasons } : request;
            });
        const seasons = seasonNumbers(raw.seasons);

        return {
            ...(title === undefined || title === ''
                ? {}
                : {
                      media: {
                          title: fenceText(title, { service: this.id, field: 'title' }),
                          ...(year === undefined ? {} : { year }),
                          ...(mediaType === 'tv' && seasons.length > 0 ? { seasons } : {})
                      }
                  }),
            requests
        };
    }

    /**
     * The issues a household has raised: "the audio is out of sync", "there
     * are no subtitles", which nothing in this stack could report.
     *
     * Both vocabularies arrive as integers and are mapped to words: a model
     * handed `issueType: 2` cannot say what is wrong with the film. Comments
     * are the user's own text and are fenced, and capped at the newest few:
     * an argument twenty comments long is not what the caller asked for.
     *
     * One page of `limit` rows, not the whole list: a caller asking for a few
     * issues should not cost a request per hundred issues ever raised. The
     * request `sort=added` is sent, and on the request list that returns newest
     * first. The issue order itself was not observed: the live store held a
     * single issue.
     *
     * Each issue also names the media it is about. The issue payload itself
     * carries the ids (MediaInfo: `id`, `mediaType`, `tmdbId`, `tvdbId`) but
     * no title, so the title is resolved from the media detail endpoint:
     * the same read `getMediaRequests` already makes, once per distinct
     * title, not once per issue, and at most four detail reads in flight.
     * A title that cannot be read leaves the ids in place rather than
     * failing the whole list: issues are never a reason for `get_requests`
     * to fail.
     */
    async getIssues(opts: { limit: number }): Promise<MediaIssue[]> {
        const params = new URLSearchParams({
            take: String(Math.max(1, opts.limit)),
            skip: '0',
            sort: 'added',
            filter: 'all'
        });
        const page = await this.#http.get<{ pageInfo?: PageInfo; results?: RawIssue[] }>(
            `/api/v1/issue?${params.toString()}`
        );
        const rows = (page.results ?? [])
            .filter((i): i is RawIssue & { id: number } => typeof i.id === 'number')
            .slice(0, opts.limit);

        // One entry per distinct title, resolved through mapLimit: without
        // the cap, `limit: 500` with 500 different titles fires 500 detail
        // reads at Seerr at once. The dedupe and the per-title catch stay
        // as they are: a title that cannot be read resolves undefined.
        const distinct: { mediaType: 'movie' | 'tv'; tmdbId: number }[] = [];
        const seenKeys = new Set<string>();
        for (const i of rows) {
            const mediaType = mediaTypeOf(i.media?.mediaType);
            // An empty payload title is no title at all (getMediaRequests
            // treats '' the same way), and a non-number id can never name a
            // title: a null tmdbId must not cost a call to /movie/null.
            if (
                (i.media?.title !== undefined && i.media?.title !== '') ||
                typeof i.media?.tmdbId !== 'number' ||
                mediaType === 'unknown'
            )
                continue;
            const key = `${mediaType}:${i.media.tmdbId}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            distinct.push({ mediaType, tmdbId: i.media.tmdbId });
        }
        const titles = new Map(
            await mapLimit(distinct, ISSUE_TITLE_CONCURRENCY, async d => {
                const title = await this.getMediaRequests(d.mediaType, d.tmdbId)
                    .then(r => r.media?.title)
                    .catch(() => undefined);
                return [`${d.mediaType}:${d.tmdbId}`, title] as const;
            })
        );

        return rows.map(i => {
            const mediaType = mediaTypeOf(i.media?.mediaType);
            const title =
                i.media?.title === undefined || i.media?.title === ''
                    ? mediaType === 'unknown' || typeof i.media?.tmdbId !== 'number'
                        ? undefined
                        : titles.get(`${mediaType}:${i.media.tmdbId}`)
                    : fenceText(i.media.title, { service: this.id, field: 'title' });
            return {
                service: this.id,
                id: String(i.id),
                kind: ISSUE_TYPE[i.issueType ?? -1] ?? 'other',
                status: ISSUE_STATUS[i.status ?? -1] ?? 'unknown',
                ...(i.createdAt === undefined ? {} : { createdAt: i.createdAt }),
                // A mediaType with no id to look it up by names nothing
                // the caller can resolve, so it is dropped rather than
                // emitted on its own (follow-up to #578).
                ...(mediaType === 'unknown' ||
                (typeof i.media?.tmdbId !== 'number' && typeof i.media?.tvdbId !== 'number')
                    ? {}
                    : { mediaType }),
                // Non-number ids are dropped, not emitted: the spec types
                // them as numbers, but a payload that disagrees must not
                // put `tmdbId: null` into a `tmdbId?: number` field.
                ...(typeof i.media?.tmdbId !== 'number' ? {} : { tmdbId: i.media.tmdbId }),
                // Seerr's MediaInfo carries tvdbId nullable (specs/seerr.json):
                // populated for tv media, always null for movies. Matching
                // #toRequest, which omits it in both cases.
                ...(typeof i.media?.tvdbId !== 'number' ? {} : { tvdbId: i.media.tvdbId }),
                ...(title === undefined ? {} : { title }),
                ...((name => (name === undefined ? {} : { reportedBy: fenceText(name, { service: this.id, field: 'user' }) }))(
                    nameOf(i.createdBy ?? {})
                )),
                comments: (i.comments ?? [])
                    .slice(-ISSUE_COMMENT_CAP)
                    .map(c => c.message)
                    .filter((m): m is string => typeof m === 'string' && m !== '')
                    .map(m => fenceText(m, { service: this.id, field: 'comment' }))
            };
        });
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
            ...(r.requestedBy?.id === undefined ? {} : { requestedById: String(r.requestedBy.id) }),
            ...(r.createdAt === undefined ? {} : { requestedAt: r.createdAt })
        };
    }

    /**
     * Approving is what actually sets a download in motion: Seerr hands the
     * request to Radarr or Sonarr, which searches and grabs. It is still the
     * `safe` tier because the state is reversible from Seerr's own UI and by
     * this same call, but `respond_to_request`'s preview says what it will
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
        // `/approve`, `/decline` and `/retry` share this shape and each answer
        // with the updated request.
        const updated = await this.#http.post<RawRequest>(`/api/v1/request/${requestId}/${verdict}`, {});

        // The response is the updated request. If it comes back without an id
        // we cannot honestly report what it became, and saying "approved"
        // anyway would be a claim we did not verify.
        if (typeof updated.id !== 'number') {
            throw new ServiceError('UpstreamError', this.id, `${verdict} returned no request in its response`, {
                remedy: 'The change may still have been applied. Call get_requests to check before retrying.'
            });
        }
        return this.#toRequest(updated as RawRequest & { id: number });
    }

    /**
     * Creating a request, as opposed to ruling on one.
     *
     * Two things a live 3.4.1 settled that the spec does not. It resolves the
     * TVDB id itself from the TMDB `mediaId`, so nothing here has to supply
     * one. And it does **not** refuse a duplicate: a second request for the
     * same media creates a second row, which is why `request_media` checks
     * for an existing one itself rather than letting Seerr answer that.
     */
    async createRequest(opts: CreateRequestOptions): Promise<MediaRequest> {
        const created = await this.#http.post<RawRequest>('/api/v1/request', {
            mediaType: opts.mediaType,
            mediaId: opts.mediaId,
            ...(opts.seasons === undefined ? {} : { seasons: opts.seasons }),
            ...(opts.userId === undefined ? {} : { userId: opts.userId })
        });

        // Same rule as respondToRequest: if the response cannot say what was
        // created, we do not claim it worked.
        if (typeof created.id !== 'number') {
            throw new ServiceError('UpstreamError', this.id, 'the request was created with no id in the response', {
                remedy: 'It may still have been created. Call get_requests to check before retrying.'
            });
        }
        return this.#toRequest(created as RawRequest & { id: number });
    }

    /**
     * One extra call, made only by the write previews and deliberately **not**
     * by `getRequests`: a 500-row request list would mean 500 lookups, while a
     * preview concerns exactly one request and is the place a real title is
     * worth paying for.
     *
     * Movies and series answer on different paths with differently-named title
     * fields, `title`/`releaseDate` against `name`/`firstAirDate`, which is
     * why this cannot be one generic fetch.
     */
    async describeRequestMedia(
        request: MediaRequest,
        opts: { strict?: boolean } = {}
    ): Promise<{ title: string; year?: number } | undefined> {
        if (request.tmdbId === undefined || request.mediaType === 'unknown') return undefined;
        return this.describeTitle(request.mediaType, request.tmdbId, { ...opts, requestId: request.id });
    }

    /** The title and year Seerr has for a TMDB id: `describeRequestMedia` without a request. */
    async describeTitle(
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        opts: { strict?: boolean; requestId?: number } = {}
    ): Promise<{ title: string; year?: number } | undefined> {
        const path = mediaType === 'movie' ? `/api/v1/movie/${tmdbId}` : `/api/v1/tv/${tmdbId}`;

        try {
            const raw = await this.#http.get<RawMediaDetails>(path);
            const title = raw.title ?? raw.name;
            if (title === undefined || title === '') {
                if (opts.strict === true) throw new ServiceError('NotFound', this.id, `${path} has no title`);
                return undefined;
            }

            const year = yearOf(raw.releaseDate ?? raw.firstAirDate);

            return {
                title: fenceText(title, { service: this.id, field: 'title' }),
                ...(year === undefined ? {} : { year })
            };
        } catch (err) {
            if (opts.strict === true) throw err;
            // Degrades rather than propagating: a lookup failure must not stop
            // someone deleting a request. The preview says the title is
            // unavailable instead of inventing one.
            logger.warn({ service: this.id, err, request: opts.requestId, tmdbId }, 'could not resolve a title for a request');
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

    /**
     * Whether Seerr refuses requests for this title. `GET /blocklist/{tmdbId}`
     * answers the row or a 404, so a 404 is "not blocklisted", not a failure.
     *
     * `/blocklist` and not `/blacklist`: Seerr renamed it and keeps the old
     * path only as a deprecated alias (specs/seerr.json).
     */
    async isBlocklisted(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<boolean> {
        try {
            await this.#http.get<unknown>(`/api/v1/blocklist/${tmdbId}?mediaType=${mediaType}`);
            return true;
        } catch (err) {
            if (err instanceof ServiceError && err.status === 404) return false;
            throw err;
        }
    }

    /**
     * Adds a title to Seerr's blocklist: its media record turns `BLOCKLISTED`
     * and Seerr refuses every new request for it. Requests it already has are
     * left as they are.
     *
     * Two things the published spec leaves out and Seerr's route requires
     * (`server/routes/blocklist.ts`, `blocklistAdd`): `mediaType`, and `user`,
     * the id the row is credited to. That is the API key's own user, read from
     * `/auth/me`, as Seerr's UI credits the person who clicked.
     *
     * A duplicate is refused by a unique index, which Seerr answers 412 on
     * SQLite and 409 on Postgres. Either one is checked rather than trusted.
     */
    async addToBlocklist(opts: { tmdbId: number; mediaType: 'movie' | 'tv'; title?: string }): Promise<'added' | 'already'> {
        const me = await this.#http.get<{ id?: number }>('/api/v1/auth/me');
        if (typeof me.id !== 'number') {
            throw new ServiceError('UpstreamError', this.id, '/auth/me returned no user id', {
                remedy: 'Seerr credits a blocklist entry to a user. Check the API key belongs to a Seerr user, then try again.'
            });
        }
        try {
            await this.#http.post<unknown>(
                '/api/v1/blocklist',
                {
                    tmdbId: opts.tmdbId,
                    mediaType: opts.mediaType,
                    ...(opts.title === undefined ? {} : { title: opts.title }),
                    user: me.id
                },
                true
            );
            return 'added';
        } catch (err) {
            if (err instanceof ServiceError && (err.status === 409 || err.status === 412)) {
                if (await this.isBlocklisted(opts.tmdbId, opts.mediaType)) return 'already';
            }
            throw err;
        }
    }

    /**
     * Takes a title off the blocklist. Seerr does this by deleting the
     * blocklist row **and the title's media record**, and the media record
     * cascades to every request and issue for it. Destructive, whatever
     * "unblock" sounds like.
     */
    async removeFromBlocklist(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<void> {
        await this.#http.delete(`/api/v1/blocklist/${tmdbId}?mediaType=${mediaType}`);
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
                : {}),
            // TMDB-backed, so the artwork is a TMDB path rather than a URL.
            ...((display => (display === undefined ? {} : { display }))(
                compactDisplay({
                    poster: tmdbImageUrl(r.posterPath, POSTER_SIZE),
                    backdrop: tmdbImageUrl(r.backdropPath, BACKDROP_SIZE),
                    ...(typeof r.overview === 'string' && r.overview !== ''
                        ? { overview: fenceText(r.overview, { service: this.id, field: 'overview' }) }
                        : {})
                } as Display)
            ))
        };
    }

    /**
     * Rotten Tomatoes, and for a film IMDb too: the one thing Seerr knows that
     * nothing else here does for a title you do not own.
     *
     * **One HTTP call per title**, which is why it is only ever used for a
     * single item. Calling it across a `search_media` page would be fifty
     * requests for one tool call; those hits carry TMDB's `voteAverage` from
     * the search payload instead, which is free.
     *
     * Series get Rotten Tomatoes only. `/tv/{id}/ratings` has no `imdb` half,
     * and there is no `ratingscombined` for TV, so an IMDb rating for a series
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
            `/api/v1/search?query=${strictEncode(query)}`
        );

        // A TMDB multi-search, so `results` carries people as well as titles.
        // Anything not explicitly a movie or a series is dropped rather than
        // defaulted to `movie`: a person id shares no namespace with a movie
        // id, so it would resolve to an unrelated film on the way to add_media.
        return (page.results ?? [])
            .filter(
                (r): r is RawSearchResult & { id: number; mediaType: 'movie' | 'tv' } =>
                    typeof r.id === 'number' && (r.mediaType === 'movie' || r.mediaType === 'tv')
            )
            .map(r => this.#toHit(r, r.mediaType === 'tv' ? 'series' : 'movie'));
    }

    /**
     * `/genres/movie` and `/genres/tv` answer in the instance's own locale
     * (`80=Misdaad` on a Dutch stack) unless `?language=en` is passed, which
     * genuinely changes the response (confirmed live: two invented parameter
     * names both 400, so Seerr is not just ignoring it). A model overwhelmingly
     * says the English name, so both lists are fetched and merged by name; a
     * name present in either resolves.
     */
    async #genreTable(mediaType: 'movie' | 'tv'): Promise<GenreTable> {
        return this.#genreCache.get(`genres:${mediaType}`, GENRE_TTL_MS, async () => {
            const [english, localised] = await Promise.all([
                this.#http.get<RawGenre[]>(`/api/v1/genres/${mediaType}?language=en`),
                this.#http.get<RawGenre[]>(`/api/v1/genres/${mediaType}`)
            ]);

            const byLowerName = new Map<string, number>();
            const names = new Set<string>();
            // Last write wins if the same lowercased name ever appeared in
            // both lists pointing at different ids. Not seen on live TMDB
            // data (19/16 genres, no cross-language collisions) and TMDB's
            // taxonomy gives no reason to expect one, but nothing here
            // enforces that assumption.
            for (const g of [...english, ...localised]) {
                if (typeof g.id !== 'number' || typeof g.name !== 'string') continue;
                byLowerName.set(g.name.toLowerCase(), g.id);
                names.add(g.name);
            }
            return { byLowerName, names: [...names].sort() };
        });
    }

    /**
     * A numeric TMDB id passes straight through in `discover` without ever
     * reaching here: this is only for a name, which Seerr's own `genre` query
     * param does not understand and matches nothing against, silently.
     */
    async genreId(mediaType: 'movie' | 'tv', name: string): Promise<number> {
        const table = await this.#genreTable(mediaType);
        const id = table.byLowerName.get(name.toLowerCase());
        if (id === undefined) {
            throw new ServiceError('NotFound', this.id, `"${name}" is not a ${mediaType} genre Seerr knows`, {
                remedy: `Valid genres: ${table.names.join(', ')}`
            });
        }
        return id;
    }

    /**
     * Seerr's discover is TMDB-backed, so the rating floor is applied by TMDB
     * rather than by us. Design spec defers rating filters over your *own*
     * library to the IMDb dataset: that is get_library earlier, not this.
     */
    async discover(
        opts: {
            mediaType: 'movie' | 'tv';
            genre?: string;
            year?: number;
            minRating?: number;
        },
        window: DiscoverWindow = FIRST_PAGE
    ): Promise<DiscoverPage> {
        const params = new URLSearchParams();
        if (opts.genre !== undefined) {
            const id = /^\d+$/.test(opts.genre) ? opts.genre : String(await this.genreId(opts.mediaType, opts.genre));
            params.set('genre', id);
        }
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
        return this.#tmdbWindow(`/api/v1/discover/${endpoint}`, params, opts.mediaType, window);
    }

    /**
     * "Similar" is not implemented: live capture against Dune Part Two
     * (693134) had `/similar` answer with The Count of Monte Cristo, The
     * Musketeer, National Lampoon's European Vacation: genre-bucket
     * matching, not similarity. `/tv/{id}/similar` returned zero results
     * outright for a series that `/recommendations` answered for with over a
     * thousand. `recommendations` is the only one worth exposing.
     */
    async recommendations(opts: { mediaType: 'movie' | 'tv'; id: string }, window: DiscoverWindow = FIRST_PAGE): Promise<DiscoverPage> {
        const path = opts.mediaType === 'movie' ? `/api/v1/movie/${opts.id}/recommendations` : `/api/v1/tv/${opts.id}/recommendations`;
        return this.#tmdbWindow(path, new URLSearchParams(), opts.mediaType, window);
    }

    /**
     * The rows `window` asks for out of a TMDB list Seerr serves 20 to a page,
     * and how many rows the list has. One page was all this read before, so a
     * genre with thousands of films came back as "20 of 20" and `offset: 20`
     * found nothing. TMDB answers no page past 500 (a live Seerr turned page
     * 600 into an HTTP 500), so `total` stops at what can be paged to.
     */
    async #tmdbWindow(path: string, params: URLSearchParams, mediaType: 'movie' | 'tv', window: DiscoverWindow): Promise<DiscoverPage> {
        const offset = Math.max(Math.trunc(window.offset), 0);
        const first = Math.floor(offset / TMDB_PAGE_SIZE) + 1;
        const read = (page: number) => {
            const query = new URLSearchParams(params);
            if (page > 1) query.set('page', String(page));
            const qs = query.toString();
            return this.#http.get<RawResultsPage>(qs === '' ? path : `${path}?${qs}`);
        };

        // Past the last page TMDB serves, page one still gives the total.
        const head = await read(first > TMDB_MAX_PAGES ? 1 : first);
        if (first > TMDB_MAX_PAGES) return { items: [], total: Math.min(head.totalResults ?? 0, TMDB_MAX_PAGES * TMDB_PAGE_SIZE) };
        const pages = Math.min(typeof head.totalPages === 'number' ? head.totalPages : first, TMDB_MAX_PAGES);
        const total = Math.min(
            typeof head.totalResults === 'number' ? head.totalResults : (first - 1) * TMDB_PAGE_SIZE + (head.results ?? []).length,
            pages * TMDB_PAGE_SIZE
        );
        const wanted = Math.min(Math.ceil((offset + Math.max(window.limit, 1)) / TMDB_PAGE_SIZE), pages);
        const last = Math.min(wanted, first + TMDB_PAGES_PER_CALL - 1);
        const rest = await mapLimit(
            Array.from({ length: Math.max(last - first, 0) }, (_, i) => first + 1 + i),
            TMDB_PAGE_READS,
            read
        );
        const rows = [head, ...rest].flatMap(p => p.results ?? []);
        const skip = offset - (first - 1) * TMDB_PAGE_SIZE;
        const kind = mediaType === 'tv' ? 'series' : 'movie';
        const items = rows
            .slice(skip, skip + window.limit)
            .filter((r): r is RawSearchResult & { id: number } => typeof r.id === 'number')
            .map(r => this.#toHit(r, kind));
        return { items, total, ...(last < wanted ? { cut: true as const } : {}) };
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, async () => {
            const version = await this.getVersion();
            // `/status` is public, so a wrong key passes it.
            await this.#http.get<unknown>('/api/v1/auth/me');
            return version;
        });
    }
}
