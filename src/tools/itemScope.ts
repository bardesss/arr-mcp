import { ServiceError } from '../core/errors.ts';
import { hasMediaDetails, type MediaDetailCapable, type MediaDetails, type ServiceAdapter } from '../services/types.ts';

/** How many episodes a write reads to check the ids it was given. */
export const EPISODE_LIMIT = 500;

/** A write reads the item first, so a bad id fails legibly and the preview names what it touches. */
export function describable<A extends ServiceAdapter>(adapter: A, service: string): A & MediaDetailCapable {
    if (!hasMediaDetails(adapter)) throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
    return adapter;
}

/** `whole` says what giving neither does, when the tool has a whole-item form. */
export function refuseBoth(season: number | undefined, episodes: readonly string[] | undefined, whole?: string): void {
    if (season !== undefined && episodes !== undefined) {
        throw new Error(`\`season\` and \`episodes\` were both given. They are different targets; send one.${whole === undefined ? '' : ` ${whole}`}`);
    }
}

/**
 * Refuses a season or episode id the item does not have. Sonarr accepts a
 * command or an edit matching nothing and reports success, so an unchecked id
 * is a write that silently does nothing. A season is checked only when the
 * service reported seasons: no list is no evidence.
 */
export function checkScope(
    details: Pick<MediaDetails, 'seasons' | 'episodes' | 'episodesTruncated'>,
    label: string,
    service: string,
    scope: { season?: number | undefined; episodes?: readonly string[] | undefined }
): void {
    const { season, episodes } = scope;
    if (season !== undefined && details.seasons !== undefined) {
        const known = details.seasons.map(s => s.season);
        if (!known.includes(season)) {
            throw new ServiceError('NotFound', service, `${label} has no season ${season}`, {
                remedy: `Seasons on this series: ${known.join(', ')}. Get them from get_media_details.`
            });
        }
    }
    if (episodes !== undefined) {
        const found = new Set((details.episodes ?? []).map(e => String(e.id)));
        const unresolved = episodes.filter(id => !found.has(id));
        if (unresolved.length > 0) {
            throw new ServiceError(
                'NotFound',
                service,
                `Could not find episode(s) ${unresolved.join(', ')} on ${label}` +
                    (details.episodesTruncated === true
                        ? `. The episode list was truncated at ${EPISODE_LIMIT}, so they may simply not have been fetched.`
                        : '.'),
                { remedy: 'Check the episode ids from get_media_details.' }
            );
        }
    }
}
