import { fenceText, sanitizeGuid } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { pageSizeFor, readArrPages, readTotal, type ArrRead } from './arrPaging.ts';
import type { HistoryEntry, HistoryEventType, HistoryQuery, Window } from './types.ts';

/**
 * Radarr and Sonarr share one history vocabulary almost entirely — both spell
 * a grab `grabbed` and an import `downloadFolderImported` — with one
 * exception: deletion. Radarr says `movieFileDeleted`, Sonarr says
 * `episodeFileDeleted`. One vocabulary here regardless; the upstream string
 * survives as `rawEvent` so nothing is hidden, and an event this map does not
 * yet know becomes `unknown` rather than being dropped.
 *
 * Confirmed against a live capture: Radarr showed `grabbed`,
 * `downloadFolderImported`, `movieFileDeleted` and `downloadFailed`; Sonarr
 * showed `grabbed`, `downloadFolderImported` and `episodeFileDeleted`.
 * `episodeFileImported`/`movieFileImported`/renamed/ignored were never
 * observed live but are kept as defensive entries — the generated spec
 * types `eventType` as a bare string, so an older or newer build could still
 * send them.
 */
const EVENT: Record<string, HistoryEventType> = {
    grabbed: 'grabbed',
    downloadFolderImported: 'imported',
    episodeFileImported: 'imported',
    movieFileImported: 'imported',
    downloadFailed: 'failed',
    movieFileDeleted: 'deleted',
    episodeFileDeleted: 'deleted',
    episodeFileRenamed: 'renamed',
    movieFileRenamed: 'renamed',
    downloadIgnored: 'ignored'
};

type RawHistory = {
    id?: number;
    eventType?: string;
    date?: string;
    sourceTitle?: string;
    movieId?: number;
    seriesId?: number;
    episodeId?: number;
    quality?: { quality?: { name?: string } };
    data?: {
        // Present on `grabbed` and `downloadFailed` only.
        indexer?: string;
        indexerId?: number;
        guid?: string;
        // Present on `*Deleted` (observed value: "Upgrade"), not on failures.
        reason?: string;
        // The failure text on `downloadFailed`. Whatever locale the download
        // client runs in, and may contain a URL — fence it, never parse it.
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
 * `unknown` and `subtitle` have none and are filtered here instead.
 */
const EVENT_CODE: Record<'movie' | 'series', Partial<Record<HistoryEventType, number>>> = {
    movie: { grabbed: 1, imported: 3, failed: 4, deleted: 6, renamed: 8, ignored: 9 },
    series: { grabbed: 1, imported: 3, failed: 4, deleted: 5, renamed: 6, ignored: 7 }
};

/**
 * The newest rows first, filtered to `eventType` and `since`. With `want`, and
 * no `since`, it stops once it has that many and takes `total` from the
 * service (#293) rather than reading the whole history to count it.
 */
export async function readArrHistory(
    http: ServiceHttp,
    service: string,
    kind: 'movie' | 'series',
    opts: HistoryQuery
): Promise<Window<HistoryEntry>> {
    const code = opts.eventType === undefined ? undefined : EVENT_CODE[kind][opts.eventType];
    let pages = await readHistoryPages(http, service, kind, opts, code);
    // Radarr 4 filters history through `filterKey`/`filterValue` and ignores a
    // bare `eventType`, so a filter sent upstream is checked, not trusted.
    if (code !== undefined && pages.entries.some(e => e.event !== opts.eventType)) {
        pages = await readHistoryPages(http, service, kind, opts, undefined);
    }

    const items = opts.eventType === undefined ? pages.entries : pages.entries.filter(e => e.event === opts.eventType);
    return { items, total: pages.windowed ? readTotal(pages.read, items.length) : items.length };
}

async function readHistoryPages(
    http: ServiceHttp,
    service: string,
    kind: 'movie' | 'series',
    opts: HistoryQuery,
    code: number | undefined
): Promise<{ entries: HistoryEntry[]; read: ArrRead<unknown>; windowed: boolean }> {
    // Confirmed live: /api/v3/history/movie?movieId=<id> answers a bare
    // HistoryResource[], not the {records, totalRecords} envelope pageArr
    // expects, so a scoped read through it always looked empty. The paged
    // /api/v3/history endpoint takes the same movieIds/seriesIds filter and
    // answers the real envelope, so scoping happens there instead.
    const scoped = kind === 'movie' ? 'movieIds' : 'seriesIds';

    // Explicit, not assumed: the early exit below only works if the service
    // is actually sorted newest first, and a live capture showing that order
    // by default is not the same as asking for it.
    const sort = 'sortKey=date&sortDirection=descending';
    const query = [
        ...(opts.id === undefined ? [] : [`${scoped}=${encodeURIComponent(opts.id)}`]),
        ...(code === undefined ? [] : [`eventType=${code}`]),
        sort
    ].join('&');

    // A `since` read has to reach its boundary to count what is in range, so
    // only a read without one can stop at `want`. Nor can one whose filter
    // only happens here.
    const since = opts.since;
    const want = since === undefined && (opts.eventType === undefined || code !== undefined) ? opts.want : undefined;

    const read = await readArrPages<RawHistory>(http, '/api/v3/history', query, {
        ...(want === undefined ? {} : { pageSize: pageSizeFor(want) }),
        stopWhen: (page, kept) => {
            // Trust an early exit only when this page is actually newest-first,
            // as asked: a service that silently ignored the sort params (this
            // project has seen that happen) must not have paging cut short on
            // an assumption it broke.
            const dates = page.map(r => r.date);
            if (!dates.every((d, i) => d !== undefined && (i === 0 || (dates[i - 1] ?? '') >= d))) return false;
            const oldest = dates[dates.length - 1] ?? '';
            // Once a page's oldest record predates `since`, every later page
            // does too. A live Sonarr capture held 12,614 records.
            if (since !== undefined) return oldest < since;
            return want !== undefined && kept >= want;
        }
    });
    const fence = (value: string, field: string) => fenceText(value, { service, field });

    const entries = read.records
        .filter((r): r is RawHistory & { id: number } => typeof r.id === 'number')
        .map(r => {
            const raw = r.eventType ?? '';
            const mediaId = r.movieId ?? r.seriesId;
            const reason = r.data?.reason ?? r.data?.message;
            return {
                service,
                id: String(r.id),
                at: r.date ?? '',
                event: EVENT[raw] ?? 'unknown',
                rawEvent: raw,
                title: fence(r.sourceTitle ?? '', 'sourceTitle'),
                ...(mediaId === undefined ? {} : { mediaId: String(mediaId) }),
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
        // early — the page holding the boundary still has older records on
        // it, and this is what drops them.
        .filter(e => opts.since === undefined || e.at >= opts.since);

    return { entries, read, windowed: want !== undefined };
}
