import { sanitizeGuid, fencer } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { newestFirst } from '../core/instant.ts';
import type { ArrKind } from '../core/resolver.ts';
import { ARR_PAGE_SIZE, pageIsNewestFirst, pageSizeFor, readArrPages, readTotal, type ArrRead } from './arrPaging.ts';
import { mediaIdOf, mediaIdsParam, type ArrHistoryScope } from './arrRecord.ts';
import type { HistoryEntry, HistoryEventType, HistoryQuery, Window } from './types.ts';

/**
 * Radarr and Sonarr share one history vocabulary almost entirely: both spell
 * a grab `grabbed` and an import `downloadFolderImported`, with one
 * exception: deletion. Radarr says `movieFileDeleted`, Sonarr says
 * `episodeFileDeleted`. One vocabulary here regardless; the upstream string
 * survives as `rawEvent` so nothing is hidden, and an event this map does not
 * yet know becomes `unknown` rather than being dropped.
 *
 * Confirmed against a live capture: Radarr showed `grabbed`,
 * `downloadFolderImported`, `movieFileDeleted` and `downloadFailed`; Sonarr
 * showed `grabbed`, `downloadFolderImported` and `episodeFileDeleted`.
 * `episodeFileImported`/`movieFileImported`/renamed/ignored were never
 * observed live but are kept as defensive entries: the generated spec
 * types `eventType` as a bare string, so an older or newer build could still
 * send them.
 *
 * Lidarr names its own (`EntityHistoryEventType`, read from Lidarr 3.1.0):
 * three imports: `artistFolderImported`, `trackFileImported` and
 * `downloadImported`, and `albumImportIncomplete` beside `downloadFailed`, a
 * download that arrived but could not all be imported. `trackFileRetagged`,
 * a file whose embedded tags Lidarr rewrote, is `retagged`.
 */
const EVENT: Record<string, HistoryEventType> = {
    grabbed: 'grabbed',
    downloadFolderImported: 'imported',
    episodeFileImported: 'imported',
    movieFileImported: 'imported',
    artistFolderImported: 'imported',
    trackFileImported: 'imported',
    downloadImported: 'imported',
    downloadFailed: 'failed',
    albumImportIncomplete: 'failed',
    movieFileDeleted: 'deleted',
    episodeFileDeleted: 'deleted',
    trackFileDeleted: 'deleted',
    episodeFileRenamed: 'renamed',
    movieFileRenamed: 'renamed',
    trackFileRenamed: 'renamed',
    trackFileRetagged: 'retagged',
    downloadIgnored: 'ignored'
};

type RawHistory = {
    id?: number;
    eventType?: string;
    date?: string;
    sourceTitle?: string;
    movieId?: number;
    seriesId?: number;
    /** Lidarr only. */
    artistId?: number;
    episodeId?: number;
    downloadId?: string;
    quality?: { quality?: { name?: string } };
    data?: {
        // Present on `grabbed` and `downloadFailed` only.
        indexer?: string;
        indexerId?: number;
        guid?: string;
        // Present on `*Deleted` (observed value: "Upgrade"), not on failures.
        reason?: string;
        // The failure text on `downloadFailed`. It is in whatever locale the
        // download client runs in and may contain a URL: fence it, never parse it.
        message?: string;
    };
};

/**
 * The `eventType` query value for each type, so the service filters before it
 * pages. Integers, because that is what `/api/v3/history` binds, and the two
 * differ from `deleted` on. Read from `EpisodeHistory.cs` (Sonarr 4.0.0 and
 * 4.0.19) and `History.cs` (Radarr 4.0.0 and 6.4.4).
 *
 * One value per type, because Sonarr 4.0.0 binds a single `int? eventType`.
 * `unknown` has none and is filtered here instead. Any other type with no
 * code for a service, such as `subtitle`, the other services' types, or
 * `retagged` on Radarr, Sonarr and Whisparr, is one none of that service's
 * rows maps to, so it is answered without a read: filtering locally would
 * read the whole history, which a live Sonarr capture put at 12,614 records,
 * to find nothing.
 *
 * Lidarr is the exception: it binds `int[] eventType` (`HistoryController`,
 * Lidarr 3.1.0) and spreads one type over several codes, so it is sent every
 * code for the type. `EntityHistory.cs`: ArtistFolderImported 2,
 * TrackFileImported 3 and DownloadImported 8 are imports; DownloadFailed 4
 * and AlbumImportIncomplete 7 are failures; TrackFileRetagged is 9 and
 * DownloadIgnored 10.
 */
const EVENT_CODE: Record<ArrKind, Partial<Record<HistoryEventType, number | readonly number[]>>> = {
    movie: { grabbed: 1, imported: 3, failed: 4, deleted: 6, renamed: 8, ignored: 9 },
    series: { grabbed: 1, imported: 3, failed: 4, deleted: 5, renamed: 6, ignored: 7 },
    artist: { grabbed: 1, imported: [2, 3, 8], failed: [4, 7], deleted: 5, renamed: 6, retagged: 9, ignored: 10 }
};

/**
 * The newest rows first, filtered to `eventType` and `since`. With `want`, and
 * no `since`, it stops once it has that many and takes `total` from the
 * service (#293) rather than reading the whole history to count it.
 *
 * `scope` says how an `id` reaches the service: see `ArrHistoryScope`.
 */
export async function readArrHistory(
    http: ServiceHttp,
    service: string,
    kind: ArrKind,
    opts: HistoryQuery,
    scope: ArrHistoryScope = 'ids'
): Promise<Window<HistoryEntry>> {
    const code = opts.eventType === undefined ? undefined : EVENT_CODE[kind][opts.eventType];
    if (opts.eventType !== undefined && opts.eventType !== 'unknown' && code === undefined) return { items: [], total: 0 };
    if (opts.id !== undefined && scope === 'seriesEndpoint') return readSeriesHistory(http, service, kind, opts, opts.id);
    let pages = await readHistoryPages(http, service, kind, opts, code, false);
    // Radarr 4 filters history through `filterKey`/`filterValue` and ignores a
    // bare `eventType`, so a filter sent upstream is checked, not trusted.
    let sent = code;
    if (code !== undefined && pages.entries.some(e => e.event !== opts.eventType)) {
        sent = undefined;
        pages = await readHistoryPages(http, service, kind, opts, undefined, false);
    }
    // Radarr binds `movieIds` from 5.2 on and drops it before, answering every
    // film's rows, so a scoped read is checked the same way.
    const foreign = (e: HistoryEntry): boolean => opts.id !== undefined && e.mediaId !== undefined && e.mediaId !== opts.id;
    if (pages.entries.some(foreign)) pages = await readHistoryPages(http, service, kind, opts, sent, true);

    const items = pages.entries.filter(e => (opts.eventType === undefined || e.event === opts.eventType) && !foreign(e));
    // Exact when the walk reached the end, an upper bound when a locally
    // filtered walk stopped early.
    const total = pages.windowed ? readTotal(pages.read, items.length) : items.length;
    const stoppedEarly = pages.read.totalRecords !== undefined && pages.read.records.length < pages.read.totalRecords;
    return { items, total, ...(pages.windowed && pages.filteredHere && stoppedEarly ? { atMost: true as const } : {}) };
}

/**
 * One series' history through `/history/series?seriesId=`, for Whisparr, whose
 * `/history` binds no `seriesIds` (its spec) and so would answer every site's
 * rows. That endpoint is a bare `HistoryResource[]` with no paging or sort,
 * so the whole list comes back in one read and is sorted, then filtered here.
 */
async function readSeriesHistory(
    http: ServiceHttp,
    service: string,
    kind: ArrKind,
    opts: HistoryQuery,
    id: string
): Promise<Window<HistoryEntry>> {
    const records = await http.get<RawHistory[]>(`${http.apiRoot}/history/series?seriesId=${encodeURIComponent(id)}`);
    const items = toEntries(Array.isArray(records) ? records : [], service, kind, opts.since)
        .filter(e => opts.eventType === undefined || e.event === opts.eventType)
        .sort(newestFirst);
    return { items, total: items.length };
}

async function readHistoryPages(
    http: ServiceHttp,
    service: string,
    kind: ArrKind,
    opts: HistoryQuery,
    code: number | readonly number[] | undefined,
    idHere: boolean
): Promise<{ entries: HistoryEntry[]; read: ArrRead<unknown>; windowed: boolean; filteredHere: boolean }> {
    // Confirmed live: /api/v3/history/movie?movieId=<id> answers a bare
    // HistoryResource[], not the {records, totalRecords} envelope pageArr
    // expects, so a scoped read through it always looked empty. The paged
    // /api/v3/history endpoint takes the same movieIds/seriesIds filter and
    // answers the real envelope, so scoping happens there instead. Lidarr's
    // takes `artistIds`, applied server-side on 2.1.3 (the version floor).
    const scoped = mediaIdsParam(kind);

    // Explicit, not assumed: the early exit below only works if the service
    // is actually sorted newest first, and a live capture showing that order
    // by default is not the same as asking for it.
    const sort = 'sortKey=date&sortDirection=descending';
    const query = [
        ...(opts.id === undefined || idHere ? [] : [`${scoped}=${encodeURIComponent(opts.id)}`]),
        ...(code === undefined ? [] : [code].flat().map(c => `eventType=${c}`)),
        sort
    ].join('&');

    // A `since` read has to reach its boundary to count what is in range, so
    // only a read without one can stop at `want`.
    const since = opts.since;
    const want = since === undefined ? opts.want : undefined;
    // The filter only happens here when no code was sent upstream. A sparse
    // type over an unfiltered list needs whole pages, and the walk stops on
    // the rows that match, not the rows read.
    const eventHere = opts.eventType !== undefined && code === undefined;
    const filterHere = eventHere || idHere;
    const id = idHere ? opts.id : undefined;
    let matched = 0;

    const read = await readArrPages<RawHistory>(http, `${http.apiRoot}/history`, query, {
        ...(want === undefined ? {} : { pageSize: filterHere ? ARR_PAGE_SIZE : pageSizeFor(want) }),
        stopWhen: (page, kept) => {
            if (filterHere) {
                matched += page.filter(
                    r =>
                        typeof r.id === 'number' &&
                        (!eventHere || (EVENT[r.eventType ?? ''] ?? 'unknown') === opts.eventType) &&
                        (id === undefined || String(mediaIdOf(r, kind) ?? id) === id)
                ).length;
            }
            // Trust an early exit only when this page is actually newest-first.
            if (!pageIsNewestFirst(page)) return false;
            const oldest = page[page.length - 1]?.date ?? '';
            // Once a page's oldest record predates `since`, every later page
            // does too. A live Sonarr capture held 12,614 records.
            if (since !== undefined) return oldest < since;
            if (want === undefined) return false;
            return filterHere ? matched >= want : kept >= want;
        }
    });
    const entries = toEntries(read.records, service, kind, opts.since);
    return { entries, read, windowed: want !== undefined, filteredHere: filterHere };
}

function toEntries(records: readonly RawHistory[], service: string, kind: ArrKind, since: string | undefined): HistoryEntry[] {
    const fence = fencer(service);
    return records
        .filter((r): r is RawHistory & { id: number } => typeof r.id === 'number')
        .map(r => {
            const raw = r.eventType ?? '';
            const mediaId = mediaIdOf(r, kind);
            const reason = r.data?.reason ?? r.data?.message;
            return {
                service,
                id: String(r.id),
                at: r.date ?? '',
                event: EVENT[raw] ?? 'unknown',
                rawEvent: raw,
                title: fence(r.sourceTitle ?? '', 'sourceTitle'),
                ...(mediaId === undefined ? {} : { mediaId: String(mediaId) }),
                ...(r.downloadId === undefined || r.downloadId === '' ? {} : { downloadId: r.downloadId.toLowerCase() }),
                ...(r.episodeId === undefined ? {} : { episodeId: String(r.episodeId) }),
                ...(r.data?.indexer === undefined ? {} : { indexer: fence(r.data.indexer, 'indexer') }),
                ...(r.quality?.quality?.name === undefined ? {} : { quality: r.quality.quality.name }),
                ...(reason === undefined ? {} : { reason: fence(reason, 'reason') }),
                // Not fenced: an opaque id pair a later release-grab tool needs
                // verbatim, not prose reaching model context. Still an
                // indexer-chosen string, so it is stripped of the same
                // dangerous code points fenced text is, and length-capped.
                ...(r.data?.guid === undefined ? {} : { guid: sanitizeGuid(r.data.guid) }),
                ...(r.data?.indexerId === undefined ? {} : { indexerId: r.data.indexerId })
            };
        })
        // Filtered here rather than upstream: neither service takes a date
        // range on this endpoint. `stopWhen` above only ends the *paging*
        // early: the page holding the boundary still has older records on
        // it, and this is what drops them.
        .filter(e => since === undefined || e.at >= since);
}
