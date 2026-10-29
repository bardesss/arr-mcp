import { ServiceError } from '../core/errors.ts';
import { fencer } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { ArrHistoryScope } from './arrRecord.ts';
import type { DownloadTrace } from './types.ts';

type RawTraceRecord = {
    eventType?: string;
    date?: string;
    sourceTitle?: string;
    downloadId?: string;
    movieId?: number;
    seriesId?: number;
    episodeId?: number;
};

type Page = { records?: RawTraceRecord[] };

const PAGE = 'page=1&pageSize=50&sortKey=date&sortDirection=descending';
// The `eventType` filter value for a grab, the same in Radarr, Sonarr, Whisparr and Lidarr.
const GRABBED_CODE = 1;

const time = (date: string | undefined): number => (date === undefined ? Number.NaN : Date.parse(date));

/**
 * What a Radarr or Sonarr did with one download id: whether it marked the
 * download failed, and whether it then grabbed (and imported) a replacement
 * for the same media. Each read is one page of the newest 50 records, except
 * Whisparr's replacement read, which takes the whole item history: a
 * replacement worth warning about is recent, and the preview should not wait
 * on paging through years of history for one film or series.
 *
 * Every server-side filter is checked again here (the download id, the
 * media id), so a build that ignores one gives no false warning.
 */
export async function traceArrDownload(
    http: ServiceHttp,
    service: string,
    kind: 'movie' | 'series',
    downloadId: string,
    scope: ArrHistoryScope = 'ids'
): Promise<DownloadTrace | undefined> {
    const fence = fencer(service);
    const read = async (query: string): Promise<RawTraceRecord[]> =>
        (await http.get<Page>(`${http.apiRoot}/history?${query}&${PAGE}`)).records ?? [];

    // The service matches `downloadId` loosely on some builds; keep only exact
    // ones. A record with no id at all is not evidence this download exists.
    const own = (await read(`downloadId=${encodeURIComponent(downloadId)}`)).filter(r => r.downloadId === downloadId);
    if (own.length === 0) return undefined;

    const grab = own.find(r => r.eventType === 'grabbed') ?? own[0];
    const title = fence(grab?.sourceTitle ?? '', 'sourceTitle');
    const failed = own.find(r => r.eventType === 'downloadFailed');
    if (failed === undefined) return { service, title };

    const failedAt = failed.date;
    const trace: DownloadTrace = {
        service,
        title,
        ...(failedAt === undefined ? {} : { failedAt })
    };
    const failedTime = time(failedAt);

    const mediaOf = (r: RawTraceRecord) => (kind === 'movie' ? r.movieId : r.seriesId);
    const mediaId = mediaOf(failed) ?? own.map(mediaOf).find(id => id !== undefined);
    if (mediaId === undefined || Number.isNaN(failedTime)) return trace;

    const episodes = new Set(own.map(r => r.episodeId).filter((id): id is number => id !== undefined));
    const scoped = kind === 'movie' ? 'movieIds' : 'seriesIds';
    // Whisparr's `/history` binds no `seriesIds`; its per-series endpoint is a
    // bare, unpaged array, so the grab filter is the local one below.
    const grabs =
        scope === 'seriesEndpoint'
            ? await http.get<RawTraceRecord[]>(`${http.apiRoot}/history/series?seriesId=${mediaId}`)
            : await read(`${scoped}=${mediaId}&eventType=${GRABBED_CODE}`);
    const later = (Array.isArray(grabs) ? grabs : [])
        .filter(
            r =>
                r.eventType === 'grabbed' &&
                r.downloadId !== undefined &&
                r.downloadId !== downloadId &&
                mediaOf(r) === mediaId &&
                time(r.date) > failedTime &&
                (kind === 'movie' || episodes.size === 0 || (r.episodeId !== undefined && episodes.has(r.episodeId)))
        )
        .sort((a, b) => time(b.date) - time(a.date));

    // Several records can share a download id (a season pack); the newest is enough.
    const next = later[0];
    if (next?.downloadId === undefined || next.date === undefined) return trace;

    const imported = (await read(`downloadId=${encodeURIComponent(next.downloadId)}`)).some(
        r => r.eventType === 'downloadFolderImported' && r.downloadId === next.downloadId
    );
    return {
        ...trace,
        replacement: {
            title: fence(next.sourceTitle ?? '', 'sourceTitle'),
            grabbedAt: next.date,
            imported
        }
    };
}

/**
 * Whether the service has a `grabbed` record for this download id: what
 * `FailedDownloadService.MarkAsFailed` looks up (`Find(downloadId, Grabbed)`)
 * before it blocklists a download, in Radarr 6.4.4, Sonarr 4.0.20, Whisparr
 * 2.2.0 and Lidarr 3.1.6 alike. One request, filtered by the service on both
 * the id and the event (Radarr 4.0 reads the two as `key=value` filters), and
 * both checked again here. A row for another download means the filter was not
 * applied, so the newest page says nothing about this one: that is refused
 * rather than read as no record. Sonarr's and Whisparr's history list also
 * joins the episode, which `Find` does not, so a grab whose episode was deleted
 * reads as none until housekeeping drops it.
 */
export async function arrGrabRecorded(http: ServiceHttp, service: string, downloadId: string): Promise<boolean> {
    const page = await http.get<{ records?: (RawTraceRecord | null)[] }>(
        `${http.apiRoot}/history?downloadId=${encodeURIComponent(downloadId)}&eventType=${GRABBED_CODE}&${PAGE}`
    );
    const records = (page.records ?? []).filter((r): r is RawTraceRecord => r !== null);
    if (records.some(r => r.downloadId !== downloadId)) {
        throw new ServiceError('UpstreamError', service, `its history was not filtered to download ${downloadId}, so whether that grab is recorded is unknown`, {
            remedy: 'Leave out blocklist to remove it without one.'
        });
    }
    return records.some(r => r.eventType === 'grabbed');
}
