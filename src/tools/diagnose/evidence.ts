import type { ServiceId } from '../../config/schema.ts';
import { ServiceError } from '../../core/errors.ts';
import { gather, type Gathered } from '../../core/gather.ts';
import { logger } from '../../core/logger.ts';
import { isFilmOrSeries, type ExternalIds, type LibraryKind, type MergedItem } from '../../core/resolver.ts';
import {
    hasCleanup,
    hasCleanuparr,
    hasHistory,
    hasIndexers,
    hasMediaDetails,
    hasQueue,
    hasRequests,
    hasScanState,
    hasSubtitles,
    hasUserLibrary,
    type HistoryEntry,
    type IndexerRejection,
    type MediaRequest,
    type QueueItem,
    type ScanState,
    type ServiceAdapter
} from '../../services/types.ts';
import type { LibraryLoader } from '../library.ts';
import type { IdentityResolver } from '../../core/identity.ts';
import { mayManageRequest } from '../manageRequests.ts';
import { resolveInstance } from '../resolveInstance.ts';
import { queueRowsFor, releaseMentions, type Evidence } from './chain.ts';

export type DiagnoseTarget = { query?: string; service?: ServiceId; id?: string; instance?: string; user?: string };

export type DiagnoseDeps = {
    adapters: readonly ServiceAdapter[];
    library: LibraryLoader;
    /** With two media servers, the one diagnose walks; absent means the first. */
    primaryMediaServer?: string;
    /** Decides whether an approval can be offered; without it none is. */
    seerrIdentity?: IdentityResolver;
};

const RECENT_REJECTION_LIMIT = 50;
const CLEANUPARR_WINDOW_MS = 30 * 86_400_000;
const CLEANUPARR_EVENT_LIMIT = 500;
/** The download clients whose own history outlives the queue. A torrent client
 *  keeps none once the torrent is removed, so only the usenet clients have one
 *  today; `hasHistory` decides, so a client that gains one is read too. */
const CLIENT_SERVICES: readonly ServiceId[] = ['sabnzbd', 'nzbget', 'transmission', 'qbittorrent'];

const rowsOf = (read: HistoryEntry[] | { items: HistoryEntry[] } | undefined): HistoryEntry[] =>
    read === undefined ? [] : Array.isArray(read) ? read : read.items;

/**
 * The fallback for a query that resolved to nothing: download history searched
 * by release name. An item removed from Radarr whose torrent Cleanuparr then
 * cleaned is in no library, and its history is the only record left of what
 * happened. Bounded like the item path: the same 30 days and 500 Cleanuparr
 * events, and one history read per client.
 */
async function historyByName(adapters: readonly ServiceAdapter[], query: string, degraded: string[]): Promise<HistoryEntry[] | undefined> {
    const sources = adapters.filter(hasHistory).filter(a => hasCleanuparr(a) || CLIENT_SERVICES.includes(a.type));
    if (sources.length === 0) return undefined;
    const since = new Date(Date.now() - CLEANUPARR_WINDOW_MS).toISOString();
    const reads = await Promise.all(
        sources.map(a => probe(a.id, degraded, () => a.readHistory(hasCleanuparr(a) ? { since, want: CLEANUPARR_EVENT_LIMIT } : { since })))
    );
    return reads.flatMap(rowsOf).filter(r => releaseMentions(r.title, query));
}

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
    // The secondary's rows never enter the join, so its outage leaves the
    // primary's answer complete.
    const secondary = deps.library.secondaryMediaServerId;
    for (const id of snapshot.degraded) if (id !== secondary && !libraryDegraded.includes(id)) libraryDegraded.push(id);

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
                remedy: `Pass a service that holds media — radarr, sonarr, whisparr, jellyfin or plex — or diagnose by query instead.`
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
        const searchKind = details.kind === 'movie' || details.kind === 'series' || details.kind === 'artist' ? details.kind : undefined;
        const joined = snapshot.index.find(details.ids, searchKind);
        // An unknown kind scans every keyspace, and music is not what a media
        // server's `item` was asked about; a known `artist` only finds artists.
        if (joined !== undefined && (searchKind === 'artist' || isFilmOrSeries(joined))) return joined;

        // The id was valid and the index does not contain it — a real state,
        // not an error: the service holding it may be the one that failed to
        // load. Diagnosing the half we have beats reporting the item unknown
        // when the caller just handed us its id.
        //
        // `searchKind` (not a fresh coercion) decides the synthesised kind
        // too: for Radarr/Sonarr it is the kind they actually reported. A
        // media-server 'item' leaves no signal to disambiguate, and this chain
        // reads films and series, so 'movie' is the least-committal default.
        // An artist keeps its kind, so the chain reads Lidarr's queue for it and
        // not Radarr's.
        //
        // A media server contributes watch state and never acquisition, so it
        // is the capability that decides the shape, not the service's name —
        // a second one must not need editing here.
        const isMediaServer = hasUserLibrary(adapter);
        // The secondary's items are not in the primary's library, so naming
        // one must not read as "present in the primary".
        const isSecondary = isMediaServer && adapter.id === secondary;
        return {
            kind: searchKind ?? 'movie',
            title: details.title,
            ...(details.year === undefined ? {} : { year: details.year }),
            ids: details.ids,
            presence: isSecondary ? 'unknown' : isMediaServer ? 'jellyfin_only' : 'arr_only',
            ...(isSecondary ? { media_servers: { [adapter.id]: { present: true, itemId: target.id } } } : {}),
            ...(isMediaServer
                ? {}
                : {
                      acquisition: {
                          service: adapter.id,
                          id: target.id,
                          monitored: details.monitored ?? false,
                          hasFile: details.hasFile ?? false,
                          ...(details.quality === undefined ? {} : { quality: details.quality }),
                          ...(details.sizeBytes === undefined ? {} : { sizeBytes: details.sizeBytes })
                      }
                  })
        };
    }

    if (target.query === undefined) return undefined;
    // A film or series wins over an artist of the same name, which the ranking
    // alone cannot promise; the artist is diagnosed when nothing else matched.
    const hits = snapshot.index.search(target.query);
    return hits.find(isFilmOrSeries) ?? hits[0];
}

/**
 * The request for a title, matched on tmdbId and then tvdbId, never on title.
 * Shared with the write cross-checks so a warning and `diagnose` cannot
 * disagree about whether a title was requested.
 */
export function findRequest(requests: readonly MediaRequest[], ids: ExternalIds): MediaRequest | undefined {
    return (
        (ids.tmdb === undefined ? undefined : requests.find(r => r.tmdbId === ids.tmdb)) ??
        (ids.tvdb === undefined ? undefined : requests.find(r => r.tvdbId === ids.tvdb))
    );
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
    //
    // Not read for an artist: Seerr does not handle music, and an outage there
    // must not make a Lidarr diagnosis uncertain.
    const isArtist = item?.kind === 'artist';
    const seerr = isArtist ? undefined : deps.adapters.find(hasRequests);
    // The queues of the item's own kind, and the download clients' (no
    // `queueKind`). A film is not read against Lidarr's queue, so an unreachable
    // Lidarr cannot leave its queue "only partially known"; an artist is read
    // against Lidarr's alone, since a Radarr row could only match it by title.
    const queueKinds: readonly LibraryKind[] = isArtist ? ['artist'] : ['movie', 'series'];
    const queueAdapters = deps.adapters
        .filter(hasQueue)
        .filter(a => a.queueKind === undefined || queueKinds.includes(a.queueKind));
    const queueConfigured = queueAdapters.length > 0;
    const prowlarrs = deps.adapters.filter(hasIndexers);
    const prowlarrConfigured = prowlarrs.length > 0;
    // `hasUserLibrary`, matching what `LibraryLoader` itself selects on, so this
    // stage's "configured" cannot disagree with whether the library was gathered.
    const mediaServerAdapter = deps.adapters.find(
        a => hasUserLibrary(a) && (deps.primaryMediaServer === undefined || a.id === deps.primaryMediaServer)
    );
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

    // Each instance probed separately so one unreachable Prowlarr degrades by
    // name instead of erasing the rejections another returned.
    const prowlarrDegraded: string[] = [];
    // `undefined` keeps meaning every instance failed, which is what the
    // stage's total-failure branch reads. Flattened lists are re-sorted
    // newest-first: each instance answers in its own order, but the merge
    // settles in whatever order the promises resolve, and `mine[0]` below is
    // read as the most recent rejection overall.
    const rejectionsP: Promise<IndexerRejection[] | undefined> = !prowlarrConfigured
        ? Promise.resolve(undefined)
        : Promise.all(
              prowlarrs.map(async p => {
                  const rows = await probe(p.id, degraded, () => p.getRecentRejections(RECENT_REJECTION_LIMIT));
                  if (rows === undefined) prowlarrDegraded.push(p.id);
                  return rows ?? [];
              })
          ).then(lists =>
              prowlarrDegraded.length === prowlarrs.length
                  ? undefined
                  : lists.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
          );

    const scanP: Promise<ScanState | undefined> =
        scanAdapter === undefined
            ? Promise.resolve(undefined)
            : probe(scanAdapter.id, degraded, () => scanAdapter.getScanState());

    // Every wanted subtitle in the library, unpaged, so only for an item with a
    // file, and never an artist: Bazarr has no music. Probed like the rest: a
    // Bazarr that is down is `undefined` and `degraded`, and the stage reports
    // unknown without costing the verdict.
    const subtitlesAdapter = deps.adapters.find(hasSubtitles);
    const subtitlesP: Promise<Evidence['subtitles']> =
        subtitlesAdapter === undefined || isArtist || item?.acquisition?.hasFile !== true
            ? Promise.resolve(null) // without a file the stage skips before it reads this
            : probe(subtitlesAdapter.id, degraded, () => subtitlesAdapter.getMissingSubtitles()).then(gaps =>
                  gaps === undefined ? undefined : { gaps, service: subtitlesAdapter.id }
              );

    const [requests, queueGathered, rejections, scan, subtitles] = await Promise.all([requestsP, queueP, rejectionsP, scanP, subtitlesP]);

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
        const match = findRequest(requests, item.ids);
        // Whose request it is stays here: only whether the caller may act on it
        // leaves, so the next step is withheld where the write would refuse.
        // Unknown (no identity, or it would not resolve) reads as "may not".
        let mayRespond = false;
        if (match !== undefined && match.status === 'pending' && deps.seerrIdentity !== undefined) {
            mayRespond = await mayManageRequest(match, deps.seerrIdentity).catch(() => false);
        }
        request = match === undefined ? null : { status: match.status, id: match.id, mayRespond };
    }

    // null: not configured. undefined: could not look. Matched by download id,
    // which the *arr grab and Cleanuparr's record of it both carry.
    let cleanuparr: Evidence['cleanuparr'] = null;
    const cleanuparrAdapter = deps.adapters.find(hasCleanuparr);
    const cleanupAdapter = deps.adapters.find(hasCleanup);
    // The managing *arr's own history for this item, read once for whichever of the two below needs it.
    let arrHistory: Promise<HistoryEntry[]> | undefined;
    const readArrHistory = (): Promise<HistoryEntry[]> => {
        arrHistory ??= (async () => {
            const managing = item?.acquisition;
            const arr = managing?.id === undefined ? undefined : deps.adapters.find(a => a.id === managing.service);
            if (arr === undefined || !hasHistory(arr) || managing?.id === undefined) return [];
            const id = managing.id;
            const rows = await probe(`${arr.id}:history`, degraded, () => arr.readHistory({ id, want: 50 }));
            return rows === undefined ? [] : Array.isArray(rows) ? rows : rows.items;
        })();
        return arrHistory;
    };
    if (cleanuparrAdapter !== undefined && hasHistory(cleanuparrAdapter)) {
        const ids = new Set<string>();
        const mine = item === undefined ? [] : queueRowsFor(queue?.items ?? [], item);
        for (const q of mine) {
            if (q.downloadId !== undefined) ids.add(q.downloadId.toLowerCase());
        }
        for (const r of await readArrHistory()) {
            if (r.downloadId !== undefined) ids.add(r.downloadId.toLowerCase());
        }
        // Nothing to match, so an outage there must not cost an unrelated verdict its certainty.
        if (ids.size === 0) {
            cleanuparr = [];
        } else {
            const since = new Date(Date.now() - CLEANUPARR_WINDOW_MS).toISOString();
            const events = await probe(cleanuparrAdapter.id, degraded, () => cleanuparrAdapter.readHistory({ since, want: CLEANUPARR_EVENT_LIMIT }));
            const list = events === undefined ? undefined : Array.isArray(events) ? events : events.items;
            cleanuparr = list?.filter(e => e.downloadId !== undefined && ids.has(e.downloadId));
        }
    }

    const history = item === undefined && target.query !== undefined ? await historyByName(deps.adapters, target.query, degraded) : undefined;
    // null: no cleanup service, or no TMDB id to find the title by. undefined: could not look.
    let cleanup: Evidence['cleanup'] = null;
    let lastImportAt: string | undefined;
    const tmdb = item?.ids.tmdb;
    // Never for an artist: a cleanup service finds a title by its TMDB id, which music has none of.
    const cleanupKind = item?.kind === 'artist' ? undefined : item?.kind;
    if (cleanupAdapter !== undefined && item !== undefined && cleanupKind !== undefined && tmdb !== undefined) {
        cleanup = await probe(cleanupAdapter.id, degraded, () => cleanupAdapter.readCleanupStatus(cleanupKind, tmdb));
        // A removal only explains a missing file if nothing was imported after it.
        if ((cleanup?.removals.length ?? 0) > 0 && item.acquisition?.hasFile !== true) {
            lastImportAt = (await readArrHistory())
                .filter(r => r.event === 'imported')
                .map(r => r.at)
                .sort()
                .at(-1);
        }
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
        prowlarrDegraded: prowlarrDegraded.sort(),
        scan,
        ...(mediaServer === undefined ? {} : { mediaServer }),
        scanCapable: scanAdapter !== undefined,
        cleanuparr,
        subtitles,
        ...(history === undefined ? {} : { history }),
        cleanup,
        ...(cleanupAdapter !== undefined && cleanup === undefined ? { cleanupUnread: cleanupAdapter.id } : {}),
        ...(lastImportAt === undefined ? {} : { lastImportAt }),
        libraryDegraded,
        degraded
    };
}
