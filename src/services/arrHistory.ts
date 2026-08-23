import { fenceText } from '../core/fence.ts';
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
        releaseGroup?: string;
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
    // The scoped endpoint when an item was named, so a busy history does not
    // have to be paged through and filtered client-side.
    const scoped = kind === 'movie' ? 'movieId' : 'seriesId';
    const path = opts.id === undefined ? '/api/v3/history' : `/api/v3/history/${kind}`;
    const query = opts.id === undefined ? '' : `${scoped}=${encodeURIComponent(opts.id)}`;

    const records = await pageArr<RawHistory>(http, path, query);
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
                // verbatim, not prose reaching model context.
                ...(r.data?.guid === undefined ? {} : { guid: r.data.guid }),
                ...(r.data?.indexerId === undefined ? {} : { indexerId: r.data.indexerId })
            };
        })
        // Filtered here rather than upstream: neither service takes a date
        // range on this endpoint, and paging to completion has already
        // happened.
        .filter(e => opts.since === undefined || e.at >= opts.since);
}
