import { logger } from '../core/logger.ts';
import { matchRule, ruleVerdict, skipReason, unmatchedReason } from '../core/cleanuparrRules.ts';
import {
    hasCleanuparr,
    hasHistory,
    hasTorrentEndpoint,
    type CleanuparrRuleSet,
    type HistoryEntry,
    type QueueItem,
    type ServiceAdapter
} from '../services/types.ts';

/** How far back strikes are read: Cleanuparr resets or acts on a download long before this. */
export const STRIKE_WINDOW_MS = 30 * 86_400_000;

const STRIKE_REASON: Record<string, string> = {
    StalledStrike: 'stalled',
    FailedImportStrike: 'failed import',
    SlowSpeedStrike: 'slow speed',
    SlowTimeStrike: 'slow time',
    DownloadingMetadataStrike: 'stuck metadata',
    DeadTorrentStrike: 'dead torrent'
};

export type Strikes = { count: number; reason: string; rawEvent: string; at: string; dryRun?: true };

/**
 * Each download's standing strikes, from events newest first: the latest
 * strike counts unless a reset came after it. A strike on a client since
 * deleted from Cleanuparr is skipped: the torrent may have moved to another
 * client, where Cleanuparr counts afresh.
 */
export function currentStrikes(events: readonly HistoryEntry[]): Map<string, Strikes> {
    const decided = new Map<string, Strikes | null>();
    for (const e of events) {
        if (e.downloadId === undefined || decided.has(e.downloadId) || e.clientRemoved === true) continue;
        if (e.event === 'recovered') decided.set(e.downloadId, null);
        else if (e.event === 'strike' && e.strikeCount !== undefined) {
            const raw = e.rawEvent ?? '';
            decided.set(e.downloadId, {
                count: e.strikeCount,
                reason: STRIKE_REASON[raw] ?? raw,
                rawEvent: raw,
                at: e.at,
                ...(e.dryRun === true ? { dryRun: true as const } : {})
            });
        }
    }
    return new Map([...decided].filter((kv): kv is [string, Strikes] => kv[1] !== null));
}

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

    const since = new Date(Date.now() - STRIKE_WINDOW_MS).toISOString();
    const [rules, events] = await Promise.allSettled([
        source.getSeedingRules(),
        hasHistory(source) ? source.readHistory({ since, want: 500 }) : Promise.resolve({ items: [], total: 0 })
    ]);
    if (events.status === 'fulfilled') {
        const strikes = currentStrikes(Array.isArray(events.value) ? events.value : events.value.items);
        for (const item of items) {
            const id = item.torrent?.hash ?? item.downloadId?.toLowerCase();
            const hit = id === undefined ? undefined : strikes.get(id);
            if (hit !== undefined) item.strikes = { count: hit.count, reason: hit.reason, lastAt: hit.at, ...(hit.dryRun === true ? { dryRun: true as const } : {}) };
        }
    } else {
        logger.warn({ service: source.id, err: events.reason }, 'cleanuparr strikes unavailable; queue rows carry none');
        markDegraded(source.id);
    }
    if (rules.status === 'rejected') {
        logger.warn({ service: source.id, err: rules.reason }, 'cleanuparr rules unavailable; leaving queue rows as the client reports them');
        markDegraded(source.id);
        return;
    }
    const seeding = rules.value;

    const bySet = mapRuleSets(seeding.sets, adapters);
    const inArrQueue = new Set(items.flatMap(i => (i.torrent === undefined && i.downloadId !== undefined ? [i.downloadId.toLowerCase()] : [])));

    for (const item of items) {
        const set = bySet.get(item.service);
        if (set === undefined || item.torrent === undefined || item.seeding === undefined) continue;
        const rule = matchRule(item.torrent, set.rules);
        if (rule === undefined) {
            item.seeding.cleanuparr = { unmatched: unmatchedReason(item.torrent, set.rules) };
            continue;
        }

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
