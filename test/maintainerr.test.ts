import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MaintainerrAdapter, type RawCollection, type RawMember } from '../src/services/maintainerr.ts';
import { ReclaimerrAdapter } from '../src/services/reclaimerr.ts';
import { cleanupSource } from '../src/services/types.ts';
import { cleanupLine } from '../src/tools/stackHealth.ts';

const config = { url: 'http://maintainerr:6246', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };
const fixture = <T = unknown>(name: string): T =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'maintainerr', `${name}.json`), 'utf8')) as T;

type Logs = { totalSize: number; items: { id: number; message: string; timestamp: string; type: number }[] };

const collections = fixture<RawCollection[]>('collections');
const [movies, shows] = collections as [RawCollection, RawCollection];

/**
 * Answers the captured responses by path. The light member list and the
 * content and log routes are per collection, so they answer by its id; any
 * page past the first is empty.
 */
function stub(over: Record<string, unknown> = {}, seen: string[] = []): typeof fetch {
    const routes: Record<string, unknown> = {
        '/api/app/status': fixture('status'),
        '/api/health': fixture('health'),
        '/api/collections': collections,
        '/api/rules/exclusion': fixture('exclusions'),
        [`/api/collections/media?collectionId=${movies.id}`]: fixture('collection-media'),
        [`/api/collections/media?collectionId=${shows.id}`]: fixture('collection-media-show'),
        [`/api/collections/media/${movies.id}/content/1`]: fixture('collection-content'),
        [`/api/collections/media/${shows.id}/content/1`]: fixture('collection-content-show'),
        [`/api/collections/logs/${movies.id}/content/1`]: fixture('collection-logs'),
        [`/api/collections/logs/${shows.id}/content/1`]: { totalSize: 0, items: [] },
        ...over
    };
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        const key = url.pathname === '/api/collections/media' ? `${url.pathname}${url.search}` : url.pathname;
        const later = /\/content\/([2-9]|\d{2,})$/.test(url.pathname);
        if (!(key in routes) && !later) return new Response('{"statusCode":404}', { status: 404 });
        const body = later && !(key in routes) ? { totalSize: 0, items: [] } : routes[key];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

const withCollection = (patch: Partial<RawCollection>): RawCollection[] => [{ ...movies, ...patch }, shows];

describe('MaintainerrAdapter connection', () => {
    it('reads the version from /api/app/status', async () => {
        const adapter = new MaintainerrAdapter(config, stub());
        expect(await adapter.getVersion()).toBe('3.33.0');
        expect((await adapter.testConnection()).ok).toBe(true);
    });

    it('sends no credential by default, and an api_key as X-Api-Key', async () => {
        const headers: (string | null)[] = [];
        const fetchImpl = (async (_input: string, init?: RequestInit) => {
            headers.push(new Headers(init?.headers).get('X-Api-Key'));
            return new Response(JSON.stringify(fixture('status')), { status: 200 });
        }) as unknown as typeof fetch;
        await new MaintainerrAdapter(config, fetchImpl).getVersion();
        await new MaintainerrAdapter({ ...config, api_key: 'proxy-key' }, fetchImpl).getVersion();
        expect(headers).toEqual([null, 'proxy-key']);
    });

    it('refuses a version below the floor, and reports a dead host without throwing', async () => {
        const old = new MaintainerrAdapter(config, stub({ '/api/app/status': { ...fixture<object>('status'), version: '3.32.0' } }));
        expect((await old.testConnection()).error?.kind).toBe('VersionUnsupported');
        const dead = new MaintainerrAdapter(config, (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch);
        expect((await dead.testConnection()).ok).toBe(false);
    });

    it('never reads /api/settings, which answers with every credential Maintainerr holds', async () => {
        const seen: string[] = [];
        const adapter = new MaintainerrAdapter(config, stub({}, seen));
        await adapter.testConnection();
        await adapter.getFailedHealthChecks();
        await adapter.readCleanupOverview(10);
        await adapter.readCleanupStatus('movie', 1386315);
        await adapter.readHistory({ want: 10 });
        expect(seen.some(s => s.includes('/api/settings'))).toBe(false);
    });
});

describe('MaintainerrAdapter health', () => {
    it('is quiet on the captured instance', async () => {
        expect(await new MaintainerrAdapter(config, stub()).getFailedHealthChecks()).toEqual([]);
    });

    it('reports a database Maintainerr says is down', async () => {
        const adapter = new MaintainerrAdapter(config, stub({ '/api/health': { status: 'error', database: 'error' } }));
        const [check] = await adapter.getFailedHealthChecks();
        expect(check).toMatchObject({ service: 'maintainerr', type: 'error' });
        expect(check?.message).toMatch(/database error/);
    });

    it('warns about members whose rules failed to evaluate, which the handler skips, but not manual ones', async () => {
        const [member] = fixture<RawMember[]>('collection-media');
        const media = [
            { ...member, id: 1, ruleEvaluationFailed: true },
            { ...member, id: 2, ruleEvaluationFailed: true, isManual: true }
        ];
        const adapter = new MaintainerrAdapter(config, stub({ [`/api/collections/media?collectionId=${movies.id}`]: media }));
        const checks = await adapter.getFailedHealthChecks();
        expect(checks).toHaveLength(1);
        expect(checks[0]?.message).toMatch(/1 item\(s\) in .*Review candidates.* failed rule evaluation/);
    });
});

describe('MaintainerrAdapter cleanup overview', () => {
    it('lists the captured members with their titles, rules and delete dates', async () => {
        const overview = await new MaintainerrAdapter(config, stub()).readCleanupOverview(10);
        expect(overview.rules).toEqual([
            { id: '1', name: expect.stringContaining('unwatched 30+ days (Movies)'), kind: 'movie', outcome: 'delete', enabled: true },
            { id: '2', name: expect.stringContaining('unwatched 30+ days (TV Shows)'), kind: 'show', outcome: 'delete', enabled: true }
        ]);
        expect(overview.candidates?.total).toBe(2);
        const movie = overview.candidates?.items.find(c => c.kind === 'movie');
        // deleteAfterDays is 0 on the capture, so a member is due at the next handler run.
        expect(movie).toMatchObject({ id: '1:19', scope: 'movie', tmdbId: 1386315, year: 2026, state: 'eligible', operation: 'delete', eligibleAt: '2026-11-17T13:00:00.000Z' });
        expect(movie?.title).toContain('The Runner');
        expect(movie?.title).toContain('<<untrusted:maintainerr.title>>');
        expect(movie?.blockers).toBeUndefined();
        expect(overview.going).toEqual({ count: 2, firstAt: '2026-11-17T13:00:00.000Z' });
        expect(overview.protections).toBe(0);
        expect(overview.autoDelete).toEqual({ enabled: true });
        expect(overview.totals).toEqual({
            candidates: 2,
            reclaimableBytes: (movies.totalSizeBytes ?? 0) + (shows.totalSizeBytes ?? 0),
            reclaimedBytes: (movies.handledMediaSizeBytes ?? 0) + (shows.handledMediaSizeBytes ?? 0),
            reclaimedItems: (movies.handledMediaAmount ?? 0) + (shows.handledMediaAmount ?? 0)
        });
        expect(cleanupLine(overview)).toBe(' maintainerr: 2 cleanup candidate(s), 2 set to go, the first on 2026-11-17.');
    });

    it('still lists a member the content route dropped, by its TMDB id, and says why it has no title', async () => {
        // The captured show collection: one member, and a content page with totalSize 1 and no items.
        const overview = await new MaintainerrAdapter(config, stub()).readCleanupOverview(10);
        const show = overview.candidates?.items.find(c => c.kind === 'series');
        expect(show).toMatchObject({ scope: 'series', tmdbId: 290856, state: 'eligible' });
        expect(show?.title).toContain('TMDB 290856');
        expect(show?.blockers?.join(' ')).toContain('not found on the media server');
    });

    it('dates a member by its collection days and holds back what will not be deleted', async () => {
        const future = new MaintainerrAdapter(config, stub({ '/api/collections': withCollection({ deleteAfterDays: 3650 }) }));
        const movie = (await future.readCleanupOverview(10)).candidates?.items.find(c => c.kind === 'movie');
        expect(movie).toMatchObject({ state: 'scheduled', eligibleAt: new Date(Date.parse('2026-11-17T13:00:00.000Z') + 3650 * 86_400_000).toISOString() });

        const unmonitor = new MaintainerrAdapter(config, stub({ '/api/collections': withCollection({ arrAction: 3 }) }));
        const overview = await unmonitor.readCleanupOverview(10);
        const held = overview.candidates?.items.find(c => c.kind === 'movie');
        expect(held?.state).toBe('disabled');
        expect(held?.eligibleAt).toBeUndefined();
        expect(held?.blockers?.join(' ')).toContain('action is unmonitor');
        expect(overview.rules?.[0]?.outcome).toBe('unmonitor');
        expect(overview.totals?.reclaimableBytes).toBe(shows.totalSizeBytes);
        // The held-back one sorts last.
        expect(overview.candidates?.items.map(c => c.kind)).toEqual(['series', 'movie']);

        const off = new MaintainerrAdapter(config, stub({ '/api/collections': [{ ...movies, isActive: false }, { ...shows, deleteAfterDays: null }] }));
        const both = await off.readCleanupOverview(10);
        expect(both.autoDelete).toEqual({ enabled: false });
        expect(both.going).toEqual({ count: 0 });
        expect(both.candidates?.items.flatMap(c => c.blockers ?? []).join(' ')).toMatch(/inactive.*no days set/);
    });

    it('does not call a member missing from the media server when the title read ran out of pages', async () => {
        const seen: string[] = [];
        // Ten pages the read takes, and a total that says there is an eleventh.
        const pages = Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [
                `/api/collections/media/${movies.id}/content/${i + 1}`,
                { ...fixture<{ items: unknown[] }>('collection-content'), totalSize: 1100, items: [] }
            ])
        );
        const overview = await new MaintainerrAdapter(config, stub(pages, seen)).readCleanupOverview(10);
        expect(seen.filter(s => s.startsWith(`GET /api/collections/media/${movies.id}/content/`))).toHaveLength(10);
        expect(overview.capped).toBe(true);
        const movie = overview.candidates?.items.find(c => c.kind === 'movie');
        expect(movie?.title).toContain('TMDB 1386315');
        expect(movie?.blockers).toBeUndefined();
        expect(movie?.state).toBe('eligible');
        // The show collection's own read finished, so its member keeps the blocker.
        const show = overview.candidates?.items.find(c => c.kind === 'series');
        expect(show?.blockers?.join(' ')).toContain('not found on the media server');
    });

    it('leaves `capped` off a read that reached the end of every collection', async () => {
        expect((await new MaintainerrAdapter(config, stub()).readCleanupOverview(10)).capped).toBeUndefined();
    });

    it('cuts the list to `want` but counts every member', async () => {
        const overview = await new MaintainerrAdapter(config, stub()).readCleanupOverview(1);
        expect(overview.candidates?.items).toHaveLength(1);
        expect(overview.candidates?.total).toBe(2);
        expect(overview.going?.count).toBe(2);
    });

    it('reads every content page the total asks for', async () => {
        const seen: string[] = [];
        const big = { ...fixture<{ items: unknown[] }>('collection-content'), totalSize: 150 };
        await new MaintainerrAdapter(config, stub({ [`/api/collections/media/${movies.id}/content/1`]: big }, seen)).readCleanupOverview(10);
        expect(seen.filter(s => s.startsWith(`GET /api/collections/media/${movies.id}/content/`))).toEqual([
            `GET /api/collections/media/${movies.id}/content/1?size=100&sort=deleteSoonest&sortOrder=asc`,
            `GET /api/collections/media/${movies.id}/content/2?size=100&sort=deleteSoonest&sortOrder=asc`
        ]);
    });
});

describe('MaintainerrAdapter cleanup status', () => {
    it('finds a title by TMDB id in the collections of its kind only', async () => {
        const seen: string[] = [];
        const adapter = new MaintainerrAdapter(config, stub({}, seen));
        const movie = await adapter.readCleanupStatus('movie', 1386315);
        expect(movie.candidates.map(c => c.id)).toEqual(['1:19']);
        expect(movie).toMatchObject({ service: 'maintainerr', protections: [], removals: [] });
        // Only the collection that holds it is looked up on the media server.
        expect(seen.filter(s => s.includes('/content/'))).toEqual([`GET /api/collections/media/${movies.id}/content/1?size=100&sort=deleteSoonest&sortOrder=asc`]);

        expect((await adapter.readCleanupStatus('series', 290856)).candidates.map(c => c.tmdbId)).toEqual([290856]);
        expect((await adapter.readCleanupStatus('series', 1386315)).candidates).toEqual([]);
        expect((await adapter.readCleanupStatus('movie', 1)).candidates).toEqual([]);
    });
});

describe('MaintainerrAdapter history', () => {
    it('reads the media log rows newest first, by what the message says happened', async () => {
        const logs = fixture<Logs>('collection-logs');
        const history = await new MaintainerrAdapter(config, stub()).readHistory({});
        expect(history.total).toBe(logs.items.length);
        const count = (verb: string) => logs.items.filter(l => l.message.startsWith(`${verb} "`)).length;
        expect(history.items.filter(e => e.event === 'deleted')).toHaveLength(count('Successfully handled'));
        expect(history.items.filter(e => e.event === 'scheduled')).toHaveLength(count('Added'));
        expect(history.items.filter(e => e.event === 'unknown' && e.rawEvent === 'Removed')).toHaveLength(count('Removed'));
        const [newest] = history.items;
        const [first] = logs.items;
        expect(newest).toMatchObject({ service: 'maintainerr', id: `1:${first?.id}`, at: first?.timestamp, rawEvent: 'Successfully handled', event: 'deleted' });
        expect(newest?.title).toBe(`<<untrusted:maintainerr.title>>${/"(.*)"/.exec(first?.message ?? '')?.[1]}<</>>`);
        expect(newest?.reason).toContain('rule Review candidates: unwatched 30+ days (Movies)');
    });

    it('filters by event and time, and pages on until `since`', async () => {
        const seen: string[] = [];
        const adapter = new MaintainerrAdapter(config, stub({}, seen));
        const deleted = await adapter.readHistory({ eventType: 'deleted' });
        expect(deleted.items.every(e => e.event === 'deleted')).toBe(true);

        const since = '2026-11-20T00:00:00.000Z';
        const recent = await adapter.readHistory({ since });
        expect(recent.items.length).toBeGreaterThan(0);
        expect(recent.items.every(e => e.at >= since)).toBe(true);
        // The capture holds 102 rows and pages of 100: the first call read on to page 2, the `since` call stopped at page 1.
        expect(seen.filter(s => s.startsWith(`GET /api/collections/logs/${movies.id}/content/2`))).toHaveLength(1);
    });

    it('stops paging once `want` rows are read', async () => {
        const seen: string[] = [];
        const history = await new MaintainerrAdapter(config, stub({}, seen)).readHistory({ want: 5 });
        expect(history.items.length).toBeGreaterThanOrEqual(5);
        expect(seen.some(s => s.includes('/logs/1/content/2'))).toBe(false);
    });

    it('calls a handled row on a collection that does not delete unknown, and an exclusion protected', async () => {
        const logs = {
            totalSize: 2,
            items: [
                { id: 2, timestamp: '2026-11-27T01:00:00.000Z', message: 'Successfully handled "Example"', type: 1, meta: null },
                { id: 1, timestamp: '2026-11-26T01:00:00.000Z', message: 'Added a specific exclusion for "Example"', type: 1, meta: null }
            ]
        };
        const adapter = new MaintainerrAdapter(config, stub({ '/api/collections': withCollection({ arrAction: 4 }), [`/api/collections/logs/${movies.id}/content/1`]: logs }));
        const { items } = await adapter.readHistory({});
        expect(items.map(e => [e.event, e.rawEvent])).toEqual([
            ['unknown', 'Successfully handled'],
            ['protected', 'Added a specific exclusion for']
        ]);
    });

    it('refuses an id, and answers an event it never emits without a request', async () => {
        const seen: string[] = [];
        const adapter = new MaintainerrAdapter(config, stub({}, seen));
        await expect(adapter.readHistory({ id: '1' })).rejects.toThrow(/not scoped by a movie or series id/);
        expect(await adapter.readHistory({ eventType: 'grabbed' })).toEqual({ items: [], total: 0 });
        expect(seen).toEqual([]);
    });
});

describe('which cleanup service answers', () => {
    const reclaimerr = (): ReclaimerrAdapter =>
        new ReclaimerrAdapter(
            { url: 'http://reclaimerr:8000', api_key: 'rcl_x_y', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } },
            stub()
        );
    const maintainerr = (): MaintainerrAdapter => new MaintainerrAdapter(config, stub());

    it('is Reclaimerr when both are configured, whichever order they are in', () => {
        // Reclaimerr answers with protections and removals, which Maintainerr
        // cannot, so it must not lose the slot to the alphabetical order the
        // adapter list arrives in.
        expect(cleanupSource([maintainerr(), reclaimerr()])?.type).toBe('reclaimerr');
        expect(cleanupSource([reclaimerr(), maintainerr()])?.type).toBe('reclaimerr');
    });

    it('is Maintainerr when it is the only one, and nothing when neither is', () => {
        expect(cleanupSource([maintainerr()])?.type).toBe('maintainerr');
        expect(cleanupSource([])).toBeUndefined();
    });
});
