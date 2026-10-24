import { logger } from '../core/logger.ts';
import { matchRule, ruleVerdict, skipReason } from '../core/cleanuparrRules.ts';
import { hasCleanuparr, hasTorrentEndpoint, type CleanuparrRuleSet, type QueueItem, type ServiceAdapter } from '../services/types.ts';

/** Which client each rule set points at. A client two sets point at is a conflict, never guessed. */
export function resolveRuleSets(
    sets: readonly CleanuparrRuleSet[],
    adapters: readonly ServiceAdapter[]
): { mapped: Map<string, CleanuparrRuleSet>; conflicts: Map<string, CleanuparrRuleSet[]> } {
    const targets = new Map<string, CleanuparrRuleSet[]>();
    for (const set of sets) {
        const hits = adapters.filter(a => hasTorrentEndpoint(a) && set.endpoint !== undefined && a.endpoint === set.endpoint && a.type.toLowerCase() === set.clientType.toLowerCase());
        if (hits.length === 1 && hits[0] !== undefined) targets.set(hits[0].id, [...(targets.get(hits[0].id) ?? []), set]);
    }
    const mapped = new Map<string, CleanuparrRuleSet>();
    const conflicts = new Map<string, CleanuparrRuleSet[]>();
    for (const [id, list] of targets) {
        if (list.length === 1 && list[0] !== undefined) mapped.set(id, list[0]);
        else conflicts.set(id, list);
    }
    return { mapped, conflicts };
}

/** Maps each torrent client id to the Cleanuparr rule set for it, when exactly one matches. */
export const mapRuleSets = (sets: readonly CleanuparrRuleSet[], adapters: readonly ServiceAdapter[]): Map<string, CleanuparrRuleSet> =>
    resolveRuleSets(sets, adapters).mapped;

export async function annotateCleanuparr(
    items: QueueItem[],
    adapters: readonly ServiceAdapter[],
    markDegraded: (id: string) => void
): Promise<void> {
    const source = adapters.find(hasCleanuparr);
    if (source === undefined) return;

    let seeding;
    try {
        seeding = await source.getSeedingRules();
    } catch (err) {
        logger.warn({ service: source.id, err }, 'cleanuparr rules unavailable; leaving queue rows as the client reports them');
        markDegraded(source.id);
        return;
    }

    const bySet = mapRuleSets(seeding.sets, adapters);
    const inArrQueue = new Set(items.flatMap(i => (i.torrent === undefined && i.downloadId !== undefined ? [i.downloadId.toLowerCase()] : [])));

    for (const item of items) {
        const set = bySet.get(item.service);
        if (set === undefined || item.torrent === undefined || item.seeding === undefined) continue;
        const rule = matchRule(item.torrent, set.rules);
        if (rule === undefined) continue;

        const skipped = skipReason(item.torrent, rule, { inArrQueue, ignored: seeding.ignored });
        if (skipped !== undefined) {
            item.seeding.cleanuparr = { skipped };
            continue;
        }

        const verdict = ruleVerdict(rule, item.seeding);
        const { overLimit: clientOver, ...rest } = item.seeding;
        item.seeding = {
            ...rest,
            ...(verdict.uncertain === undefined ? { limitSource: 'cleanuparr' as const } : {}),
            ...(verdict.over ? { overLimit: true as const } : {}),
            cleanuparr: {
                rule: rule.name,
                action: rule.action,
                ...(rule.maxRatio === undefined ? {} : { ratioLimit: rule.maxRatio }),
                ...(rule.maxSeedHours === undefined ? {} : { seedingLimitSeconds: rule.maxSeedHours * 3600 }),
                ...(rule.minSeedHours === undefined ? {} : { minSeedSeconds: rule.minSeedHours * 3600 }),
                ...(seeding.dryRun ? { dryRun: true as const } : {}),
                ...(seeding.enforced ? {} : { notEnforced: true as const }),
                ...(verdict.uncertain === undefined ? {} : { uncertain: verdict.uncertain })
            }
        };
        // An uncertain verdict keeps the client's own judgement.
        if (verdict.uncertain !== undefined && clientOver === true) item.seeding.overLimit = true;
    }
}
