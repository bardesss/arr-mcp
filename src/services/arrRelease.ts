import { fenceText, sanitizeGuid } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { ServiceError } from '../core/errors.ts';
import type { ReleaseCandidate } from './types.ts';

/**
 * `/api/v3/release` polls every configured indexer synchronously. A live
 * capture measured a Radarr movie search at 0.5s but a Sonarr season search
 * at 14.3s, and a cold search across more indexers, or a whole-series
 * search, runs longer still. The adapter-wide HTTP timeout (10s default)
 * would cut that off, so this call gets its own, generous one — bounded so a
 * dead indexer does not hang forever, but not so tight that a real search
 * gets mistaken for one.
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
    kind: 'movie' | 'series',
    opts: { id: string; season?: number }
): Promise<ReleaseCandidate[]> {
    if (kind === 'movie' && opts.season !== undefined) {
        throw new ServiceError('NotFound', service, `${service} has no season — season search is Sonarr-only`, {
            remedy: 'Drop `season` for a Radarr search, or point it at a configured Sonarr instance.'
        });
    }

    const query =
        kind === 'movie'
            ? `movieId=${encodeURIComponent(opts.id)}`
            : `seriesId=${encodeURIComponent(opts.id)}${
                  opts.season === undefined ? '' : `&seasonNumber=${opts.season}`
              }`;

    // `retry: false`: the default timeout retry re-issues the whole request,
    // which here means a second full synchronous poll of every configured
    // indexer stacked on the first — the exact "starts a second sweep" this
    // tool's own description warns a caller against causing by retrying.
    const raw = await http.get<RawRelease[]>(`/api/v3/release?${query}`, {
        timeoutMs: RELEASE_SEARCH_TIMEOUT_MS,
        retry: false
    });

    // Every other adapter guards its top-level shape before iterating it;
    // this one did not, and a non-array body (an error page, a changed
    // response shape) would throw a bare TypeError out of `.filter` instead
    // of the ServiceError vocabulary every other failure here uses.
    if (!Array.isArray(raw)) {
        throw new ServiceError('UpstreamError', service, '/api/v3/release did not return an array');
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
            ...(r.protocol === undefined ? {} : { protocol: r.protocol }),
            rejected: r.rejected ?? false,
            rejections: (r.rejections ?? []).map(reason => fence(reason, 'rejection'))
        }));
}

/**
 * Sends one already-listed release to the download client.
 *
 * `discardBody`: both services answer a successful grab with the release
 * echoed back, and nothing here reads it. A guid the indexer no longer serves
 * answers 404, which is the failure this cannot distinguish from a bad path —
 * so `grab_release` re-runs the search first and refuses before reaching here.
 */
export async function grabArrRelease(
    http: ServiceHttp,
    opts: { guid: string; indexerId: number }
): Promise<void> {
    await http.post('/api/v3/release', { guid: opts.guid, indexerId: opts.indexerId }, true);
}
