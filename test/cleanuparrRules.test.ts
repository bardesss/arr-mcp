import { describe, expect, it } from 'vitest';
import { matchRule, ruleVerdict, skipReason, type CleanuparrRule, type TorrentFacts } from '../src/core/cleanuparrRules.ts';

const rule = (over: Partial<CleanuparrRule> = {}): CleanuparrRule => ({
    id: 'r', name: 'Rule', priority: 1, categories: ['tv'], trackerPatterns: [], tagsAny: [], tagsAll: [],
    privacy: 'both', unsupported: [], deleteSourceFiles: false, action: 'stop', ...over
});
const torrent = (over: { [K in keyof TorrentFacts]?: TorrentFacts[K] | undefined } = {}): TorrentFacts => ({
    hash: 'abc123', category: 'tv', tags: [], trackerDomains: ['tracker.example.org'], private: false, stopped: false, seeding: true, ...over
} as TorrentFacts);

describe('matchRule', () => {
    it('picks the lowest priority number first', () => {
        const rules = [rule({ id: 'b', priority: 2 }), rule({ id: 'a', priority: 1 })];
        expect(matchRule(torrent(), rules)?.id).toBe('a');
    });

    it('matches category case-insensitively and nothing else', () => {
        expect(matchRule(torrent({ category: 'TV' }), [rule()])).toBeDefined();
        expect(matchRule(torrent({ category: 'movies' }), [rule()])).toBeUndefined();
        expect(matchRule(torrent({ category: '' }), [rule()])).toBeUndefined();
    });

    it('requires a tracker domain ending with a pattern when patterns are set', () => {
        expect(matchRule(torrent(), [rule({ trackerPatterns: ['example.org'] })])).toBeDefined();
        expect(matchRule(torrent(), [rule({ trackerPatterns: ['other.net'] })])).toBeUndefined();
    });

    it('applies tagsAny and tagsAll', () => {
        expect(matchRule(torrent({ tags: ['x'] }), [rule({ tagsAny: ['x', 'y'] })])).toBeDefined();
        expect(matchRule(torrent({ tags: ['z'] }), [rule({ tagsAny: ['x', 'y'] })])).toBeUndefined();
        expect(matchRule(torrent({ tags: ['x'] }), [rule({ tagsAll: ['x', 'y'] })])).toBeUndefined();
        expect(matchRule(torrent({ tags: ['x', 'y'] }), [rule({ tagsAll: ['x', 'y'] })])).toBeDefined();
    });

    it('skips tag filters the client cannot express', () => {
        expect(matchRule(torrent({ tags: [] }), [rule({ tagsAny: ['x'], unsupported: ['tagsAny'] })])).toBeDefined();
    });

    it('matches privacy, and an unknown privacy only matches both', () => {
        expect(matchRule(torrent({ private: false }), [rule({ privacy: 'public' })])).toBeDefined();
        expect(matchRule(torrent({ private: true }), [rule({ privacy: 'public' })])).toBeUndefined();
        expect(matchRule(torrent({ private: true }), [rule({ privacy: 'private' })])).toBeDefined();
        expect(matchRule(torrent({ private: undefined }), [rule({ privacy: 'public' })])).toBeUndefined();
        expect(matchRule(torrent({ private: undefined }), [rule({ privacy: 'both' })])).toBeDefined();
    });

    it('matches an empty category only against a rule that lists one', () => {
        expect(matchRule(torrent({ category: '' }), [rule({ categories: [''] })])).toBeDefined();
    });

    it('matches tracker patterns case-insensitively and any tracker of several', () => {
        const t = torrent({ trackerDomains: ['a.other.net', 'Tracker.Example.ORG'] });
        expect(matchRule(t, [rule({ trackerPatterns: ['example.org'] })])).toBeDefined();
    });

    it('matches tags case-insensitively', () => {
        expect(matchRule(torrent({ tags: ['X'] }), [rule({ tagsAny: ['x'] })])).toBeDefined();
        expect(matchRule(torrent({ tags: ['X', 'Y'] }), [rule({ tagsAll: ['x', 'y'] })])).toBeDefined();
    });

    it('falls through to the next rule when the first does not match', () => {
        const rules = [rule({ id: 'pub', privacy: 'public', priority: 1 }), rule({ id: 'priv', privacy: 'private', priority: 2 })];
        expect(matchRule(torrent({ private: true }), rules)?.id).toBe('priv');
    });
});

describe('skipReason', () => {
    const ctx = { inArrQueue: new Set<string>(), ignored: [] as string[] };

    it('skips a torrent that is not seeding', () => {
        expect(skipReason(torrent({ seeding: false }), rule(), ctx)).toBe('not seeding');
    });

    it('skips a torrent an *arr still has in its queue, comparing hashes case-insensitively', () => {
        expect(skipReason(torrent({ hash: 'abc123' }), rule(), { ...ctx, inArrQueue: new Set(['abc123']) })).toBe('in an *arr queue');
    });

    it('skips ignored downloads by hash, category or tracker', () => {
        expect(skipReason(torrent(), rule(), { ...ctx, ignored: ['ABC123'] })).toBe('ignored in Cleanuparr');
        expect(skipReason(torrent(), rule(), { ...ctx, ignored: ['tv'] })).toBe('ignored in Cleanuparr');
        expect(skipReason(torrent(), rule(), { ...ctx, ignored: ['example.org'] })).toBe('ignored in Cleanuparr');
    });

    it('skips ignored downloads by tag, as Cleanuparr does', () => {
        expect(skipReason(torrent({ tags: ['Keep'] }), rule(), { ...ctx, ignored: ['keep'] })).toBe('ignored in Cleanuparr');
    });

    it('checks ignored before the *arr queue', () => {
        expect(skipReason(torrent(), rule(), { inArrQueue: new Set(['abc123']), ignored: ['tv'] })).toBe('ignored in Cleanuparr');
    });

    it('finds an upper-case hash in the lower-case queue set', () => {
        expect(skipReason(torrent({ hash: 'ABC123' }), rule(), { ...ctx, inArrQueue: new Set(['abc123']) })).toBe('in an *arr queue');
    });

    it('skips a stopped torrent under a Stop rule only', () => {
        expect(skipReason(torrent({ stopped: true }), rule({ action: 'stop' }), ctx)).toBe('already stopped');
        expect(skipReason(torrent({ stopped: true }), rule({ action: 'delete' }), ctx)).toBeUndefined();
    });

    it('skips a rule whose action this version does not know', () => {
        expect(skipReason(torrent(), rule({ action: 'unknown' }), ctx)).toBe('unknown rule action');
    });
});

describe('ruleVerdict', () => {
    it('treats maxRatio 0 as reached immediately', () => {
        expect(ruleVerdict(rule({ maxRatio: 0 }), { ratio: 0, seedingSeconds: 10 })).toEqual({ over: true, reason: 'ratio' });
    });

    it('holds the ratio check until the minimum seed time has passed', () => {
        const r = rule({ maxRatio: 1, minSeedHours: 2 });
        expect(ruleVerdict(r, { ratio: 1.5, seedingSeconds: 3600 }).over).toBe(false);
        expect(ruleVerdict(r, { ratio: 1.5, seedingSeconds: 7200 })).toEqual({ over: true, reason: 'ratio' });
    });

    it('falls back to the maximum seed time', () => {
        expect(ruleVerdict(rule({ maxSeedHours: 1 }), { ratio: 0.1, seedingSeconds: 3600 })).toEqual({ over: true, reason: 'seedTime' });
    });

    it('is not over when nothing limits it', () => {
        expect(ruleVerdict(rule(), { ratio: 99, seedingSeconds: 99999 })).toEqual({ over: false });
    });

    it('does not decide on a ratio it does not know', () => {
        expect(ruleVerdict(rule({ maxRatio: 1 }), { seedingSeconds: 10 }).over).toBe(false);
    });

    it('treats maxSeedHours 0 as reached immediately', () => {
        expect(ruleVerdict(rule({ maxSeedHours: 0 }), { ratio: 0, seedingSeconds: 0 })).toEqual({ over: true, reason: 'seedTime' });
    });

    it('does not treat minSeeders 0 as a filter, but maxInactiveDays 0 is one', () => {
        expect(ruleVerdict(rule({ maxRatio: 0, minSeeders: 0 }), { ratio: 1 })).toEqual({ over: true, reason: 'ratio' });
        expect(ruleVerdict(rule({ maxRatio: 0, maxInactiveDays: 0 }), { ratio: 1 })).toEqual({ over: false, uncertain: 'needs the last activity time' });
    });

    it('declines to judge rules that need seeders or activity it cannot see', () => {
        expect(ruleVerdict(rule({ maxRatio: 0, minSeeders: 5 }), { ratio: 1 })).toEqual({ over: false, uncertain: 'needs the seeder count' });
        expect(ruleVerdict(rule({ maxRatio: 0, maxInactiveDays: 3 }), { ratio: 1 })).toEqual({ over: false, uncertain: 'needs the last activity time' });
    });
});
