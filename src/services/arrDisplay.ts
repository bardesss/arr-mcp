import { artworkFromImages, compactDisplay, type Display, type RawImage } from '../core/display.ts';
import { fenceText } from '../core/fence.ts';

/** The fields of a Radarr movie or Sonarr series a poster card reads. */
type RawDisplayFields = {
    id?: number;
    overview?: string | null;
    /** Minutes. Radarr's `0` is "unknown". */
    runtime?: number | null;
    images?: RawImage[] | null;
    statistics?: { seasonCount?: number; episodeFileCount?: number; episodeCount?: number } | null;
    /** Sonarr's per-season statistics, which `episodesOf` prefers. */
    seasons?: { statistics?: { episodeFileCount?: number; episodeCount?: number } | null }[] | null;
};

/**
 * Episodes on disk against episodes wanted, never more of the first.
 *
 * Sonarr's `episodeCount` counts the monitored episodes that have aired, while
 * `episodeFileCount` counts every file, so a series with an unmonitored season
 * on disk reads "12 / 10". Season by season, a season contributes at most what
 * it wants, so an unmonitored season's files cannot hide a gap in a monitored
 * one; without seasons, the series total is capped the same way.
 */
export function episodesOf(raw: Pick<RawDisplayFields, 'statistics' | 'seasons'>): { onDisk: number; aired: number } | undefined {
    const rows = (raw.seasons ?? []).flatMap(s => {
        const stats = s.statistics;
        return typeof stats?.episodeFileCount === 'number' && typeof stats.episodeCount === 'number'
            ? [{ onDisk: stats.episodeFileCount, aired: stats.episodeCount }]
            : [];
    });
    if (rows.length > 0) {
        return rows.reduce(
            (sum, row) => ({ onDisk: sum.onDisk + Math.min(row.onDisk, row.aired), aired: sum.aired + row.aired }),
            { onDisk: 0, aired: 0 }
        );
    }
    const stats = raw.statistics;
    if (typeof stats?.episodeFileCount !== 'number' || typeof stats.episodeCount !== 'number') return undefined;
    return { onDisk: Math.min(stats.episodeFileCount, stats.episodeCount), aired: stats.episodeCount };
}

/**
 * Radarr's and Sonarr's card fields, read the same way.
 *
 * `lookup` marks a `/lookup` record, where a positive `id` is the one fact
 * that says the title is already managed; on a library record it always is.
 */
export function arrDisplay(raw: RawDisplayFields, service: string, kind: 'movie' | 'series', opts: { lookup?: boolean } = {}): Display | undefined {
    const stats = raw.statistics ?? undefined;
    const episodes = kind === 'series' ? episodesOf(raw) : undefined;
    return compactDisplay({
        ...artworkFromImages(raw.images),
        ...(typeof raw.overview === 'string' && raw.overview !== ''
            ? { overview: fenceText(raw.overview, { service, field: 'overview' }) }
            : {}),
        ...(kind === 'movie' && typeof raw.runtime === 'number' && raw.runtime > 0 ? { runtimeMinutes: raw.runtime } : {}),
        ...(kind === 'series' && typeof stats?.seasonCount === 'number' ? { seasonCount: stats.seasonCount } : {}),
        ...(episodes === undefined ? {} : { episodes }),
        ...(opts.lookup === true ? { inLibrary: raw.id !== undefined && raw.id > 0 } : {})
    });
}
