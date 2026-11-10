import type { ArrKind } from '../core/resolver.ts';

/**
 * What Radarr, Sonarr and Lidarr rows share, read the same way wherever they
 * come from: the queue, history and the blocklist today, release search later.
 * Also Lidarr's "no date", which its wanted list and calendar both read.
 */

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
 * whose `/history` binds no `seriesIds` and silently answers every site's rows.
 */
export type ArrHistoryScope = 'ids' | 'seriesEndpoint';

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
