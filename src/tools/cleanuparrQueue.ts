import { logger } from '../core/logger.ts';
import { matchRule, ruleVerdict, skipReason, unmatchedReason, type CleanuparrRule, type RuleVerdict } from '../core/cleanuparrRules.ts';
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
    DeadTorrentStrike: 'dead torrent',
    ErroredStrike: 'errored'
};

export type Strikes = { count: number; reason: string; rawEvent: string; at: string; dryRun?: true };

/**
 * Each download's standing strikes, from events newest first. Cleanuparr
 * counts each kind of strike apart, and dry-run strikes apart from real ones,
 * so each pair keeps its latest count unless a reset of that kind came after
 * it. A reset that does not name its kind clears everything before it. A
 * strike on a client since deleted from Cleanuparr is skipped: the torrent may
 * have moved to another client, where Cleanuparr counts afresh.
 *
 * Per download, real strikes come first, then the highest count.
 */
export function currentStrikes(events: readonly HistoryEntry[]): Map<string, Strikes[]> {
    const decided = new Map<string, Map<string, Strikes | null>>();
    const closed = new Set<string>();
    for (const e of events) {
        const id = e.downloadId;
        if (id === undefined || closed.has(id) || e.clientRemoved === true) continue;
        if (e.event !== 'recovered' && (e.event !== 'strike' || e.strikeCount === undefined)) continue;
        if (e.event === 'recovered' && e.strikeType === undefined) {
            closed.add(id);
            continue;
        }
        const raw = e.rawEvent ?? '';
        const key = `${e.strikeType ?? raw}|${e.dryRun === true ? 'dry' : 'real'}`;
        const kinds = decided.get(id) ?? new Map<string, Strikes | null>();
        decided.set(id, kinds);
        if (kinds.has(key)) continue;
        kinds.set(
            key,
            e.event === 'recovered' || e.strikeCount === undefined
                ? null
                : { count: e.strikeCount, reason: STRIKE_REASON[raw] ?? raw, rawEvent: raw, at: e.at, ...(e.dryRun === true ? { dryRun: true as const } : {}) }
        );
    }
    const out = new Map<string, Strikes[]>();
    for (const [id, kinds] of decided) {
        const standing = [...kinds.values()]
            .filter((s): s is Strikes => s !== null)
            .sort((a, b) => Number(a.dryRun === true) - Number(b.dryRun === true) || b.count - a.count);
        if (standing.length > 0) out.set(id, standing);
    }
    return out;
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

/** ISO to the second: milliseconds say nothing about a cron job, and 500 rows pay for them. */
const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');

/**
 * When a rule's action falls due, or undefined when the clock alone never
 * gets there. Past the rule, it is the Download Cleaner's next run, or now
 * when that is unknown or overdue. Otherwise it is the moment the torrent
 * reaches the seed time, or the minimum seed time while already over the
 * ratio, since only that minimum holds the ratio back. Ratio still to climb
 * depends on upload, which no clock projects. A limit reached after the next
 * run is acted on at the first run after it, which only the cron could name,
 * so `dueAt` is then the moment the limit is reached.
 */
export function projectDue(
    rule: CleanuparrRule,
    verdict: RuleVerdict,
    s: { ratio?: number; seedingSeconds?: number },
    now: number,
    nextRunAt?: string
): string | undefined {
    const seeded = s.seedingSeconds ?? 0;
    const at = (hours: number) => now + Math.max(0, hours * 3600 - seeded) * 1000;
    const reaches: number[] = [];
    if (verdict.over) reaches.push(now);
    if (rule.maxSeedHours !== undefined) reaches.push(at(rule.maxSeedHours));
    if (rule.maxRatio !== undefined && rule.minSeedHours !== undefined && s.ratio !== undefined && s.ratio >= rule.maxRatio) {
        reaches.push(at(rule.minSeedHours));
    }
    if (reaches.length === 0) return undefined;
    const reach = Math.min(...reaches);
    const next = nextRunAt === undefined ? NaN : Date.parse(nextRunAt);
    return isoSeconds(!Number.isNaN(next) && next >= reach ? next : reach);
}

export const DUE_WINDOW_DAYS = 7;

type DueTotal = { count: number; sizeBytes: number };
export type CleanuparrDue = { days: number; delete?: DueTotal; stop?: DueTotal; dryRun?: true };

/** What Cleanuparr's rules fall due on within the window, per action. Undefined when nothing does. */
export function dueWithin(items: readonly QueueItem[], now: number, days = DUE_WINDOW_DAYS): CleanuparrDue | undefined {
    const end = now + days * 86_400_000;
    const out: CleanuparrDue = { days };
    let any = false;
    for (const item of items) {
        const c = item.seeding?.cleanuparr;
        if (c === undefined || !('rule' in c) || c.dueAt === undefined || Date.parse(c.dueAt) > end) continue;
        if (c.action !== 'delete' && c.action !== 'stop') continue;
        const total = out[c.action] ?? { count: 0, sizeBytes: 0 };
        total.count += 1;
        total.sizeBytes += item.sizeBytes ?? 0;
        out[c.action] = total;
        if (c.dryRun === true) out.dryRun = true;
        any = true;
    }
    return any ? out : undefined;
}

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
            if (hit !== undefined) item.strikes = hit.map(s => ({ count: s.count, reason: s.reason, lastAt: s.at, ...(s.dryRun === true ? { dryRun: true as const } : {}) }));
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
    const now = Date.now();

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
        // qBittorrent names only a tracker that is working right now, so a rule above this one may be Cleanuparr's pick.
        const trackerDoubt =
            item.torrent.trackerDomains.length === 0 && set.rules.some(r => r.priority < rule.priority && r.trackerPatterns.length > 0);
        const uncertain = verdict.uncertain ?? (trackerDoubt ? 'needs the torrent\'s trackers' : undefined);
        // A rule without a ratio or time limit never acts on either, so the client's own limit still decides.
        const keepClient = uncertain !== undefined || (rule.maxRatio === undefined && rule.maxSeedHours === undefined);
        const dueAt = uncertain !== undefined || !seeding.enforced ? undefined : projectDue(rule, verdict, item.seeding, now, seeding.nextRunAt);
        const { overLimit: clientOver, ...rest } = item.seeding;
        item.seeding = {
            ...rest,
            ...(keepClient ? {} : { limitSource: 'cleanuparr' as const }),
            ...(verdict.over ? { overLimit: true as const } : {}),
            cleanuparr: {
                rule: rule.name,
                action: rule.action,
                ...(rule.maxRatio === undefined ? {} : { ratioLimit: rule.maxRatio }),
                ...(rule.maxSeedHours === undefined ? {} : { seedingLimitSeconds: rule.maxSeedHours * 3600 }),
                ...(rule.minSeedHours === undefined ? {} : { minSeedSeconds: rule.minSeedHours * 3600 }),
                ...(seeding.dryRun ? { dryRun: true as const } : {}),
                ...(seeding.enforced ? {} : { notEnforced: true as const }),
                ...(uncertain === undefined ? {} : { uncertain }),
                ...(dueAt === undefined ? {} : { dueAt })
            }
        };
        if (keepClient && clientOver === true) item.seeding.overLimit = true;
    }
}
