import { describe, expect, it } from 'vitest';
import type { CleanuparrRule } from '../src/core/cleanuparrRules.ts';
import { annotateCleanuparr } from '../src/tools/cleanuparrQueue.ts';
import type { CleanuparrSeeding, QueueItem, ServiceAdapter } from '../src/services/types.ts';

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
