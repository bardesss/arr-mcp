import { logger } from '../core/logger.ts';
import { hasCleanup, type CleanupCandidate, type CleanupRemoval, type CleanupStatus, type ServiceAdapter } from '../services/types.ts';

/**
 * One title's standing with the cleanup service: what its rules matched, what
 * protects it and what they already removed. `null` when no cleanup service is
 * configured or the title has no TMDB id to look it up by, `undefined` when it
 * could not be read.
 */
export async function readCleanupStatus(
    adapters: readonly ServiceAdapter[],
    kind: string,
    tmdb: number | undefined
): Promise<CleanupStatus | null | undefined> {
    const adapter = adapters.find(hasCleanup);
    if (adapter === undefined || tmdb === undefined || (kind !== 'movie' && kind !== 'series')) return null;
    try {
        return await adapter.readCleanupStatus(kind, tmdb);
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'cleanup status read failed');
        return undefined;
    }
}

/** Adds `cleanup` to a media record when there is anything to say. Never throws: it is the extra, not the answer. */
export async function withCleanup<T extends { kind: string; ids: { tmdb?: number } }>(
    adapters: readonly ServiceAdapter[],
    record: T
): Promise<T | (T & { cleanup: CleanupStatus })> {
    const status = await readCleanupStatus(adapters, record.kind, record.ids.tmdb);
    if (status === null || status === undefined) return record;
    if (status.candidates.length === 0 && status.protections.length === 0 && status.removals.length === 0) return record;
    return { ...record, cleanup: status };
}

const day = (iso: string | undefined): string => (iso === undefined ? '' : iso.slice(0, 10));
const ruled = (rules: string[]): string => (rules.length === 0 ? '' : ` under rule ${rules.join(', ')}`);
const part = (c: { scope: string; seasonNumber?: number; episodeNumber?: number }): string =>
    c.scope === 'season' && c.seasonNumber !== undefined
        ? `season ${c.seasonNumber} `
        : c.scope === 'episode' && c.seasonNumber !== undefined && c.episodeNumber !== undefined
          ? `S${String(c.seasonNumber).padStart(2, '0')}E${String(c.episodeNumber).padStart(2, '0')} `
          : '';

/** "Reclaimerr deleted it on 2026-11-02 under rule X." */
export function removalSentence(service: string, r: CleanupRemoval): string {
    const verb = r.operation === 'move' ? 'moved' : 'deleted';
    const what = part(r);
    return `${service} ${verb} ${what === '' ? 'it' : `${what}of it`} on ${day(r.at)}${ruled(r.rules)}.`;
}

/** The candidate that will act soonest, as a sentence; undefined when none is set to go. */
export function upcomingSentence(service: string, candidates: readonly CleanupCandidate[]): string | undefined {
    const next = candidates.find(c => c.state === 'eligible' || c.state === 'scheduled');
    if (next === undefined) return undefined;
    const verb = next.operation === 'move' ? 'move' : 'delete';
    const what = part(next);
    const target = what === '' ? 'it' : `${what}of it`;
    const when = next.state === 'eligible' ? 'at its next deletion run' : `on ${day(next.eligibleAt)}`;
    return `${service} is set to ${verb} ${target} ${when}${ruled(next.rules)}.`;
}
