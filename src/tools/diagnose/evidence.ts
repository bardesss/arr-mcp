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
    hasUserLibrary,
    type IndexerRejection,
    type MediaRequest,
    type QueueItem,
    type ScanState,
    type ServiceAdapter
} from '../../services/types.ts';
import type { LibraryLoader } from '../library.ts';
import { resolveInstance } from '../resolveInstance.ts';
import type { Evidence } from './chain.ts';

export type DiagnoseTarget = { query?: string; service?: ServiceId; id?: string; instance?: string; user?: string };

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
        // resolveInstance rather than `find(a => a.id === service)`: `id` is
        // `radarr/4k` for a named instance, so the open-coded form matched
        // nothing and answered "radarr is not configured" about a Radarr that
        // plainly was. Six tools moved off that lookup when it was written;
        // this was the one left behind.
        const adapter = resolveInstance(deps.adapters, target.service, target.instance);

        // A service the schema accepts but that has no getMediaDetails
        // (sabnzbd, say) is a configuration mistake, not a hole to degrade
        // across. Returning `undefined` would make the caller's own named
        // service read as "this does not exist" with `certain: true`. Same
        // error and remedy as get_media_details.
        if (!hasMediaDetails(adapter)) {
            throw new ServiceError('NotFound', target.service, `${target.service} cannot look up an item by id`, {
                remedy: `Pass a service that holds media — radarr, sonarr or jellyfin — or diagnose by query instead.`
            });
        }

        // Not wrapped in `probe` wholesale: `probe` catches everything, so the
        // NotFound a nonexistent id produces pushed the adapter into `degraded`
        // and answered "radarr could not be checked" when Radarr had answered
        // definitively — steering the caller toward reporting an outage instead
        // of fixing the id. Degradation is for reachability, not for a service
        // saying no. get_media_details throws legibly in the same situation.
        let details;
        try {
            details = await adapter.getMediaDetails(target.id, {
                includeEpisodes: false,
                episodeLimit: 1
            });
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'NotFound') throw err;
            logger.warn({ service: adapter.id, err }, 'diagnose probe failed; the stage will report unknown');
            if (!degraded.includes(adapter.id)) degraded.push(adapter.id);
            return undefined;
        }

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
        //
        // A media server contributes watch state and never acquisition, so it
        // is the capability that decides the shape, not the service's name —
        // a second one must not need editing here.
        const isMediaServer = hasUserLibrary(adapter);
        return {
            kind: searchKind ?? 'movie',
            title: details.title,
            ...(details.year === undefined ? {} : { year: details.year }),
            ids: details.ids,
            presence: isMediaServer ? 'jellyfin_only' : 'arr_only',
            ...(isMediaServer
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

    // Refused rather than dropped. `service` and `instance` scope an id
    // lookup; a query is answered from the merged library index, which has no
    // per-service keyspace to narrow. Ignoring them silently answered a
    // different question than the one asked.
    if (target.query !== undefined && (target.service !== undefined || target.instance !== undefined)) {
        throw new Error(
            'service and instance only apply when diagnosing by id. Pass an id with them, or a query on its own.'
        );
    }

    const degraded: string[] = [];
    // `string[]`, not `ServiceId[]`: what arrives here is `LibrarySnapshot`'s
    // own `degraded`, which is keyed by **source**, so it can hold
    // `jellyfin:seasons` as well as a plain service id. The declaration was
    // never enforced — the ids come in through a `string[]` parameter — so it
    // only claimed something untrue about what the array holds.
    const libraryDegraded: string[] = [];
    const item = await resolveItem(deps, target, degraded, libraryDegraded);

    // Structural, not `instanceof SeerrAdapter`: every other capability here
    // (queue, indexers, scan, media details) is checked the same way, and
    // duck-typing is what lets a test double stand in for the real adapter.
    const seerr = deps.adapters.find(hasRequests);
    const queueAdapters = deps.adapters.filter(hasQueue);
    const queueConfigured = queueAdapters.length > 0;
    const prowlarr = deps.adapters.find(hasIndexers);
    const prowlarrConfigured = prowlarr !== undefined;
    // `hasUserLibrary`, matching what `LibraryLoader` itself selects on, so this
    // stage's "configured" cannot disagree with whether the library was gathered.
    const mediaServerAdapter = deps.adapters.find(hasUserLibrary);
    const mediaServer = mediaServerAdapter?.id;
    // Separate from the line above: a media server that reads a library but cannot
    // report a scan makes `scanStep` skip without making `libraryStep` skip too.
    const scanAdapter =
        mediaServerAdapter !== undefined && hasScanState(mediaServerAdapter) ? mediaServerAdapter : undefined;

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
        scanAdapter === undefined
            ? Promise.resolve(undefined)
            : probe(scanAdapter.id, degraded, () => scanAdapter.getScanState());

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
        ...(mediaServer === undefined ? {} : { mediaServer }),
        scanCapable: scanAdapter !== undefined,
        libraryDegraded,
        degraded
    };
}
