import { fenceText } from '../core/fence.ts';
import type { SeasonSummary } from '../core/resolver.ts';
import type { SearchHit, SearchSource } from './types.ts';

/** The fields of a Sonarr or Whisparr series that a search hit reads. */
type SeriesLike = {
    id?: number;
    tvdbId?: number;
    imdbId?: string;
    title?: string;
    year?: number;
    monitored?: boolean;
};

/** The fields of a series' season row that a summary reads. */
type SeasonLike = {
    seasonNumber?: number;
    monitored?: boolean;
    statistics?: { episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number };
};

export function seriesHit(service: string, s: SeriesLike, source: SearchSource): SearchHit {
    return {
        service,
        source,
        kind: 'series',
        // `??` alone would keep a zero: a lookup omits `id` for something
        // not in the library, but a build that sends 0 instead must not
        // produce the id "0". Matches arrAdd's own `> 0` guard.
        id: String((s.id !== undefined && s.id > 0 ? s.id : undefined) ?? s.tvdbId ?? ''),
        title: fenceText(s.title ?? '', { service, field: 'title' }),
        ...(s.year === undefined ? {} : { year: s.year }),
        ids: {
            ...(s.tvdbId === undefined ? {} : { tvdb: s.tvdbId }),
            ...(s.imdbId === undefined ? {} : { imdb: s.imdbId })
        },
        ...(s.monitored === undefined ? {} : { monitored: s.monitored })
    };
}

/**
 * The season half that Sonarr and Whisparr share: the three denominators and
 * the monitoring flag, no watch state. Sorted by season number so responses are
 * stable across calls and diffable in tests — the service's own order is not
 * guaranteed.
 *
 * `monitored` is carried here as well as on `get_media_details` so that
 * `seasons[].monitored` means one thing on both forms `get_media_details` can
 * return.
 *
 * `monitored` is omitted when the service did not report it, never defaulted
 * to `false` — see `SeasonSummary`.
 */
export function seasonsOf(raw: { seasons?: SeasonLike[] }): SeasonSummary[] | undefined {
    if (raw.seasons === undefined) return undefined;
    const rows = raw.seasons
        .filter((s): s is typeof s & { seasonNumber: number } => typeof s.seasonNumber === 'number')
        .map(s => ({
            season: s.seasonNumber,
            ...(s.monitored === undefined ? {} : { monitored: s.monitored }),
            ...(s.statistics?.episodeFileCount === undefined ? {} : { onDisk: s.statistics.episodeFileCount }),
            ...(s.statistics?.episodeCount === undefined ? {} : { aired: s.statistics.episodeCount }),
            ...(s.statistics?.totalEpisodeCount === undefined ? {} : { total: s.statistics.totalEpisodeCount })
        }))
        .sort((a, b) => a.season - b.season);
    return rows.length === 0 ? undefined : rows;
}
