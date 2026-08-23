import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { pageArr } from './arrPaging.ts';
import type { WantedItem, WantedScope } from './types.ts';

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
 */
export async function readArrWanted(
    http: ServiceHttp,
    service: string,
    kind: 'movie' | 'series',
    scope: WantedScope
): Promise<WantedItem[]> {
    const path = scope === 'missing' ? '/api/v3/wanted/missing' : '/api/v3/wanted/cutoff';
    const fence = (value: string, field: string) => fenceText(value, { service, field });

    if (kind === 'movie') {
        const records = await pageArr<RawWantedMovie>(http, path);
        return records
            .filter((r): r is RawWantedMovie & { id: number } => typeof r.id === 'number')
            .map(r => ({
                service,
                kind: 'movie' as const,
                id: String(r.id),
                title: fence(r.title ?? '', 'title'),
                monitored: r.monitored ?? false
            }));
    }

    const records = await pageArr<RawWantedEpisode>(http, path, 'includeSeries=true');
    return records
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
}
