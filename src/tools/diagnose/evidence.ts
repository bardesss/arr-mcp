import type { ServiceId } from '../../config/schema.ts';
import { ServiceError } from '../../core/errors.ts';
import { gather, type Gathered } from '../../core/gather.ts';
import { logger } from '../../core/logger.ts';
import type { MergedItem } from '../../core/resolver.ts';
import {
    hasIndexers,
    hasMediaDetails,
    hasQueue,
    hasRequests,
    hasScanState,
    type IndexerRejection,
    type MediaRequest,
    type QueueItem,
    type ScanState,
    type ServiceAdapter
} from '../../services/types.ts';
import type { LibraryLoader } from '../library.ts';
import type { Evidence } from './chain.ts';

export type DiagnoseTarget = { query?: string; service?: ServiceId; id?: string; user?: string };

export type DiagnoseDeps = {
    adapters: readonly ServiceAdapter[];
    library: LibraryLoader;
};

const RECENT_REJECTION_LIMIT = 50;

/**
 * Every probe returns `undefined` on failure and records the service in
 * `degraded`. That is the shape the chain reads: undefined is "could not
 * look", and it is what stops a verdict being confident across a hole.
 */
async function probe<T>(id: string, degraded: string[], fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        logger.warn({ service: id, err }, 'diagnose probe failed; the stage will report unknown');
        if (!degraded.includes(id)) degraded.push(id);
        return undefined;
    }
}

async function resolveItem(
    deps: DiagnoseDeps,
    target: DiagnoseTarget,
    degraded: string[],
    libraryDegraded: string[]
): Promise<MergedItem | undefined> {
    // the gate lives in the loader's identity resolver, and a refusal
    // propagates out of diagnose rather than becoming a degraded stage — this
    // call is deliberately not wrapped in `probe`.
    const snapshot = await deps.library.load(target.user);
    // Library-read reachability, in its own array rather than folded into
    // `degraded`. A Jellyfin scan probe failing must not make `libraryStep`
    // believe the *library read* failed, nor a Radarr library read make
    // `queueStep` believe Radarr's *queue* probe failed. Each stage reads only
    // the signal that applies to it.
    for (const id of snapshot.degraded) if (!libraryDegraded.includes(id)) libraryDegraded.push(id);

    // The explicit id wins: it is unambiguous and a title is not.
    if (target.service !== undefined && target.id !== undefined) {
        const adapter = deps.adapters.find(a => a.id === target.service);
        // A service the schema accepts but that has no getMediaDetails
        // (sabnzbd, say) is a configuration mistake, not a hole to degrade
        // across. Returning `undefined` would make the caller's own named
        // service read as "this does not exist" with `certain: true`. Same
        // error and remedy as get_media_details.
        if (adapter === undefined || !hasMediaDetails(adapter)) {
            throw new ServiceError('NotFound', target.service, `${target.service} is not configured`, {
                remedy: `Add services.${target.service} to config.yaml, or name a configured service.`
            });
        }

        const details = await probe(adapter.id, degraded, () =>
            adapter.getMediaDetails(target.id as string, { includeEpisodes: false, episodeLimit: 1 })
        );
        if (details === undefined) return undefined;

        // Jellyfin's MediaDetails never says 'movie' or 'series' — it is the
        // one adapter that reports `kind: 'item'` for everything. Passing a
        // *wrong* kind to `find` is worse than passing none: it restricts the
        // lookup to one keyspace and can silently miss a real hit sitting in
        // the other (a series id would scan only movie keys and never find
        // it). `undefined` here makes `find` scan both, exactly as it already
        // does for every caller that does not know the kind in advance.
        const searchKind = details.kind === 'item' ? undefined : details.kind;
        const joined = snapshot.index.find(details.ids, searchKind);
        if (joined !== undefined) return joined;

        // The id was valid and the index does not contain it — a real state,
        // not an error: the service holding it may be the one that failed to
        // load. Diagnosing the half we have beats reporting the item unknown
        // when the caller just handed us its id.
        //
        // `searchKind` (not a fresh coercion) decides the synthesised kind
        // too: for Radarr/Sonarr it is the kind they actually reported: for
        // Jellyfin's ambiguous 'item' — reachable only when *no* index entry
        // matched under either kind — there is no signal left to disambiguate,
        // so 'movie' is the least-committal default already implied by
        // `MergedItem.kind` having no third option.
        return {
            kind: searchKind ?? 'movie',
            title: details.title,
            ...(details.year === undefined ? {} : { year: details.year }),
            ids: details.ids,
            presence: adapter.id === 'jellyfin' ? 'jellyfin_only' : 'arr_only',
            ...(adapter.id === 'jellyfin'
                ? {}
                : {
                      acquisition: {
                          service: adapter.id,
                          monitored: details.monitored ?? false,
                          hasFile: details.hasFile ?? false,
                          ...(details.quality === undefined ? {} : { quality: details.quality }),
                          ...(details.sizeBytes === undefined ? {} : { sizeBytes: details.sizeBytes })
                      }
                  })
        };
    }

    return target.query === undefined ? undefined : snapshot.index.search(target.query)[0];
}

export async function collectEvidence(deps: DiagnoseDeps, target: DiagnoseTarget): Promise<Evidence> {
    if (target.query === undefined && (target.service === undefined || target.id === undefined)) {
        throw new Error('Name either a query (a title) or both service and id.');
    }

    const degraded: string[] = [];
    const libraryDegraded: ServiceId[] = [];
    const item = await resolveItem(deps, target, degraded, libraryDegraded);

    // Structural, not `instanceof SeerrAdapter`: every other capability here
    // (queue, indexers, scan, media details) is checked the same way, and
    // duck-typing is what lets a test double stand in for the real adapter.
    const seerr = deps.adapters.find(hasRequests);
    const queueAdapters = deps.adapters.filter(hasQueue);
    const queueConfigured = queueAdapters.length > 0;
    const prowlarr = deps.adapters.find(hasIndexers);
    const prowlarrConfigured = prowlarr !== undefined;
    const jellyfin = deps.adapters.filter(hasScanState).find(a => a.id === 'jellyfin');
    const jellyfinConfigured = jellyfin !== undefined;

    // `null` here is a third state the chain needs: not configured, as
    // distinct from asked-and-empty (`[]`) or could-not-ask (`undefined`).
    const requestsP: Promise<MediaRequest[] | null | undefined> =
        seerr === undefined ? Promise.resolve(null) : probe(seerr.id, degraded, () => seerr.getRequests({}));

    // Multi-service: `gather` already distinguishes "some clients answered,
    // some didn't" from "all of them did" — exactly the queue shape asks
    // for, folded into `queue`/`queueConfigured` below rather than collapsed
    // to a single undefined the way one failing client used to erase the
    // whole stage.
    const queueP: Promise<Gathered<QueueItem> | undefined> = queueConfigured
        ? gather(queueAdapters.map(a => ({ id: a.id, fetch: () => a.getQueue() })))
        : Promise.resolve(undefined);

    const rejectionsP: Promise<IndexerRejection[] | undefined> =
        prowlarr === undefined
            ? Promise.resolve(undefined)
            : probe(prowlarr.id, degraded, () => prowlarr.getRecentRejections(RECENT_REJECTION_LIMIT));

    const scanP: Promise<ScanState | undefined> =
        jellyfin === undefined ? Promise.resolve(undefined) : probe(jellyfin.id, degraded, () => jellyfin.getScanState());

    const [requests, queueGathered, rejections, scan] = await Promise.all([requestsP, queueP, rejectionsP, scanP]);

    let queue: Evidence['queue'];
    if (queueGathered === undefined) {
        // Either no download client is configured (queueConfigured is what
        // tells the chain which), or every configured one failed to answer.
        queue = undefined;
    } else {
        for (const id of queueGathered.degraded) if (!degraded.includes(id)) degraded.push(id);
        queue =
            queueGathered.degraded.length === queueAdapters.length
                ? undefined // nothing read at all
                : { items: queueGathered.items, partial: queueGathered.degraded }; // some rows plus a hole
    }

    /**
     * Matched on tmdbId, falling back to tvdbId, never on title. Title is
     * only optionally present on a Seerr request (`MediaRequest['title']` is
     * `?`), and even when it is, a fuzzy match is far more fragile than the
     * strong, structured ids already used for the whole join.
     *
     * tmdbId is tried first because it is the id both movies and series can
     * carry; tvdbId is the fallback that closes Task 7's Finding B —
     * `SonarrAdapter.listLibrary` never emits `tmdb`, only `tvdb`, so without
     * this fallback a Sonarr+Seerr stack with no Jellyfin could never match a
     * series request at all.
     *
     * The requester's name is deliberately not carried into the evidence. The
     * status answers the question, and naming who asked exposes another
     * household member's activity to whoever ran the tool.
     */
    let request: Evidence['request'];
    if (requests === undefined) {
        request = undefined; // could not ask
    } else if (requests === null) {
        request = null; // no Seerr configured
    } else if (item === undefined) {
        request = null; // nothing resolved to match against
    } else if (item.ids.tmdb === undefined && item.ids.tvdb === undefined) {
        // Seerr answered, but this item carries neither id to match on — e.g.
        // a Sonarr series whose Jellyfin counterpart is absent, unreachable,
        // or was never mapped, and whose own record from Sonarr carries no
        // tvdb id either. `undefined` means "could not determine", not
        // "looked and found nothing" — a real pending request must not be
        // reported as no request at all just because the join has a gap.
        request = undefined;
    } else {
        const match =
            (item.ids.tmdb === undefined ? undefined : requests.find(r => r.tmdbId === item.ids.tmdb)) ??
            (item.ids.tvdb === undefined ? undefined : requests.find(r => r.tvdbId === item.ids.tvdb));
        request = match === undefined ? null : { status: match.status };
    }

    degraded.sort();
    libraryDegraded.sort();
    return {
        item,
        request,
        queue,
        queueConfigured,
        rejections,
        prowlarrConfigured,
        scan,
        jellyfinConfigured,
        libraryDegraded,
        degraded
    };
}
