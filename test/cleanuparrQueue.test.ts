import { describe, expect, it } from 'vitest';
import type { CleanuparrRule } from '../src/core/cleanuparrRules.ts';
import { annotateCleanuparr, currentStrikes } from '../src/tools/cleanuparrQueue.ts';
import { buildGetQueue } from '../src/tools/getQueue.ts';
import type { CleanuparrSeeding, HistoryEntry, QueueItem, ServiceAdapter } from '../src/services/types.ts';

const rule = (over: Partial<CleanuparrRule>): CleanuparrRule => ({
    id: 'r', name: 'Public: stop now', priority: 1, categories: ['complete'], trackerPatterns: [], tagsAny: [], tagsAll: [],
    privacy: 'public', maxRatio: 0, unsupported: ['maxInactiveDays'], deleteSourceFiles: false, action: 'stop', ...over
});

const seeding = (over: Partial<CleanuparrSeeding> = {}): CleanuparrSeeding => ({
    sets: [{ client: 'Transmission', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [rule({}), rule({ id: 'p', name: 'Private: 1.0', privacy: 'private', maxRatio: 1, priority: 2, action: 'delete' })] }],
    dryRun: false, enforced: true, ignored: [], ...over
});

const cleanuparr = (s: CleanuparrSeeding | Error): ServiceAdapter =>
    ({
        id: 'cleanuparr', type: 'cleanuparr',
        testConnection: async () => ({ ok: true, service: 'cleanuparr', latency_ms: 1 }),
        getVersion: async () => '2.10.9',
        getSeedingRules: async () => { if (s instanceof Error) throw s; return s; }
    }) as unknown as ServiceAdapter;

const transmission = { id: 'transmission', type: 'transmission', endpoint: 'transmission.example:9091' } as unknown as ServiceAdapter;

const row = (over: Partial<QueueItem> & { private?: boolean }): QueueItem => ({
    service: 'transmission', id: '1', title: 'Some.Release', status: 'seeding', protocol: 'torrent',
    seeding: { ratio: 0.4, seedingSeconds: 600, ratioLimit: 2 },
    torrent: { hash: 'aaa', category: 'complete', tags: [], trackerDomains: [], private: over.private ?? false, stopped: false, seeding: true },
    ...over
});

describe('annotateCleanuparr', () => {
    it('judges a public torrent against the public rule, keeping the client limit', async () => {
        const items = [row({})];
        await annotateCleanuparr(items, [cleanuparr(seeding()), transmission], () => {});
        expect(items[0]?.seeding).toMatchObject({
            ratioLimit: 2, overLimit: true, limitSource: 'cleanuparr',
            cleanuparr: { rule: 'Public: stop now', action: 'stop', ratioLimit: 0 }
        });
    });

    it('judges a private torrent against the private rule', async () => {
        const items = [row({ private: true })];
        await annotateCleanuparr(items, [cleanuparr(seeding()), transmission], () => {});
        expect(items[0]?.seeding?.overLimit).toBeUndefined();
        expect(items[0]?.seeding?.cleanuparr).toMatchObject({ rule: 'Private: 1.0', ratioLimit: 1 });
    });

    it('leaves overLimit on the client limit when an *arr still holds the torrent', async () => {
        const items = [row({}), { service: 'sonarr', id: '9', title: 'x', status: 'completed', downloadId: 'AAA' } as QueueItem];
        await annotateCleanuparr(items, [cleanuparr(seeding()), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toEqual({ skipped: 'in an *arr queue' });
        expect(items[0]?.seeding?.limitSource).toBeUndefined();
        expect(items[0]?.seeding?.overLimit).toBeUndefined();
    });

    it('marks dry run and an unscheduled cleaner', async () => {
        const items = [row({})];
        await annotateCleanuparr(items, [cleanuparr(seeding({ dryRun: true, enforced: false })), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toMatchObject({ dryRun: true, notEnforced: true });
    });

    it('does nothing for a client Cleanuparr does not know', async () => {
        const other = { id: 'transmission/b', type: 'transmission', endpoint: 'other.example:9091' } as unknown as ServiceAdapter;
        const items = [row({ service: 'transmission/b' })];
        await annotateCleanuparr(items, [cleanuparr(seeding()), other], () => {});
        expect(items[0]?.seeding?.cleanuparr).toBeUndefined();
    });

    it('marks Cleanuparr degraded and leaves rows alone when it is down', async () => {
        const items = [row({})];
        const degraded: string[] = [];
        await annotateCleanuparr(items, [cleanuparr(new Error('down')), transmission], id => degraded.push(id));
        expect(degraded).toEqual(['cleanuparr']);
        expect(items[0]?.seeding?.cleanuparr).toBeUndefined();
    });

    it('converts hours to seconds', async () => {
        const items = [row({})];
        const s = seeding({ sets: [{ client: 'T', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [rule({ maxSeedHours: 2, minSeedHours: 1 })] }] });
        await annotateCleanuparr(items, [cleanuparr(s), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toMatchObject({ seedingLimitSeconds: 7200, minSeedSeconds: 3600 });
    });

    it('keeps the client judgement when the verdict is uncertain', async () => {
        const items = [row({ seeding: { ratio: 0.4, seedingSeconds: 600, ratioLimit: 2, overLimit: true } })];
        const s = seeding({ sets: [{ client: 'T', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [rule({ minSeeders: 5 })] }] });
        await annotateCleanuparr(items, [cleanuparr(s), transmission], () => {});
        expect(items[0]?.seeding?.overLimit).toBe(true);
        expect(items[0]?.seeding?.limitSource).toBeUndefined();
        expect(items[0]?.seeding?.cleanuparr).toMatchObject({ uncertain: expect.any(String) });
    });

    it('keeps the client judgement when the rule has no ratio or time limit', async () => {
        const items = [row({ seeding: { ratio: 3, seedingSeconds: 600, ratioLimit: 2, overLimit: true } })];
        const { maxRatio: _m, ...noLimits } = rule({});
        const s = seeding({ sets: [{ client: 'T', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [noLimits] }] });
        await annotateCleanuparr(items, [cleanuparr(s), transmission], () => {});
        expect(items[0]?.seeding?.overLimit).toBe(true);
        expect(items[0]?.seeding?.limitSource).toBeUndefined();
        expect(items[0]?.seeding?.cleanuparr).toMatchObject({ rule: 'Public: stop now' });
    });

    it('is uncertain when a tracker rule above the match could apply and the client named no tracker', async () => {
        const items = [row({})];
        const s = seeding({ sets: [{ client: 'T', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [
            rule({ id: 't', name: 'Tracker', priority: 0, trackerPatterns: ['example.org'] }),
            rule({})
        ] }] });
        await annotateCleanuparr(items, [cleanuparr(s), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toMatchObject({ rule: 'Public: stop now', uncertain: "needs the torrent's trackers" });
        expect(items[0]?.seeding?.limitSource).toBeUndefined();
    });
});

describe('annotateCleanuparr edge cases', () => {
    it('keeps a client overLimit of true when an *arr holds the torrent', async () => {
        const items = [row({ seeding: { ratio: 3, seedingSeconds: 600, ratioLimit: 2, overLimit: true } }), { service: 'sonarr', id: '9', title: 'x', status: 'completed', downloadId: 'AAA' } as QueueItem];
        await annotateCleanuparr(items, [cleanuparr(seeding()), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toEqual({ skipped: 'in an *arr queue' });
        expect(items[0]?.seeding?.overLimit).toBe(true);
        expect(items[0]?.seeding?.limitSource).toBeUndefined();
    });

    it('maps neither set when two point at the same client', async () => {
        const dup = seeding({ sets: [
            { client: 'A', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [rule({})] },
            { client: 'B', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [rule({})] }
        ] });
        const items = [row({})];
        await annotateCleanuparr(items, [cleanuparr(dup), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toBeUndefined();
        expect(items[0]?.seeding?.overLimit).toBeUndefined();
    });
});

describe('get_queue and Cleanuparr', () => {
    const counted = (s: CleanuparrSeeding | Error) => {
        const calls = { n: 0 };
        const base = cleanuparr(s) as unknown as { getSeedingRules: () => Promise<CleanuparrSeeding> };
        const adapter = { ...base, getSeedingRules: () => { calls.n += 1; return base.getSeedingRules(); } } as unknown as ServiceAdapter;
        return { adapter, calls };
    };
    const queued = { ...transmission, getQueue: async () => [row({})] } as unknown as ServiceAdapter;

    it('makes no Cleanuparr call below full', async () => {
        const { adapter, calls } = counted(seeding());
        const result = await buildGetQueue([adapter, queued], { detail: 'standard', limit: 50 });
        expect(calls.n).toBe(0);
        expect(result.degraded).toEqual([]);
    });

    it('annotates rows at full', async () => {
        const { adapter, calls } = counted(seeding());
        const result = await buildGetQueue([adapter, queued], { detail: 'full', limit: 50 });
        expect(calls.n).toBe(1);
        expect(result.items[0]?.seeding?.cleanuparr).toMatchObject({ rule: 'Public: stop now' });
    });

    it('marks Cleanuparr degraded at full when it throws, and keeps the rows', async () => {
        const { adapter } = counted(new Error('down'));
        const result = await buildGetQueue([adapter, queued], { detail: 'full', limit: 50 });
        expect(result.degraded).toEqual(['cleanuparr']);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.seeding?.cleanuparr).toBeUndefined();
    });
});

const ev = (over: Partial<HistoryEntry>): HistoryEntry => ({ service: 'cleanuparr', id: 'e', at: 't', event: 'strike', title: 'x', downloadId: 'aaa', ...over });

const withEvents = (s: CleanuparrSeeding, events: HistoryEntry[] | Error): ServiceAdapter =>
    ({
        ...(cleanuparr(s) as object),
        readHistory: async () => {
            if (events instanceof Error) throw events;
            return { items: events, total: events.length };
        }
    }) as unknown as ServiceAdapter;

const facts = (over: Partial<NonNullable<QueueItem['torrent']>>): NonNullable<QueueItem['torrent']> => ({
    hash: 'aaa', category: 'complete', tags: [], trackerDomains: [], private: true, stopped: false, seeding: true, ...over
});

describe('unmatched torrents', () => {
    it('says no category for an uncategorised torrent', async () => {
        const items = [row({ torrent: facts({ category: '' }) })];
        await annotateCleanuparr(items, [cleanuparr(seeding()), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toEqual({ unmatched: 'no category' });
        expect(items[0]?.seeding?.limitSource).toBeUndefined();
    });

    it('says the category is in no rule', async () => {
        const items = [row({ torrent: facts({ category: 'cross-seed' }) })];
        await annotateCleanuparr(items, [cleanuparr(seeding()), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toEqual({ unmatched: 'category not in any rule' });
    });

    it('says privacy mismatch, or unknown when the client did not say', async () => {
        const only = seeding({ sets: [{ client: 'Transmission', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [rule({})] }] });
        const priv = [row({ torrent: facts({}) })];
        await annotateCleanuparr(priv, [cleanuparr(only), transmission], () => {});
        expect(priv[0]?.seeding?.cleanuparr).toEqual({ unmatched: 'privacy mismatch' });
        const { private: _p, ...unsure } = facts({});
        const privateOnly = seeding({ sets: [{ client: 'Transmission', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [rule({ privacy: 'private' })] }] });
        const unknown = [row({ torrent: unsure })];
        await annotateCleanuparr(unknown, [cleanuparr(privateOnly), transmission], () => {});
        expect(unknown[0]?.seeding?.cleanuparr).toEqual({ unmatched: 'privacy unknown' });
    });

    it('lets a public rule take a torrent of unknown privacy, as Cleanuparr does', async () => {
        const { private: _p, ...unsure } = facts({});
        const items = [row({ torrent: unsure })];
        await annotateCleanuparr(items, [cleanuparr(seeding()), transmission], () => {});
        expect(items[0]?.seeding?.cleanuparr).toMatchObject({ rule: 'Public: stop now' });
    });

    it('shows category and tags at full detail, and the save path only when no rule matched', async () => {
        const unmatched = row({ id: '1', torrent: facts({ category: 'tv', tags: ['x'], savePath: '/downloads/tv' }) });
        const matched = row({ id: '2', torrent: facts({ hash: 'bbb', private: false, savePath: '/downloads/complete' }) });
        const client = { id: 'transmission', type: 'transmission', endpoint: 'transmission.example:9091', getQueue: async () => structuredClone([unmatched, matched]) } as unknown as ServiceAdapter;
        const full = await buildGetQueue([cleanuparr(seeding()), client], { detail: 'full', limit: 10 });
        const byId = new Map(full.items.map(i => [i.id, i]));
        expect(byId.get('1')).toMatchObject({ category: 'tv', tags: ['x'], savePath: '/downloads/tv' });
        expect(byId.get('2')).toMatchObject({ category: 'complete' });
        expect(byId.get('2')).not.toHaveProperty('savePath');
        expect(byId.get('2')).not.toHaveProperty('tags');
        expect(byId.get('1')).not.toHaveProperty('torrent');
        const standard = await buildGetQueue([client], { detail: 'standard', limit: 10 });
        expect(standard.items[0]).not.toHaveProperty('category');
    });
});

describe('strikes on queue rows', () => {
    it('keeps the newest strike and drops one a later reset cleared', () => {
        const strikes = currentStrikes([
            ev({ downloadId: 'aaa', rawEvent: 'DeadTorrentStrike', strikeCount: 2 }),
            ev({ downloadId: 'aaa', rawEvent: 'DeadTorrentStrike', strikeCount: 1 }),
            ev({ downloadId: 'bbb', event: 'recovered', rawEvent: 'StrikeReset' }),
            ev({ downloadId: 'bbb', rawEvent: 'StalledStrike', strikeCount: 1 })
        ]);
        expect(strikes.get('aaa')).toMatchObject([{ count: 2, reason: 'dead torrent' }]);
        expect(strikes.has('bbb')).toBe(false);
    });

    it('counts each kind of strike apart, and a reset clears only its own kind', () => {
        const strikes = currentStrikes([
            ev({ rawEvent: 'DeadTorrentStrike', strikeType: 'DeadTorrent', strikeCount: 1, at: '4' }),
            ev({ event: 'recovered', rawEvent: 'StrikeReset', strikeType: 'SlowSpeed', at: '3' }),
            ev({ rawEvent: 'SlowSpeedStrike', strikeType: 'SlowSpeed', strikeCount: 2, at: '2' }),
            ev({ rawEvent: 'StalledStrike', strikeType: 'Stalled', strikeCount: 3, at: '1' })
        ]);
        expect(strikes.get('aaa')).toEqual([
            { count: 3, reason: 'stalled', rawEvent: 'StalledStrike', at: '1' },
            { count: 1, reason: 'dead torrent', rawEvent: 'DeadTorrentStrike', at: '4' }
        ]);
    });

    it('keeps dry-run strikes apart from real ones and lists the real ones first', () => {
        const strikes = currentStrikes([
            ev({ rawEvent: 'StalledStrike', strikeType: 'Stalled', strikeCount: 4, dryRun: true }),
            ev({ rawEvent: 'StalledStrike', strikeType: 'Stalled', strikeCount: 2 })
        ]);
        expect(strikes.get('aaa')?.map(s => [s.count, s.dryRun])).toEqual([[2, undefined], [4, true]]);
    });

    it('skips strikes from a client since deleted from Cleanuparr', () => {
        const strikes = currentStrikes([
            ev({ downloadId: 'aaa', rawEvent: 'DeadTorrentStrike', strikeCount: 3, at: '2026-10-20T00:00:00Z', clientRemoved: true }),
            ev({ downloadId: 'bbb', rawEvent: 'DeadTorrentStrike', strikeCount: 3, at: '2026-10-20T00:00:00Z', clientRemoved: true }),
            ev({ downloadId: 'bbb', rawEvent: 'DeadTorrentStrike', strikeCount: 1, at: '2026-10-18T00:00:00Z', downloadClient: 'qBittorrent' })
        ]);
        expect(strikes.has('aaa')).toBe(false);
        expect(strikes.get('bbb')).toMatchObject([{ count: 1, at: '2026-10-18T00:00:00Z' }]);
    });

    it('puts strikes on torrent rows by hash and on *arr rows by download id', async () => {
        const arr = { service: 'sonarr', id: '9', title: 'x', status: 'downloading', downloadId: 'CCC' } as QueueItem;
        const items = [row({}), arr];
        const events = [
            ev({ downloadId: 'aaa', rawEvent: 'DeadTorrentStrike', strikeCount: 1 }),
            ev({ downloadId: 'ccc', rawEvent: 'StalledStrike', strikeCount: 2, dryRun: true })
        ];
        await annotateCleanuparr(items, [withEvents(seeding(), events), transmission], () => {});
        expect(items[0]?.strikes).toEqual([{ count: 1, reason: 'dead torrent', lastAt: 't' }]);
        expect(items[1]?.strikes).toEqual([{ count: 2, reason: 'stalled', lastAt: 't', dryRun: true }]);
    });

    it('still judges rules when the events cannot be read, and marks Cleanuparr degraded', async () => {
        const degraded: string[] = [];
        const items = [row({})];
        await annotateCleanuparr(items, [withEvents(seeding(), new Error('down')), transmission], id => degraded.push(id));
        expect(items[0]?.seeding?.limitSource).toBe('cleanuparr');
        expect(degraded).toEqual(['cleanuparr']);
    });
});
