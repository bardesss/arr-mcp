/**
 * A port of Cleanuparr's SeedingRuleEvaluator, DownloadCleaner skip checks and
 * ShouldCleanDownload at tag v2.10.9. Keep it in step with that source.
 */

export type RulePrivacy = 'public' | 'private' | 'both';
export type RuleAction = 'delete' | 'stop' | 'unknown';
export type UnmatchedReason =
    | 'no category'
    | 'category not in any rule'
    | 'tracker not in any rule'
    | 'tracker unknown'
    | 'tags not in any rule'
    | 'privacy unknown'
    | 'privacy mismatch';

export type CleanuparrRule = {
    id: string;
    name: string;
    priority: number;
    categories: string[];
    trackerPatterns: string[];
    tagsAny: string[];
    tagsAll: string[];
    privacy: RulePrivacy;
    maxRatio?: number;
    minSeedHours?: number;
    maxSeedHours?: number;
    minSeeders?: number;
    maxInactiveDays?: number;
    /** Fields Cleanuparr returned as null: this client type cannot filter on them. */
    unsupported: string[];
    deleteSourceFiles: boolean;
    action: RuleAction;
};

export type TorrentFacts = {
    hash: string;
    category: string;
    tags: string[];
    trackerDomains: string[];
    savePath?: string;
    private?: boolean;
    stopped: boolean;
    seeding: boolean;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const category = (t: TorrentFacts, r: CleanuparrRule) => r.categories.some(c => same(c, t.category));
const tracker = (t: TorrentFacts, r: CleanuparrRule) =>
    r.trackerPatterns.length === 0 || t.trackerDomains.some(d => r.trackerPatterns.some(p => d.toLowerCase().endsWith(p.toLowerCase())));
const tags = (t: TorrentFacts, r: CleanuparrRule) =>
    (r.unsupported.includes('tagsAny') || r.tagsAny.length === 0 || r.tagsAny.some(tag => t.tags.some(x => same(x, tag)))) &&
    (r.unsupported.includes('tagsAll') || r.tagsAll.length === 0 || r.tagsAll.every(tag => t.tags.some(x => same(x, tag))));
// Cleanuparr reads a torrent the client says nothing about as public, so a public rule takes it.
const privacy = (t: TorrentFacts, r: CleanuparrRule) => r.privacy === 'both' || r.privacy === ((t.private ?? false) ? 'private' : 'public');

/** In Cleanuparr's order, so the first filter to empty the list is the one to blame. */
const FILTERS = [
    ['category not in any rule', category],
    ['tracker not in any rule', tracker],
    ['tags not in any rule', tags],
    ['privacy mismatch', privacy]
] as const;

const matches = (t: TorrentFacts, r: CleanuparrRule): boolean => FILTERS.every(([, f]) => f(t, r));

export function matchRule(t: TorrentFacts, rules: readonly CleanuparrRule[]): CleanuparrRule | undefined {
    return [...rules].sort((a, b) => a.priority - b.priority).find(r => matches(t, r));
}

/** Why no rule matched: the filter that ruled out the last rules still standing. */
export function unmatchedReason(t: TorrentFacts, rules: readonly CleanuparrRule[]): UnmatchedReason {
    if (t.category === '') return 'no category';
    let left = [...rules];
    for (const [reason, f] of FILTERS) {
        const kept = left.filter(r => f(t, r));
        if (kept.length === 0) {
            if (reason === 'privacy mismatch' && t.private === undefined) return 'privacy unknown';
            // qBittorrent names only a tracker that is working right now; Cleanuparr reads them all.
            if (reason === 'tracker not in any rule' && t.trackerDomains.length === 0) return 'tracker unknown';
            return reason;
        }
        left = kept;
    }
    return 'category not in any rule';
}

/** Cleanuparr's ignore list matches a hash, a category, a tag or a tracker domain suffix. */
export const isIgnored = (t: TorrentFacts, ignored: readonly string[]): boolean =>
    ignored.some(i =>
        same(i, t.hash) || same(i, t.category) || t.tags.some(x => same(x, i)) ||
        t.trackerDomains.some(d => d.toLowerCase().endsWith(i.toLowerCase())));

export function skipReason(
    t: TorrentFacts,
    rule: CleanuparrRule,
    ctx: { inArrQueue: ReadonlySet<string>; ignored: readonly string[] }
): string | undefined {
    if (!t.seeding) return 'not seeding';
    if (isIgnored(t, ctx.ignored)) return 'ignored in Cleanuparr';
    if (ctx.inArrQueue.has(t.hash.toLowerCase())) return 'in an *arr queue';
    if (rule.action === 'unknown') return 'unknown rule action';
    if (rule.action === 'stop' && t.stopped) return 'already stopped';
    return undefined;
}

export type RuleVerdict = { over: boolean; reason?: 'ratio' | 'seedTime'; uncertain?: string };

export function ruleVerdict(rule: CleanuparrRule, s: { ratio?: number; seedingSeconds?: number }): RuleVerdict {
    // Cleanuparr only filters on seeders above 0 and on inactivity from 0 days up.
    if (rule.minSeeders !== undefined && rule.minSeeders > 0) return { over: false, uncertain: 'needs the seeder count' };
    if (rule.maxInactiveDays !== undefined && rule.maxInactiveDays >= 0) return { over: false, uncertain: 'needs the last activity time' };

    const seeded = s.seedingSeconds ?? 0;
    const minSeedMet = rule.minSeedHours === undefined || seeded >= rule.minSeedHours * 3600;
    if (rule.maxRatio !== undefined && minSeedMet && s.ratio !== undefined && s.ratio >= rule.maxRatio) {
        return { over: true, reason: 'ratio' };
    }
    if (rule.maxSeedHours !== undefined && seeded >= rule.maxSeedHours * 3600) return { over: true, reason: 'seedTime' };
    return { over: false };
}
