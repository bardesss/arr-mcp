import { fenceText, sanitizeGuid } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { pageArr } from './arrPaging.ts';
import type { HistoryEntry, HistoryEventType } from './types.ts';

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

export async function readArrHistory(
    http: ServiceHttp,
    service: string,
    kind: 'movie' | 'series',
    opts: { id?: string | undefined; since?: string | undefined }
): Promise<HistoryEntry[]> {
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
    const query = opts.id === undefined ? sort : `${scoped}=${encodeURIComponent(opts.id)}&${sort}`;

    // Once a page's oldest record predates `since`, every later page does
    // too — a live Sonarr capture held 12,614 records, and paging all of
    // them to answer "history since last week" is dozens of round-trips to
    // fetch and discard nearly everything. `since` is captured by value, not
    // read through `opts`, so this stays a pure predicate over one page.
    const since = opts.since;
    const stopWhen =
        since === undefined
            ? undefined
            : (page: RawHistory[]): boolean => {
                  const newest = page[0]?.date;
                  const oldest = page[page.length - 1]?.date;
                  // Trust the early exit only when this page is actually
                  // newest-first, as asked — a service that silently ignored
                  // the sort params (this project has seen that happen) must
                  // not have paging cut short on an assumption it broke.
                  if (newest === undefined || oldest === undefined || newest < oldest) return false;
                  return oldest < since;
              };

    const records = await pageArr<RawHistory>(http, '/api/v3/history', query, stopWhen);
    const fence = (value: string, field: string) => fenceText(value, { service, field });

    return records
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
}
