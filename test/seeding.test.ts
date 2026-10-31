import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CredentialServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { ProwlarrAdapter } from '../src/services/prowlarr.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildGetQueue, queueLine } from '../src/tools/getQueue.ts';
import { buildSeedingRules } from '../src/tools/seedingRules.ts';
import { buildStackHealth } from '../src/tools/stackHealth.ts';
import { repeat } from './helpers/bigFixture.ts';
import { expectWithinBudget } from './helpers/budget.ts';
import { jsonResponse, serving } from './helpers/serve.ts';

const credentials = (port: number): CredentialServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const qbit = (torrents: unknown[]) =>
    new QbittorrentAdapter(credentials(8081), serving({ '/api/v2/torrents/info': torrents }));

// Field names and sentinels from qBittorrent release-5.2.4:
// serialize_torrent.cpp and SessionImpl::processTorrentShareLimits.
const finished = {
    hash: 'a'.repeat(40),
    name: 'Some.Film.2026-GROUP',
    state: 'uploading',
    size: 1000,
    amount_left: 0,
    ratio: 1.5,
    seeding_time: 7200,
    ratio_limit: -2,
    seeding_time_limit: -2,
    max_ratio: 1,
    max_seeding_time: -1,
    private: true
};

/** Transmission answers every method on one endpoint, so route on the body. */
const transmission = (torrents: unknown[], session: Record<string, unknown> = {}) =>
    new TransmissionAdapter(credentials(9091), (async (_input: unknown, init?: RequestInit) => {
        const method = (JSON.parse(String(init?.body ?? '{}')) as { method?: string }).method;
        if (method === 'session-get') return jsonResponse({ result: 'success', arguments: session });
        return jsonResponse({ result: 'success', arguments: { torrents } });
    }) as unknown as typeof fetch);

// Legacy RPC names, which the adapter speaks: rpc-spec.md at 4.0.6.
const seeded = {
    id: 3,
    name: 'Some.Show.S01-GROUP',
    status: 6,
    totalSize: 1000,
    leftUntilDone: 0,
    uploadRatio: 2.5,
    secondsSeeding: 600,
    seedRatioMode: 0,
    seedRatioLimit: 5,
    isPrivate: false
};

const full = { detail: 'full' as const, limit: 50 };

describe('qBittorrent seeding state', () => {
    it('reports the effective limit and flags a torrent past it', async () => {
        const [item] = (await buildGetQueue([qbit([finished])], full)).items;

        expect(item?.private).toBe(true);
        expect(item?.seeding).toEqual({
            ratio: 1.5,
            seedingSeconds: 7200,
            ratioLimit: 1,
            overLimit: true
        });
    });

    it('names the torrent as the source when it carries its own override', async () => {
        const own = { ...finished, ratio_limit: 3, max_ratio: 3 };
        const [item] = (await buildGetQueue([qbit([own])], full)).items;

        expect(item?.seeding).toMatchObject({ ratioLimit: 3, ownLimit: true });
        expect(item?.seeding?.overLimit).toBeUndefined();
    });

    it('treats an explicit "no limit" override as the torrent choosing none', async () => {
        const none = { ...finished, ratio_limit: -1, max_ratio: -1 };
        const [item] = (await buildGetQueue([qbit([none])], full)).items;

        expect(item?.seeding).toEqual({ ratio: 1.5, seedingSeconds: 7200, ownLimit: true });
    });

    it('compares seeding time in whole minutes, as qBittorrent does', async () => {
        const timed = { ...finished, max_ratio: -1, max_seeding_time: 120, seeding_time: 7199 };
        const under = (await buildGetQueue([qbit([timed])], full)).items[0];
        const at = (await buildGetQueue([qbit([{ ...timed, seeding_time: 7200 }])], full)).items[0];

        expect(under?.seeding).toEqual({ ratio: 1.5, seedingSeconds: 7199, seedingLimitSeconds: 7200 });
        expect(at?.seeding?.overLimit).toBe(true);
    });

    it('reads a ratio of -1 as infinite, which is past any limit', async () => {
        const [item] = (await buildGetQueue([qbit([{ ...finished, ratio: -1 }])], full)).items;

        expect(item?.seeding?.ratio).toBeUndefined();
        expect(item?.seeding?.overLimit).toBe(true);
    });

    it('marks a force-started torrent, which qBittorrent exempts from share limits', async () => {
        const [item] = (await buildGetQueue([qbit([{ ...finished, state: 'forcedUP' }])], full)).items;
        expect(item?.seeding).toMatchObject({ overLimit: true, forced: true });
    });

    it('leaves seeding off a torrent that is still downloading', async () => {
        const [item] = (await buildGetQueue([qbit([{ ...finished, state: 'downloading', amount_left: 10 }])], full)).items;
        expect(item?.seeding).toBeUndefined();
    });

    it('omits private when qBittorrent has no metadata yet, or predates the field', async () => {
        const noMeta = (await buildGetQueue([qbit([{ ...finished, private: null }])], full)).items[0];
        const { private: _p, ...old } = finished;
        const legacy = (await buildGetQueue([qbit([old])], full)).items[0];

        expect(noMeta?.private).toBeUndefined();
        expect(legacy?.private).toBeUndefined();
    });
});

describe('Transmission seeding state', () => {
    it('falls back to the session limit when the torrent follows the global setting', async () => {
        const adapter = transmission([seeded], { seedRatioLimit: 2, seedRatioLimited: true });
        const [item] = (await buildGetQueue([adapter], full)).items;

        expect(item?.private).toBe(false);
        expect(item?.seeding).toEqual({
            ratio: 2.5,
            seedingSeconds: 600,
            ratioLimit: 2,
            overLimit: true
        });
    });

    it('reports no limit when the global one is switched off', async () => {
        const adapter = transmission([seeded], { seedRatioLimit: 2, seedRatioLimited: false });
        const [item] = (await buildGetQueue([adapter], full)).items;

        expect(item?.seeding).toEqual({ ratio: 2.5, seedingSeconds: 600 });
    });

    it('uses the torrent own limit in mode 1, and none in mode 2', async () => {
        const session = { seedRatioLimit: 2, seedRatioLimited: true };
        const own = (await buildGetQueue([transmission([{ ...seeded, seedRatioMode: 1 }], session)], full)).items[0];
        const unlimited = (await buildGetQueue([transmission([{ ...seeded, seedRatioMode: 2 }], session)], full)).items[0];

        expect(own?.seeding).toEqual({ ratio: 2.5, seedingSeconds: 600, ratioLimit: 5, ownLimit: true });
        expect(unlimited?.seeding).toEqual({ ratio: 2.5, seedingSeconds: 600, ownLimit: true });
    });

    it('reads -2 as an infinite ratio and -1 as none yet', async () => {
        const session = { seedRatioLimit: 2, seedRatioLimited: true };
        const inf = (await buildGetQueue([transmission([{ ...seeded, uploadRatio: -2 }], session)], full)).items[0];
        const na = (await buildGetQueue([transmission([{ ...seeded, uploadRatio: -1 }], session)], full)).items[0];

        expect(inf?.seeding).toMatchObject({ overLimit: true });
        expect(inf?.seeding?.ratio).toBeUndefined();
        expect(na?.seeding).toEqual({ seedingSeconds: 600, ratioLimit: 2 });
    });

    it('leaves seeding off a torrent that is still downloading', async () => {
        const [item] = (await buildGetQueue([transmission([{ ...seeded, status: 4, leftUntilDone: 10 }])], full)).items;
        expect(item?.seeding).toBeUndefined();
    });
});

describe('seeding in get_queue output', () => {
    it('is only returned at detail: full', async () => {
        const [item] = (await buildGetQueue([qbit([finished])], { detail: 'standard', limit: 50 })).items;

        expect(item?.seeding).toBeUndefined();
        expect(item?.private).toBeUndefined();
    });

    it('says so in the line when a torrent is still seeding past its limit', async () => {
        const [item] = (await buildGetQueue([qbit([finished])], full)).items;
        expect(queueLine(item!)).toContain('past its seed limit');
    });

    it('does not say so once the client has stopped it', async () => {
        const [item] = (await buildGetQueue([qbit([{ ...finished, state: 'stoppedUP' }])], full)).items;
        expect(queueLine(item!)).not.toContain('past its seed limit');
    });

    it('explains a force-started torrent past its limit', async () => {
        const [item] = (await buildGetQueue([qbit([{ ...finished, state: 'forcedUP' }])], full)).items;
        expect(queueLine(item!)).toContain('force-started');
    });

    it('stays within its token budget at the absolute maximum', async () => {
        const result = await buildGetQueue([qbit(repeat(finished, 500))], { detail: 'full', limit: 500 });
        expectWithinBudget(result, 40_000);
    });
});

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

// Shape and naming as probed live on Radarr: unset criteria come back absent.
const radarrIndexers = (ratio?: number, minutes?: number) => [
    {
        name: 'Nyaa.si (Prowlarr)',
        protocol: 'torrent',
        fields: [
            { name: 'minimumSeeders', value: 1 },
            { name: 'seedCriteria.seedRatio', ...(ratio === undefined ? {} : { value: ratio }) },
            { name: 'seedCriteria.seedTime', ...(minutes === undefined ? {} : { value: minutes }) }
        ]
    },
    { name: 'DrunkenSlug (Prowlarr)', protocol: 'usenet', fields: [] }
];

const radarr = (ratio?: number, minutes?: number) =>
    new RadarrAdapter(keyed(7878), serving({ '/api/v3/indexer': radarrIndexers(ratio, minutes) }));

type RawIndexer = { name: string; fields?: { name: string; value?: unknown }[] };
const PROWLARR_INDEXERS = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'prowlarr', 'indexer.json'), 'utf8')
) as RawIndexer[];

/** The captured Prowlarr fixture, with its first torrent indexer renamed to
 *  match the Radarr copy and optionally given a ratio. */
const prowlarr = (ratio?: number) =>
    new ProwlarrAdapter(
        keyed(9696),
        serving({
            '/api/v1/indexer': PROWLARR_INDEXERS.map(i =>
                i.name !== 'Indexer 3'
                    ? i
                    : {
                          ...i,
                          name: 'Nyaa.si',
                          fields: i.fields?.map(f =>
                              f.name === 'torrentBaseSettings.seedRatio' && ratio !== undefined ? { ...f, value: ratio } : f
                          )
                      }
            )
        })
    );

const qbitPrefs = (prefs: Record<string, unknown>) =>
    new QbittorrentAdapter(credentials(8081), serving({ '/api/v2/app/preferences': prefs }));

describe('client seed limits', () => {
    it('reads qBittorrent global limits in minutes, and its action', async () => {
        const limits = await qbitPrefs({
            max_ratio_enabled: true,
            max_ratio: 1,
            max_seeding_time_enabled: true,
            max_seeding_time: 1440,
            max_ratio_act: 3
        }).getSeedLimits();

        expect(limits).toEqual({
            service: 'qbittorrent',
            ratioLimit: 1,
            seedingLimitSeconds: 86_400,
            action: 'remove with content'
        });
    });

    it('ignores a qBittorrent value whose enabled flag is off', async () => {
        const limits = await qbitPrefs({ max_ratio_enabled: false, max_ratio: 1, max_ratio_act: 0 }).getSeedLimits();
        expect(limits).toEqual({ service: 'qbittorrent', action: 'stop' });
    });

    it('reads the Transmission session limit only when it is switched on', async () => {
        const on = await transmission([], { seedRatioLimit: 2, seedRatioLimited: true }).getSeedLimits();
        const off = await transmission([], { seedRatioLimit: 2, seedRatioLimited: false }).getSeedLimits();

        expect(on).toEqual({ service: 'transmission', ratioLimit: 2, action: 'stop' });
        expect(off).toEqual({ service: 'transmission', action: 'stop' });
    });
});

describe('indexer seed criteria', () => {
    it('reads torrent indexers only, with times in seconds', async () => {
        expect(await radarr(1.5, 60).getSeedCriteria()).toEqual([
            { service: 'radarr', indexer: 'Nyaa.si (Prowlarr)', seedRatio: 1.5, seedTimeSeconds: 3600 }
        ]);
    });

    it('omits criteria the indexer leaves unset', async () => {
        expect(await radarr().getSeedCriteria()).toEqual([{ service: 'radarr', indexer: 'Nyaa.si (Prowlarr)' }]);
    });

    it('reads Prowlarr privacy from the captured fixture', async () => {
        const rows = await prowlarr().getSeedCriteria();

        expect(rows.map(r => r.privacy)).toEqual(['public', 'public']);
        expect(rows.every(r => r.seedRatio === undefined)).toBe(true);
    });
});

describe('stack_health seeding rules', () => {
    // On the instance, not a prototype copy: the adapters keep `#http` private.
    const healthy = <T extends ServiceAdapter>(adapter: T): T => {
        adapter.testConnection = async () => ({ ok: true, service: adapter.id, latency_ms: 1 });
        return adapter;
    };
    const limited = () => healthy(transmission([], { seedRatioLimit: 2, seedRatioLimited: true }));
    const unlimited = () => healthy(transmission([], { seedRatioLimited: false }));
    const full = { detail: 'full' as const, limit: 50 };

    it('is only returned at detail: full', async () => {
        const standard = await buildStackHealth([limited(), healthy(radarr())], { detail: 'standard', limit: 50 });
        const result = await buildStackHealth([limited(), healthy(radarr())], full);

        expect(standard.seedingRules).toBeUndefined();
        expect(result.seedingRules?.clients).toEqual([{ service: 'transmission', ratioLimit: 2, action: 'stop' }]);
        expect(result.seedingRules?.notes).toEqual([]);
    });

    it('is absent when nothing configured seeds', async () => {
        expect((await buildStackHealth([], full)).seedingRules).toBeUndefined();
    });

    it('notes an app copy that disagrees with Prowlarr', async () => {
        const result = await buildStackHealth([limited(), healthy(radarr(1)), healthy(prowlarr(2))], full);

        expect(result.seedingRules?.notes).toEqual([
            `radarr's copy of "Nyaa.si" has ratio 1, no seed time, but prowlarr has ratio 2, no seed time. ` +
                'The copy is what radarr hands the client on a grab.'
        ]);
    });

    it('stays quiet when the app copy matches Prowlarr', async () => {
        const result = await buildStackHealth([limited(), healthy(radarr(2)), healthy(prowlarr(2))], full);
        expect(result.seedingRules?.notes).toEqual([]);
    });

    it('notes an indexer with no criteria when no client has a default either', async () => {
        const result = await buildStackHealth([unlimited(), healthy(radarr())], full);

        expect(result.seedingRules?.notes).toEqual([
            '"Nyaa.si (Prowlarr)" in radarr sets no seed ratio or time, and no torrent client has a default limit, ' +
                'so its grabs seed until someone stops them.'
        ]);
    });

    it('reports a client that cannot be read as degraded, and keeps the rest', async () => {
        const broken = healthy(
            new TransmissionAdapter(credentials(9091), (async () => jsonResponse({}, 500)) as unknown as typeof fetch)
        );
        const result = await buildStackHealth([broken, healthy(radarr(1))], full);

        expect(result.degraded).toContain('transmission');
        expect(result.seedingRules?.clients).toEqual([]);
        expect(result.seedingRules?.indexers).toHaveLength(1);
    });
});

describe('stack_health Cleanuparr rules', () => {
    it('lists Cleanuparr rule sets mapped to their client, with notes', async () => {
        const s = {
            sets: [
                { client: 'Transmission', clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [{ id: 'r', name: 'Public: stop now', priority: 1, categories: ['tv'], trackerPatterns: [], tagsAny: [], tagsAll: [], privacy: 'public', maxRatio: 0, unsupported: [], deleteSourceFiles: false, action: 'stop' }] },
                { client: 'Elsewhere', clientType: 'qBittorrent', endpoint: 'nowhere.example:8080', rules: [] }
            ],
            dryRun: false, enforced: false, ignored: []
        };
        const cleanuparr = { id: 'cleanuparr', type: 'cleanuparr', getSeedingRules: async () => s } as unknown as ServiceAdapter;
        const transmission = { id: 'transmission', type: 'transmission', endpoint: 'transmission.example:9091', getSeedLimits: async () => ({ service: 'transmission', ratioLimit: 2, action: 'stop' }) } as unknown as ServiceAdapter;
        const rules = await buildSeedingRules([cleanuparr, transmission], () => {});
        expect(rules.cleanuparr?.[0]?.service).toBe('transmission');
        expect(rules.cleanuparr?.[1]?.service).toBeUndefined();
        expect(rules.notes.some(n => n.includes('Public: stop now') && n.includes('2'))).toBe(true);
        expect(rules.notes.some(n => n.includes('Elsewhere') && n.includes('no configured'))).toBe(true);
        expect(rules.notes.some(n => n.includes('not scheduled'))).toBe(true);
    });

    it('names both Cleanuparr clients that point at the same client and maps neither', async () => {
        const set = (client: string) => ({ client, clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [] });
        const cleanuparr = { id: 'cleanuparr', type: 'cleanuparr', getSeedingRules: async () => ({ sets: [set('A'), set('B')], dryRun: false, enforced: true, ignored: [] }) } as unknown as ServiceAdapter;
        const transmission = { id: 'transmission', type: 'transmission', endpoint: 'transmission.example:9091' } as unknown as ServiceAdapter;
        const rules = await buildSeedingRules([cleanuparr, transmission], () => {});
        expect(rules.cleanuparr?.every(s => s.service === undefined)).toBe(true);
        expect(rules.notes).toContain("Cleanuparr's clients \"A\" and \"B\" both point at transmission, so neither's rules are applied to get_queue.");
        expect(rules.notes.some(n => n.includes('matches no configured'))).toBe(false);
    });

    it("names Cleanuparr's rules as the only limit for indexers without criteria", async () => {
        const rule = { id: 'r', name: 'Private: 30 days', priority: 1, categories: ['radarr'], trackerPatterns: [], tagsAny: [], tagsAll: [], privacy: 'private', maxSeedHours: 720, unsupported: [], deleteSourceFiles: true, action: 'delete' };
        const seeding = (enforced: boolean) => ({ sets: [{ client: 'qBittorrent', clientType: 'qBittorrent', endpoint: 'qbit.example:8080', rules: [rule] }], dryRun: false, enforced, ignored: [] });
        const cleanuparr = (enforced: boolean) => ({ id: 'cleanuparr', type: 'cleanuparr', getSeedingRules: async () => seeding(enforced) }) as unknown as ServiceAdapter;
        const qbit = { id: 'qbittorrent', type: 'qbittorrent', endpoint: 'qbit.example:8080', getSeedLimits: async () => ({ service: 'qbittorrent', action: 'stop' }) } as unknown as ServiceAdapter;
        const radarr = { id: 'radarr', type: 'radarr', getSeedCriteria: async () => [{ service: 'radarr', indexer: 'Tracker A' }, { service: 'radarr', indexer: 'Tracker B' }] } as unknown as ServiceAdapter;

        const covered = await buildSeedingRules([cleanuparr(true), qbit, radarr], () => {});
        expect(covered.notes.filter(n => n.includes('Tracker'))).toEqual([
            '"Tracker A", "Tracker B" set no seed ratio or time and no torrent client has a default limit, ' +
                "so Cleanuparr's rules are the only limit. A torrent in a category no rule covers seeds until someone stops it; " +
                'get_queue at detail "full" says which rule covers each torrent, or why none does.'
        ]);

        const unscheduled = await buildSeedingRules([cleanuparr(false), qbit, radarr], () => {});
        expect(unscheduled.notes.filter(n => n.includes('seed until someone stops them'))).toHaveLength(2);
    });
});

describe('Cleanuparr seeding wording', () => {
    it('says all and none when three Cleanuparr clients point at one client', async () => {
        const set = (client: string) => ({ client, clientType: 'Transmission', endpoint: 'transmission.example:9091', rules: [] });
        const cleanuparr = { id: 'cleanuparr', type: 'cleanuparr', getSeedingRules: async () => ({ sets: [set('A'), set('B'), set('C')], dryRun: false, enforced: true, ignored: [] }) } as unknown as ServiceAdapter;
        const transmission = { id: 'transmission', type: 'transmission', endpoint: 'transmission.example:9091' } as unknown as ServiceAdapter;
        const rules = await buildSeedingRules([cleanuparr, transmission], () => {});
        expect(rules.notes).toContain("Cleanuparr's clients \"A\", \"B\" and \"C\" all point at transmission, so none of their rules are applied to get_queue.");
    });

    it('marks a Cleanuparr rule that is only logged or not scheduled', () => {
        const line = (cleanuparr: object) =>
            queueLine({
                service: 'transmission', id: '1', title: 'Some.Release', status: 'seeding',
                seeding: { ratio: 3, seedingSeconds: 600, overLimit: true, limitSource: 'cleanuparr', cleanuparr: { rule: 'R', action: 'stop', ...cleanuparr } }
            });
        expect(line({})).toMatch(/past Cleanuparr rule "R"$/);
        expect(line({ dryRun: true })).toContain('past Cleanuparr rule "R" (dry run)');
        expect(line({ notEnforced: true })).toContain('past Cleanuparr rule "R" (not scheduled)');
    });
});

describe('stack_health Cleanuparr coverage', () => {
    const rule = (over: object = {}) => ({ id: 'r', name: 'Keep 30 days', priority: 1, categories: ['radarr', 'tv-sonarr', 'cleanuparr-dead'], trackerPatterns: [], tagsAny: [], tagsAll: [], privacy: 'both', maxSeedHours: 720, unsupported: [], deleteSourceFiles: true, action: 'delete', ...over });
    const cleanuparr = (sets: object[], ignored: string[] = []) =>
        ({ id: 'cleanuparr', type: 'cleanuparr', getSeedingRules: async () => ({ sets, dryRun: false, enforced: true, ignored }) }) as unknown as ServiceAdapter;
    const set = (over: object = {}) => ({ client: 'qBittorrent VPN', clientType: 'qBittorrent', endpoint: '192.0.2.10:8081', rules: [rule()], targetCategories: ['cleanuparr-dead'], ...over });
    const torrent = (n: number, category: string) => ({ ...finished, hash: n.toString(16).padStart(40, '0'), category });

    it('counts the torrents no rule covers, by why, and names the categories', async () => {
        const torrents = [
            ...Array.from({ length: 45 }, (_, i) => torrent(i, '')),
            torrent(100, 'cross-seed'),
            torrent(101, 'cross-seed'),
            torrent(102, 'books'),
            torrent(103, 'radarr'),
            torrent(104, 'linux')
        ];
        const rules = await buildSeedingRules([cleanuparr([set()], ['linux']), qbit(torrents)], () => {});
        expect(rules.coverage).toEqual([{ service: 'qbittorrent', torrents: 50, uncovered: 48, ignored: 1 }]);
        expect(rules.notes).toContain(
            '48 of 50 torrents on qbittorrent match no Cleanuparr rule, so the Download Cleaner never removes them: ' +
                '45 have no category; give them one a rule covers; ' +
                '3 are in categories no rule names, "cross-seed (2)", "books (1)"; add those to a rule or recategorise the torrents.'
        );
        // cleanuparr-dead is where Dead moves torrents, so its being empty is normal.
        expect(rules.notes).toContain(
            'Cleanuparr\'s rules for qbittorrent name a category no torrent there is in: "tv-sonarr". A typo, or a category renamed in the client, leaves a rule matching nothing.'
        );
        expect(rules.cleanuparr?.[0]).not.toHaveProperty('targetCategories');
    });

    it('says nothing when every torrent is covered, and still reports the count', async () => {
        const rules = await buildSeedingRules([cleanuparr([set({ rules: [rule({ categories: ['radarr'] })] })]), qbit([torrent(1, 'radarr')])], () => {});
        expect(rules.coverage).toEqual([{ service: 'qbittorrent', torrents: 1, uncovered: 0 }]);
        expect(rules.notes.some(n => n.includes('match no Cleanuparr rule') || n.includes('no torrent there'))).toBe(false);
    });

    it('names a torrent client Cleanuparr does not know, and a Cleanuparr client that does nothing', async () => {
        const rules = await buildSeedingRules([cleanuparr([set({ endpoint: 'elsewhere.example:8080', rules: [], modulesOff: true })]), qbit([])], () => {});
        expect(rules.notes.some(n => n.startsWith('qbittorrent is not a download client in Cleanuparr') && n.includes('192.0.2.10:8081') && n.includes('Unlinked, Dead and Orphaned'))).toBe(true);
        expect(rules.notes).toContain('Cleanuparr\'s client "qBittorrent VPN" has no seeding rules and Unlinked, Dead and Orphaned are all off, so the Download Cleaner does nothing with it.');
        expect(rules.cleanuparr?.[0]).not.toHaveProperty('modulesOff');
        expect(rules.coverage).toBeUndefined();
    });

    it('says a client with no rules removes nothing, even with its other modules on', async () => {
        const rules = await buildSeedingRules([cleanuparr([set({ rules: [] })]), qbit([torrent(1, 'radarr')])], () => {});
        expect(rules.notes).toContain('Cleanuparr\'s client "qBittorrent VPN" has no seeding rules, so the Download Cleaner never removes its torrents.');
        expect(rules.coverage).toBeUndefined();
    });

    it('marks the client degraded and keeps the rest when its torrents cannot be read', async () => {
        const down = new QbittorrentAdapter(credentials(8081), serving({}));
        const degraded: string[] = [];
        const rules = await buildSeedingRules([cleanuparr([set()]), down], id => degraded.push(id));
        expect(degraded).toContain('qbittorrent');
        expect(rules.coverage).toBeUndefined();
        expect(rules.cleanuparr?.[0]?.service).toBe('qbittorrent');
    });

    it('reads categories from the download dir on Transmission', async () => {
        const sets = [set({ clientType: 'Transmission', endpoint: '192.0.2.10:9091', rules: [rule({ categories: ['tv'] })], targetCategories: [] })];
        const torrents = [{ ...seeded, hashString: 'b'.repeat(40), downloadDir: '/downloads/tv/' }, { ...seeded, id: 4, hashString: 'c'.repeat(40), downloadDir: '/downloads/books' }];
        const rules = await buildSeedingRules([cleanuparr(sets), transmission(torrents)], () => {});
        expect(rules.coverage).toEqual([{ service: 'transmission', torrents: 2, uncovered: 1 }]);
        expect(rules.notes.some(n => n.includes('"books (1)"'))).toBe(true);
    });

    it('stays within its token budget with 500 torrents in 500 categories', async () => {
        const torrents = Array.from({ length: 500 }, (_, i) => torrent(i, `category-${i}`));
        const sets = [set({ rules: Array.from({ length: 50 }, (_, i) => rule({ id: `r${i}`, priority: i, categories: Array.from({ length: 20 }, (_, j) => `rule-${i}-${j}`) })) })];
        const result = await buildStackHealth([cleanuparr(sets), qbit(torrents)], { detail: 'full', limit: 500 });
        const coverage = result.seedingRules?.notes.filter(n => n.includes('match no Cleanuparr rule') || n.includes('no torrent there')) ?? [];
        expect(coverage).toHaveLength(2);
        expect(coverage.every(n => n.length < 600)).toBe(true);
        expectWithinBudget(result, 40_000);
    });
});
