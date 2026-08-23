import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { pageArr } from './arrPaging.ts';
import type { BlocklistEntry } from './types.ts';

type RawBlocklist = {
    id?: number;
    /** Radarr only. */
    movieId?: number;
    /** Sonarr only; `episodeIds` is the episode-level detail this does not carry. */
    seriesId?: number;
    sourceTitle?: string;
    date?: string;
    protocol?: string;
    indexer?: string;
    /** Why the *arr gave up on it — usually the download client's own words. */
    message?: string;
};

/**
 * What Radarr and Sonarr refuse to grab again, and why.
 *
 * The question this answers is "why does this release keep getting skipped".
 * Both services expose the same paged shape; only the id of the thing it
 * belongs to differs, which is the one thing normalised here.
 */
export async function readArrBlocklist(
    http: ServiceHttp,
    service: string,
    kind: 'movie' | 'series'
): Promise<BlocklistEntry[]> {
    const records = await pageArr<RawBlocklist>(http, '/api/v3/blocklist');
    const fence = (value: string, field: string) => fenceText(value, { service, field });

    return records
        .filter((r): r is RawBlocklist & { id: number } => typeof r.id === 'number')
        .map(r => {
            const mediaId = kind === 'movie' ? r.movieId : r.seriesId;
            return {
                service,
                id: String(r.id),
                title: fence(r.sourceTitle ?? '', 'sourceTitle'),
                at: r.date ?? '',
                ...(r.indexer === undefined ? {} : { indexer: fence(r.indexer, 'indexer') }),
                ...(r.message === undefined ? {} : { reason: fence(r.message, 'message') }),
                ...(r.protocol === undefined ? {} : { protocol: r.protocol }),
                ...(mediaId === undefined ? {} : { mediaId: String(mediaId) })
            };
        });
}

/**
 * `DELETE /api/v3/blocklist/{id}` answers success for an id that does not
 * exist — probed live against both services — so a caller acting on a stale id
 * would be told the release was un-blocklisted when nothing happened. The
 * existence check is the tool's, in `plan`, for the same reason
 * `remove_queue_item`'s is.
 */
export async function removeArrBlocklistItem(http: ServiceHttp, id: string): Promise<void> {
    await http.delete(`/api/v3/blocklist/${encodeURIComponent(id)}`);
}
