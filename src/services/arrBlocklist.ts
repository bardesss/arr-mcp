import { fencer } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { ArrKind } from '../core/resolver.ts';
import { pageIsNewestFirst, pageSizeFor, readArrPages, readTotal } from './arrPaging.ts';
import { mediaIdOf, protocolName } from './arrRecord.ts';
import type { BlocklistEntry, Window } from './types.ts';

type RawBlocklist = {
    id?: number;
    /** Radarr only. */
    movieId?: number;
    /** Sonarr only; `episodeIds` is the episode-level detail this does not carry. */
    seriesId?: number;
    /** Lidarr only; `albumIds` is the album-level detail this does not carry. */
    artistId?: number;
    sourceTitle?: string;
    date?: string;
    protocol?: string;
    indexer?: string;
    /** Why the *arr gave up on it — usually the download client's own words. */
    message?: string;
};

const SORT = 'sortKey=date&sortDirection=descending';

const toBlocklistEntry = (r: RawBlocklist & { id: number }, service: string, kind: ArrKind, fence: ReturnType<typeof fencer>): BlocklistEntry => {
    const mediaId = mediaIdOf(r, kind);
    return {
        service,
        id: String(r.id),
        title: fence(r.sourceTitle ?? '', 'sourceTitle'),
        at: r.date ?? '',
        ...(r.indexer === undefined ? {} : { indexer: fence(r.indexer, 'indexer') }),
        ...(r.message === undefined ? {} : { reason: fence(r.message, 'message') }),
        ...(r.protocol === undefined ? {} : { protocol: protocolName(r.protocol) }),
        ...(mediaId === undefined ? {} : { mediaId: String(mediaId) })
    };
};

const hasId = (r: RawBlocklist): r is RawBlocklist & { id: number } => typeof r.id === 'number';

/**
 * What Radarr, Sonarr, Whisparr and Lidarr refuse to grab again, and why.
 *
 * The question this answers is "why does this release keep getting skipped".
 * All four expose the same paged shape; only the id of the thing it belongs
 * to differs, which is the one thing normalised here.
 *
 * Read newest first. With `want`, paging stops once that many rows are kept,
 * but only while the pages really come back newest first.
 */
export async function readArrBlocklist(
    http: ServiceHttp,
    service: string,
    kind: ArrKind,
    want?: number
): Promise<Window<BlocklistEntry>> {
    const paging =
        want === undefined
            ? {}
            : {
                  pageSize: pageSizeFor(want),
                  stopWhen: (page: RawBlocklist[], kept: number) => pageIsNewestFirst(page) && kept >= want
              };
    const read = await readArrPages<RawBlocklist>(http, `${http.apiRoot}/blocklist`, SORT, paging);
    const fence = fencer(service);
    const items = read.records.filter(hasId).map(r => toBlocklistEntry(r, service, kind, fence));

    return { items, total: readTotal(read, items.length) };
}

/** One entry by id. Reads newest first and stops at the page that holds it. */
export async function findArrBlocklistEntry(
    http: ServiceHttp,
    service: string,
    kind: ArrKind,
    id: string
): Promise<BlocklistEntry | undefined> {
    const read = await readArrPages<RawBlocklist>(http, `${http.apiRoot}/blocklist`, SORT, {
        stopWhen: page => page.some(r => String(r.id) === id)
    });
    const row = read.records.filter(hasId).find(r => String(r.id) === id);

    return row === undefined ? undefined : toBlocklistEntry(row, service, kind, fencer(service));
}

/**
 * `DELETE /api/v3/blocklist/{id}` answers success for an id that does not
 * exist — probed live against both services — so a caller acting on a stale id
 * would be told the release was un-blocklisted when nothing happened. The
 * existence check is the tool's, in `plan`, for the same reason
 * `remove_queue_item`'s is.
 */
export async function removeArrBlocklistItem(http: ServiceHttp, id: string): Promise<void> {
    await http.delete(`${http.apiRoot}/blocklist/${encodeURIComponent(id)}`);
}
