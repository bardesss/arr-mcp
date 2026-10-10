/**
 * A port of Cleanuparr's SeedingRuleEvaluator, DownloadCleaner skip checks and
 * ShouldCleanDownload at tag v2.10.9. Keep it in step with that source.
 */

export type RulePrivacy = 'public' | 'private' | 'both';
export type RuleAction = 'delete' | 'stop' | 'unknown';

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
    private?: boolean;
    stopped: boolean;
    seeding: boolean;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function matches(t: TorrentFacts, r: CleanuparrRule): boolean {
    if (!r.categories.some(c => same(c, t.category))) return false;
    if (r.trackerPatterns.length > 0 && !t.trackerDomains.some(d => r.trackerPatterns.some(p => d.toLowerCase().endsWith(p.toLowerCase())))) {
        return false;
    }
    if (!r.unsupported.includes('tagsAny') && r.tagsAny.length > 0 && !r.tagsAny.some(tag => t.tags.some(x => same(x, tag)))) return false;
    if (!r.unsupported.includes('tagsAll') && r.tagsAll.length > 0 && !r.tagsAll.every(tag => t.tags.some(x => same(x, tag)))) return false;
    if (r.privacy === 'both') return true;
    if (t.private === undefined) return false;
    return r.privacy === (t.private ? 'private' : 'public');
}

export function matchRule(t: TorrentFacts, rules: readonly CleanuparrRule[]): CleanuparrRule | undefined {
    return [...rules].sort((a, b) => a.priority - b.priority).find(r => matches(t, r));
}

export function skipReason(
    t: TorrentFacts,
    rule: CleanuparrRule,
    ctx: { inArrQueue: ReadonlySet<string>; ignored: readonly string[] }
): string | undefined {
    if (!t.seeding) return 'not seeding';
    const ignored = ctx.ignored.some(i =>
        same(i, t.hash) || same(i, t.category) || t.tags.some(x => same(x, i)) ||
        t.trackerDomains.some(d => d.toLowerCase().endsWith(i.toLowerCase())));
    if (ignored) return 'ignored in Cleanuparr';
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
