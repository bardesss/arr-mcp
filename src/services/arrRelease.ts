import { fenceText, sanitizeGuid } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { ServiceError } from '../core/errors.ts';
import { arrItemId } from './arrCommands.ts';
import { protocolName } from './arrRecord.ts';
import type { ReleaseCandidate, ReleaseScope } from './types.ts';

/**
 * `/release` (`/api/v3` on Radarr and Sonarr, `/api/v1` on Lidarr) polls every
 * configured indexer synchronously. A live capture measured a Radarr movie
 * search at 0.5s but a Sonarr season search at 14.3s, and a cold search across
 * more indexers, or a whole-series search, runs longer still. The adapter-wide
 * HTTP timeout (10s default) would cut that off, so this call gets its own,
 * generous one — bounded so a dead indexer does not hang forever, but not so
 * tight that a real search gets mistaken for one.
 */
export const RELEASE_SEARCH_TIMEOUT_MS = 120_000;

type RawLanguage = { id?: number; name?: string };

type RawRelease = {
    guid?: string;
    indexerId?: number;
    indexer?: string;
    title?: string;
    size?: number;
    seeders?: number;
    age?: number;
    quality?: { quality?: { name?: string } };
    languages?: RawLanguage[];
    protocol?: string;
    rejected?: boolean;
    rejections?: string[];
};

export async function findArrReleases(
    http: ServiceHttp,
    service: string,
    kind: 'movie' | 'series' | 'site',
    opts: ReleaseScope
): Promise<ReleaseCandidate[]> {
    // Refused rather than dropped: without it the search would cover the
    // whole film or series, which is not what was asked for.
    if (opts.album !== undefined) {
        throw new ServiceError('NotFound', service, '`album` is a Lidarr option', {
            remedy: 'Only a Lidarr artist has albums. Scope a Sonarr or Whisparr search with `season` or `episode`, and a Radarr one with neither.'
        });
    }
    if (kind === 'movie' && (opts.season !== undefined || opts.episode !== undefined)) {
        throw new ServiceError('NotFound', service, `${service} has no seasons or episodes — that scope is Sonarr-only`, {
            remedy: 'Drop `season` and `episode` for a Radarr search, or point it at a configured Sonarr instance.'
        });
    }
    if (opts.season !== undefined && opts.episode !== undefined) {
        throw new ServiceError('NotFound', service, '`season` and `episode` were both given', {
            remedy: 'They are different scopes — send one. `episode` searches that episode alone; `season` searches every episode in the season.'
        });
    }

    // Ids go into a query string, so they are checked here rather than
    // encoded: `0` or `abc` would search for nothing and answer an empty list.
    const itemId = arrItemId(service, kind, opts.id);
    const episodeId =
        opts.episode === undefined ? undefined : arrItemId(service, kind === 'site' ? 'scene' : 'episode', opts.episode);

    // Sonarr runs one indexer search per episode, so a season or series
    // search costs that many sweeps; `episodeId` alone is a single one.
    const query =
        kind === 'movie'
            ? `movieId=${itemId}`
            : episodeId !== undefined
              ? `episodeId=${episodeId}`
              : `seriesId=${itemId}${
                    opts.season === undefined ? '' : `&seasonNumber=${opts.season}`
                }`;

    return readReleases(http, service, query);
}

/**
 * Lidarr's interactive search: the artist, or one album of it. Lidarr's
 * `ReleaseController` takes `albumId` or `artistId`, and answers its RSS feed
 * when it gets neither, so the adapter checks the ids before this is reached.
 */
export async function findLidarrReleases(
    http: ServiceHttp,
    service: string,
    opts: { artistId: number; albumId?: number }
): Promise<ReleaseCandidate[]> {
    return readReleases(
        http,
        service,
        opts.albumId === undefined ? `artistId=${opts.artistId}` : `albumId=${opts.albumId}`
    );
}

async function readReleases(http: ServiceHttp, service: string, query: string): Promise<ReleaseCandidate[]> {
    // `retry: false`: the default timeout retry re-issues the whole request,
    // which here means a second full synchronous poll of every configured
    // indexer stacked on the first — the exact "starts a second sweep" this
    // tool's own description warns a caller against causing by retrying.
    const raw = await http.get<RawRelease[]>(`${http.apiRoot}/release?${query}`, {
        timeoutMs: RELEASE_SEARCH_TIMEOUT_MS,
        retry: false
    });

    // Every other adapter guards its top-level shape before iterating it;
    // this one did not, and a non-array body (an error page, a changed
    // response shape) would throw a bare TypeError out of `.filter` instead
    // of the ServiceError vocabulary every other failure here uses.
    if (!Array.isArray(raw)) {
        throw new ServiceError('UpstreamError', service, `${http.apiRoot}/release did not return an array`);
    }

    const fence = (value: string, field: string) => fenceText(value, { service, field });

    return raw
        .filter(
            (r): r is RawRelease & { guid: string; indexerId: number } =>
                typeof r.guid === 'string' && typeof r.indexerId === 'number'
        )
        .map(r => ({
            service,
            // Not fenced — a future grab tool needs this verbatim, and its
            // own type comment says as much — but still an indexer-chosen
            // string, stripped of the code points that let one render as
            // something it is not, and length-capped.
            guid: sanitizeGuid(r.guid),
            indexerId: r.indexerId,
            indexer: fence(r.indexer ?? '', 'indexer'),
            title: fence(r.title ?? '', 'title'),
            ...(r.size === undefined ? {} : { sizeBytes: r.size }),
            ...(r.seeders === undefined ? {} : { seeders: r.seeders }),
            ...(r.age === undefined ? {} : { age: r.age }),
            ...(r.quality?.quality?.name === undefined ? {} : { quality: r.quality.quality.name }),
            ...(r.languages?.[0]?.name === undefined ? {} : { language: r.languages[0].name }),
            ...(r.protocol === undefined ? {} : { protocol: protocolName(r.protocol) }),
            rejected: r.rejected ?? false,
            rejections: (r.rejections ?? []).map(reason => fence(reason, 'rejection'))
        }));
}

/**
 * Sends one already-listed release to the download client.
 *
 * `discardBody`: every *arr answers a successful grab with the release
 * echoed back, and nothing here reads it. A guid the indexer no longer serves
 * answers 404, which is the failure this cannot distinguish from a bad path —
 * so `grab_release` re-runs the search first and refuses before reaching here.
 */
export async function grabArrRelease(
    http: ServiceHttp,
    opts: { guid: string; indexerId: number },
    timeoutMs?: number
): Promise<void> {
    await http.post(
        `${http.apiRoot}/release`,
        { guid: opts.guid, indexerId: opts.indexerId },
        true,
        timeoutMs === undefined ? undefined : { timeoutMs }
    );
}

/**
 * Lidarr's grab answers only once it has fetched the release from the indexer
 * and handed it to the download client. Live on 3.1.6, that ran past the 10s
 * default: the release was grabbed and the tool reported a timeout, which
 * invites a retry that grabs it twice. So it gets the release-search timeout,
 * and a timeout that still happens says the grab may have gone through.
 */
export async function grabLidarrRelease(
    http: ServiceHttp,
    service: string,
    opts: { guid: string; indexerId: number }
): Promise<void> {
    try {
        await grabArrRelease(http, opts, RELEASE_SEARCH_TIMEOUT_MS);
    } catch (err) {
        if (err instanceof ServiceError && err.kind === 'Timeout') {
            throw new ServiceError('Timeout', service, err.detail, {
                remedy: `The grab may still have gone through: ${service} answers only after handing the release to the download client. Check get_queue or get_history before grabbing again, or it may download twice.`,
                cause: err
            });
        }
        throw err;
    }
}
