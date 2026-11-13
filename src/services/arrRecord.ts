import type { ArrKind } from '../core/resolver.ts';
import type { QueueItem } from './types.ts';

/**
 * What Radarr, Sonarr and Lidarr rows share, read the same way wherever they
 * come from: the queue, history and the blocklist. Also Lidarr's "no date",
 * which its wanted list, calendar and album years read, and what a finished
 * usenet row with a warning needs to run again, which diagnose_media and
 * import_download both say.
 */

/**
 * The *arrs' queue statuses, lowercased, for a release they hold and have sent
 * to no download client (`PendingReleaseReason`). The queue lists no `fallback`
 * release (`GetPendingQueue` reads `WithoutFallback`); a row that did carry it
 * would still be one held.
 */
export const PENDING_STATUSES: ReadonlySet<string> = new Set(['delay', 'downloadclientunavailable', 'fallback']);

/** A Lidarr queue row, from the bare instance or a named one. */
export const isLidarrRow = (row: QueueItem): boolean => row.service === 'lidarr' || row.service.startsWith('lidarr/');

/** A SABnzbd job id (`get_new_id`, a `mkstemp` name), which the *arrs take unchanged (`Sabnzbd`). */
const SABNZBD_ID = /^SABnzbd_nzo_[A-Za-z0-9_]+$/;
/** The `drone` id an *arr gives an NZB it sends NZBGet: a GUID without its dashes (`NzbgetProxy`). */
const NZBGET_DRONE_ID = /^[0-9a-f]{32}$/;

/**
 * How to run a finished usenet download again once its client has filed it in
 * its history with a problem: the *arrs read that as a warning with nothing
 * left, and import none of it while it stands. The *arr's own id says which
 * client it is. On SABnzbd it is only an unpack that failed for a write error
 * or a full disk (`Sabnzbd`), and retry_download takes the id as it stands. On
 * NZBGet it is an unpack out of space, a failed move, a duplicate NZBGet
 * skipped for a copy already in its history (`GOOD`) or, on Lidarr, which
 * leaves `BAD` out of its failed delete statuses, a download a script marked
 * bad (`Nzbget`). Only the *arr's message tells those apart, and `message` says
 * where it is. NZBGet's retry_download wants its own history id, which the
 * *arr's row does not carry, so this names import_download's `postprocess`,
 * which takes the *arr's. The id says which client, not which instance, so the
 * text says to make the call on the one that holds it rather than guessing one.
 * Another client, or an id of neither shape (an NZB added to NZBGet by hand has
 * its own number), is only told to fix what it reports or remove the row, so a
 * download id goes into the text only once its whole shape is known.
 */
export function usenetRerun(row: QueueItem, message: string): string {
    const id = row.downloadId ?? '';
    if (SABNZBD_ID.test(id)) {
        return `SABnzbd could not unpack it (a write error or a full disk): fix that, then retry it in SABnzbd, or with retry_download and \`id\` "${id}" on the SABnzbd that holds it.`;
    }
    if (!NZBGET_DRONE_ID.test(id)) {
        return `Fix what the client reports, or, if the client deleted the download, remove it from ${row.service}’s queue with remove_queue_item and \`id\` "${row.id}".`;
    }
    const lidarr = isLidarrRow(row);
    return `On NZBGet, fix the cause (free disk space, for one), then run its post-processing again there, or with import_download, \`action: "postprocess"\` and \`download_id\` "${id}", on the NZBGet that holds it. If NZBGet deleted it as a duplicate${lidarr ? ' or as bad' : ''}, remove it from ${row.service}’s queue with remove_queue_item and \`id\` "${row.id}"${lidarr ? ', with `blocklist: true` if it was bad' : ''}. ${message} says which.`;
}

/** The field naming a row's media, one per kind of library. */
export const MEDIA_ID_FIELD = {
    movie: 'movieId',
    series: 'seriesId',
    artist: 'artistId'
} as const satisfies Record<ArrKind, string>;

type MediaIdField = (typeof MEDIA_ID_FIELD)[ArrKind];

/**
 * The row's media id, or `undefined` when it has none. `null` reads as none
 * too: the generated spec types these ids as `number | null`, so a build that
 * serialises the null instead of omitting the key must read the same.
 */
export const mediaIdOf = (record: Partial<Record<MediaIdField, number | null>>, kind: ArrKind): number | undefined =>
    record[MEDIA_ID_FIELD[kind]] ?? undefined;

/** The filter for one item's rows: `movieIds`, `seriesIds` or `artistIds`. */
export const mediaIdsParam = (kind: ArrKind): string => `${MEDIA_ID_FIELD[kind]}s`;

/**
 * How one item's history is asked for: `ids` sends that filter to `/history`;
 * `seriesEndpoint` reads `/history/series?seriesId=` instead, for Whisparr,
 * whose `/history` binds no `seriesIds` and silently answers every site's rows;
 * `local` filters here, for a Radarr older than 5.2, which drops `movieIds`.
 */
export type ArrHistoryScope = 'ids' | 'seriesEndpoint' | 'local';

/**
 * Lidarr 3.1.6 names the protocol by its class, `UsenetDownloadProtocol` or
 * `TorrentDownloadProtocol`, where Lidarr 3.1.0, Radarr and Sonarr say
 * `usenet` or `torrent`. Mapped back, so a row reads the same whichever of them
 * sent it. Any other value passes through as sent.
 */
const PROTOCOL_NAMES: Readonly<Record<string, string>> = {
    UsenetDownloadProtocol: 'usenet',
    TorrentDownloadProtocol: 'torrent'
};

export const protocolName = (protocol: string): string => PROTOCOL_NAMES[protocol] ?? protocol;

/**
 * Lidarr's "no date" is `0001-01-01T00:00:00Z`, .NET's `DateTime.MinValue`,
 * not a missing field. Passing it on would date an album to year one.
 */
export const lidarrDate = (value: string | null | undefined): string | undefined =>
    typeof value === 'string' && value !== '' && !value.startsWith('0001-') ? value : undefined;
