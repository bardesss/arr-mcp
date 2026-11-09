import { fencer } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { LibraryKind } from '../core/resolver.ts';
import { pageSizeFor, readArrPages, readTotal } from './arrPaging.ts';
import { lidarrDate } from './arrRecord.ts';
import type { WantedItem, WantedScope, Window } from './types.ts';

type RawWantedMovie = {
    id?: number;
    title?: string;
    monitored?: boolean;
};

type RawWantedEpisode = {
    id?: number; // the episode, not the series — see below
    seriesId?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    title?: string; // the episode's own title
    airDateUtc?: string;
    monitored?: boolean;
    /** Present only with `includeSeries=true`. */
    series?: { title?: string };
};

type RawWantedAlbum = {
    id?: number; // the album, not the artist — the same trap as Sonarr's episode
    artistId?: number;
    title?: string; // the album's own title
    releaseDate?: string | null;
    monitored?: boolean;
    /** Asked for with `includeArtist=true`; see `readArrWanted`. */
    artist?: { artistName?: string };
};

/**
 * Radarr's `/api/v3/wanted/*` rows are full movie objects and `id` already
 * names the movie. Sonarr's are episode objects: `id` is the *episode*, and
 * the series id — the one `trigger_search` and `get_media_details` actually
 * take — is only in `seriesId`. Handing back the episode id would be a write
 * against the wrong thing.
 *
 * `includeSeries=true` is required to get the show's own name at all:
 * without it, `title` is the episode's title alone, which does not say which
 * series it belongs to. Confirmed against a live capture: absent, present and
 * an invented query param all produce a distinguishable response, so this is
 * not a parameter Sonarr silently ignores.
 *
 * Sonarr's `missing` list defaults to monitored-only — an unmonitored
 * episode is not "wanted" — so no `monitored` parameter is added here; that
 * default is called out in the tool description instead.
 *
 * With `want`, it stops once it has that many rows and takes `total` from the
 * service (#293). The series is embedded in every episode row, so a cutoff
 * list read to the end ran to 100 MB.
 *
 * Lidarr's are album objects, so it has Sonarr's trap one level up: `id` is
 * the album, and the artist, which `get_media_details` and `set_monitoring`'s
 * `artists` take, is in `artistId`. The row names the artist and carries the
 * album as `albumId` and `albumTitle`. Both lists are monitored-only by
 * default, as Sonarr's missing list is.
 *
 * Lidarr embeds the artist on every album row even without `includeArtist`:
 * `AlbumResourceMapper` sets it from the album's lazily loaded artist, and a
 * live 2.1.3.3927 answered with it either way, as the committed 3.1.6
 * capture (taken without the flag) does. The flag is still sent, because it
 * is the documented way to ask for the artist, and the row must not depend on
 * an implementation detail to say whose album it is.
 */
export async function readArrWanted(
    http: ServiceHttp,
    service: string,
    kind: LibraryKind,
    scope: WantedScope,
    want?: number
): Promise<Window<WantedItem>> {
    const path = scope === 'missing' ? `${http.apiRoot}/wanted/missing` : `${http.apiRoot}/wanted/cutoff`;
    const fence = fencer(service);
    const paging =
        want === undefined ? {} : { pageSize: pageSizeFor(want), stopWhen: (_page: unknown[], kept: number) => kept >= want };

    if (kind === 'movie') {
        const read = await readArrPages<RawWantedMovie>(http, path, undefined, paging);
        const items = read.records
            .filter((r): r is RawWantedMovie & { id: number } => typeof r.id === 'number')
            .map(r => ({
                service,
                kind: 'movie' as const,
                id: String(r.id),
                title: fence(r.title ?? '', 'title'),
                monitored: r.monitored ?? false
            }));
        return { items, total: readTotal(read, items.length) };
    }

    if (kind === 'artist') {
        const read = await readArrPages<RawWantedAlbum>(http, path, 'includeArtist=true', paging);
        const items = read.records
            .filter((r): r is RawWantedAlbum & { id: number; artistId: number } =>
                typeof r.id === 'number' && typeof r.artistId === 'number'
            )
            .map(r => {
                const released = lidarrDate(r.releaseDate);
                return {
                    service,
                    kind: 'artist' as const,
                    id: String(r.artistId),
                    title: fence(r.artist?.artistName ?? '', 'artist.artistName'),
                    albumId: String(r.id),
                    ...(r.title === undefined ? {} : { albumTitle: fence(r.title, 'album.title') }),
                    ...(released === undefined ? {} : { airDate: released }),
                    monitored: r.monitored ?? false
                };
            });
        return { items, total: readTotal(read, items.length) };
    }

    const read = await readArrPages<RawWantedEpisode>(http, path, 'includeSeries=true', paging);
    const items = read.records
        .filter((r): r is RawWantedEpisode & { seriesId: number } => typeof r.seriesId === 'number')
        .map(r => ({
            service,
            kind: 'series' as const,
            id: String(r.seriesId),
            title: fence(r.series?.title ?? '', 'series.title'),
            ...(r.seasonNumber === undefined ? {} : { season: r.seasonNumber }),
            ...(r.episodeNumber === undefined ? {} : { episode: r.episodeNumber }),
            ...(r.title === undefined ? {} : { episodeTitle: fence(r.title, 'episode.title') }),
            ...(r.airDateUtc === undefined ? {} : { airDate: r.airDateUtc }),
            monitored: r.monitored ?? false
        }));
    return { items, total: readTotal(read, items.length) };
}
