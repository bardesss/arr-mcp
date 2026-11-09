import { artworkFromImages, compactDisplay, type Display, type RawImage } from '../core/display.ts';
import { fenceText } from '../core/fence.ts';

/** The fields of a Radarr movie or Sonarr series a poster card reads. */
export type RawDisplayFields = {
    id?: number;
    overview?: string | null;
    /** Minutes. Radarr's `0` is "unknown". */
    runtime?: number | null;
    images?: RawImage[] | null;
    statistics?: { seasonCount?: number; episodeFileCount?: number; episodeCount?: number } | null;
};

/**
 * Radarr's and Sonarr's card fields, read the same way.
 *
 * `lookup` marks a `/lookup` record, where a positive `id` is the one fact
 * that says the title is already managed; on a library record it always is.
 */
export function arrDisplay(raw: RawDisplayFields, service: string, kind: 'movie' | 'series', opts: { lookup?: boolean } = {}): Display | undefined {
    const stats = raw.statistics ?? undefined;
    return compactDisplay({
        ...artworkFromImages(raw.images),
        ...(typeof raw.overview === 'string' && raw.overview !== ''
            ? { overview: fenceText(raw.overview, { service, field: 'overview' }) }
            : {}),
        ...(kind === 'movie' && typeof raw.runtime === 'number' && raw.runtime > 0 ? { runtimeMinutes: raw.runtime } : {}),
        ...(kind === 'series' && typeof stats?.seasonCount === 'number' ? { seasonCount: stats.seasonCount } : {}),
        ...(kind === 'series' && typeof stats?.episodeFileCount === 'number' && typeof stats.episodeCount === 'number'
            ? { episodes: { onDisk: stats.episodeFileCount, aired: stats.episodeCount } }
            : {}),
        ...(opts.lookup === true ? { inLibrary: raw.id !== undefined && raw.id > 0 } : {})
    });
}
