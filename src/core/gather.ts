import type { ServiceId } from '../config/schema.ts';
import { logger } from './logger.ts';

export type Source<T> = { id: ServiceId; fetch: () => Promise<T[]> };

export type Gathered<T> = {
    items: T[];
    degraded: ServiceId[];
    /** Pre-truncation contribution per service. Absent means the source failed. */
    counts: Partial<Record<ServiceId, number>>;
};

/**
 * Design spec §15: cross-service tools degrade, they do not fail. A tool
 * spanning four services with one down returns three services' results plus
 * the name of the fourth — never an exception, and never a silently short list
 * that reads as "there is nothing in your queue".
 *
 * `counts` is measured before the caller truncates. §12's truncation contract
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
    const degraded: ServiceId[] = [];
    const counts: Partial<Record<ServiceId, number>> = {};

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
