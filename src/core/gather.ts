import { logger } from './logger.ts';

export type Source<T> = { id: string; fetch: () => Promise<T[]> };

export type Gathered<T> = {
    items: T[];
    degraded: string[];
    /** Pre-truncation contribution per service. Absent means the source failed. */
    counts: Record<string, number>;
};

/**
 * Just the whole-service ids out of a degraded list, dropping the
 * source-scoped ones.
 *
 * A source id names either a whole service — `radarr`, or `radarr/4k` for a
 * second instance of one — or a single source *within* a service, written
 * `service:source`. `jellyfin:episodes` is the only one today: it contributes
 * per-season watch state and nothing else. The colon is the discriminator; a
 * slash deliberately is not, because a second instance is still a whole
 * service whose absence is worth reporting.
 *
 * For the consumers that reason about whether a *service's own view* of the
 * library was missed — diagnose's certainty, and get_media_details' hedge on a
 * title it could not find. Neither reads `seasons`, and the episode source can
 * only ever add seasons to items another source already returned, so its
 * failure is no reason for either to doubt itself. `get_library`, which does
 * return `seasons`, reports the unfiltered list: there the name is the answer.
 */
export const servicesOnly = (degraded: readonly string[]): string[] => degraded.filter(id => !id.includes(':'));

/**
 * cross-service tools degrade, they do not fail. A tool
 * spanning four services with one down returns three services' results plus
 * the name of the fourth — never an exception, and never a silently short list
 * that reads as "there is nothing in your queue".
 *
 * `counts` is measured before the caller truncates. The truncation contract
 * says how many items were dropped but not which service lost them, and merged
 * lists are limited after concatenation — so without this, a long list from one
 * service can push another out of the response entirely and the model has no
 * way to know. Zero and absent mean different things: zero is "asked, nothing
 * there", absent is "could not ask", and that service is also in `degraded`.
 *
 * Results follow source order rather than completion order, so responses are
 * stable across calls and diffable in tests.
 */
export async function gather<T>(sources: readonly Source<T>[]): Promise<Gathered<T>> {
    const settled = await Promise.allSettled(sources.map(s => s.fetch()));

    const items: T[] = [];
    const degraded: string[] = [];
    const counts: Record<string, number> = {};

    settled.forEach((result, index) => {
        const id = sources[index]?.id;
        if (id === undefined) return;
        if (result.status === 'fulfilled') {
            items.push(...result.value);
            counts[id] = result.value.length;
        } else {
            logger.warn({ service: id, err: result.reason }, 'source failed; degrading rather than failing');
            degraded.push(id);
        }
    });

    degraded.sort();
    return { items, degraded, counts };
}
