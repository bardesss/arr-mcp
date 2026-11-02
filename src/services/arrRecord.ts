import type { LibraryKind } from '../core/resolver.ts';

/**
 * What Radarr, Sonarr and Lidarr rows share, read the same way wherever they
 * come from: the queue, history and the blocklist today, release search later.
 */

/** The field naming a row's media, one per kind of library. */
export const MEDIA_ID_FIELD = {
    movie: 'movieId',
    series: 'seriesId',
    artist: 'artistId'
} as const satisfies Record<LibraryKind, string>;

type MediaIdField = (typeof MEDIA_ID_FIELD)[LibraryKind];

/**
 * The row's media id, or `undefined` when it has none. `null` reads as none
 * too: the generated spec types these ids as `number | null`, so a build that
 * serialises the null instead of omitting the key must read the same.
 */
export const mediaIdOf = (record: Partial<Record<MediaIdField, number | null>>, kind: LibraryKind): number | undefined =>
    record[MEDIA_ID_FIELD[kind]] ?? undefined;

/** The filter for one item's rows: `movieIds`, `seriesIds` or `artistIds`. */
export const mediaIdsParam = (kind: LibraryKind): string => `${MEDIA_ID_FIELD[kind]}s`;

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
