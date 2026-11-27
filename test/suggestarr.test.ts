import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SuggestarrAdapter, originOf, originSentence } from '../src/services/suggestarr.ts';
import { automationLine, buildStackHealth } from '../src/tools/stackHealth.ts';

const config = { url: 'http://suggestarr:5000', api_key: 'sarr_1_secret', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };
const fixture = <T = unknown>(name: string): T =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'suggestarr', `${name}.json`), 'utf8')) as T;

type Body = unknown;

/** Answers by path; `seen` records every request with its method and query. */
function stub(routes: Record<string, Body>, seen: string[] = [], status: Record<string, number> = {}): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        const code = status[url.pathname];
        if (code !== undefined) return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: code });
        if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
        const body = routes[url.pathname];
        const value = typeof body === 'function' ? (body as (u: URL) => unknown)(url) : body;
        return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

const routes = (over: Record<string, Body> = {}): Record<string, Body> => ({
    '/api/health': fixture('health'),
    '/api/v1/me': fixture('me'),
    '/api/v1/jobs': fixture('jobs'),
    '/api/v1/runs': fixture('runs'),
    '/api/v1/requests': fixture('requests'),
    '/api/v1/requests/stats': fixture('requests-stats'),
    '/api/v1/installation/stats': fixture('installation-stats'),
    ...over
});

type Requests = { data: { tmdb_id: string; media_type: string; source_media_id: string | null }[] };

describe('SuggestarrAdapter', () => {
    it('sends the key as X-Api-Key and checks it on /api/v1/me', async () => {
        let header: string | null = null;
        const seen: string[] = [];
        const inner = stub(routes(), seen);
        const adapter = new SuggestarrAdapter(config, (async (input: string, init?: RequestInit) => {
            header = new Headers(init?.headers).get('X-Api-Key');
            return inner(input, init);
        }) as unknown as typeof fetch);
        const result = await adapter.testConnection();
        expect(result).toMatchObject({ ok: true, service: 'suggestarr' });
        expect(result.version).toBeUndefined();
        expect(header).toBe('sarr_1_secret');
        expect(seen).toEqual(['GET /api/v1/me']);
    });

    it('names where a key is made when it is refused', async () => {
        const adapter = new SuggestarrAdapter(config, stub(routes(), [], { '/api/v1/me': 401 }));
        const result = await adapter.testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('AuthFailed');
        expect(result.error?.remedy).toContain('Profile → API keys');
    });

    it('refuses to make up a version its API does not report', async () => {
        await expect(new SuggestarrAdapter(config, stub(routes())).getVersion()).rejects.toThrow(/does not report its version/);
    });

    it('reports nothing for the healthy captured instance', async () => {
        expect(await new SuggestarrAdapter(config, stub(routes())).getFailedHealthChecks()).toEqual([]);
    });

    it('reports a failing component, a failed run, disabled jobs and undelivered suggestions', async () => {
        const jobs = fixture<{ data: Record<string, unknown>[] }>('jobs');
        const runs = fixture<{ data: Record<string, unknown>[] }>('runs');
        const stats = fixture<{ data: { queue: Record<string, number> } }>('installation-stats');
        const adapter = new SuggestarrAdapter(
            config,
            stub(
                routes({
                    '/api/health': { ...fixture<object>('health'), seer: 'error', arr: { radarr: 'ok', sonarr: 'unreachable' } },
                    '/api/v1/jobs': { ...jobs, data: jobs.data.map(j => ({ ...j, enabled: false })) },
                    '/api/v1/runs': { ...runs, data: [{ ...runs.data[0], status: 'failed', error_message: 'Seer timed out' }, ...runs.data.slice(1)] },
                    '/api/v1/installation/stats': { data: { ...stats.data, queue: { ...stats.data.queue, failed: 2 } } }
                })
            )
        );
        const checks = await adapter.getFailedHealthChecks();
        expect(checks.map(c => `${c.source}/${c.type}`)).toEqual(['seer/error', 'sonarr/error', 'jobs/warning', 'runs/error', 'queue/warning']);
        expect(checks.find(c => c.source === 'runs')?.message).toContain('Default Automation');
        expect(checks.find(c => c.source === 'runs')?.message).toContain('Seer timed out');
        expect(checks.find(c => c.source === 'queue')?.message).toBe('2 suggestion(s) could not be filed in Seerr');
    });

    it('does not ask a non-admin key for installation stats, which it would be refused', async () => {
        const seen: string[] = [];
        const me = fixture<{ data: object }>('me');
        const adapter = new SuggestarrAdapter(config, stub(routes({ '/api/v1/me': { data: { ...me.data, role: 'user' } } }), seen));
        await adapter.getFailedHealthChecks();
        expect(seen.some(s => s.includes('/installation/stats'))).toBe(false);
    });

    it('reads each job’s limits, and leaves out the ones it takes from the global setting', async () => {
        const overview = await new SuggestarrAdapter(config, stub(routes())).readAutomationOverview();
        expect(overview.requests).toEqual({ today: 0, thisWeek: 8, thisMonth: 8, total: 8 });
        const byName = new Map(overview.jobs.map(j => [j.name, j]));
        const defaults = [...byName.entries()].find(([name]) => name.includes('Default Automation'))?.[1];
        const custom = [...byName.entries()].find(([name]) => name.includes('Automatic Recommendations'))?.[1];
        expect(defaults).toMatchObject({ enabled: true, schedule: '0 0 * * *', maxResults: 20, maxSimilarMovie: 5, maxSimilarTv: 2 });
        expect(defaults?.lastRun).toEqual({ status: 'completed', at: '2026-11-27T00:00:00.247708', requested: 0 });
        expect(custom).toMatchObject({ schedule: 'daily', maxResults: 20 });
        expect(custom?.maxSimilarMovie).toBeUndefined();
        // max_requests_per_user 0 is the guardrail switched off.
        expect(custom?.maxRequestsPerUser).toBeUndefined();
        expect(automationLine(overview)).toContain('up to 5 film(s) and 2 series per watched title');
    });

    it('says when every job is off', () => {
        expect(automationLine({ service: 'suggestarr', jobs: [] })).toBe(' suggestarr has no job enabled, so it requests nothing on its own.');
    });

    it('finds why a title was requested, matched on kind and TMDB id', async () => {
        const row = fixture<Requests>('requests').data.find(r => r.media_type === 'tv' && r.source_media_id !== null);
        if (row === undefined) throw new Error('fixture has no series request');
        const adapter = new SuggestarrAdapter(config, stub(routes()));
        expect(await adapter.readRequestOrigin('series', Number(row.tmdb_id))).toMatchObject({
            service: 'suggestarr',
            reason: 'similar',
            sourceTmdbId: Number(row.source_media_id)
        });
        // TMDB's film and series ids are separate namespaces.
        expect(await adapter.readRequestOrigin('movie', Number(row.tmdb_id))).toBeUndefined();
    });

    it('lists its requests as history, newest first, with the reason', async () => {
        const total = fixture<Requests>('requests').data.length;
        const history = await new SuggestarrAdapter(config, stub(routes())).readHistory({});
        expect(history.total).toBe(total);
        expect(history.items[0]).toMatchObject({ event: 'requested', rawEvent: 'request', at: '2026-11-26T13:01:12.000Z' });
        expect(history.items[0]?.reason).toMatch(/^similar to a watched title \(TMDB \d+\)$/);
        expect(history.items.every((e, i) => i === 0 || Date.parse(e.at) <= Date.parse(history.items[i - 1]?.at ?? ''))).toBe(true);
        expect((await new SuggestarrAdapter(config, stub(routes())).readHistory({ eventType: 'imported' })).items).toEqual([]);
        expect((await new SuggestarrAdapter(config, stub(routes())).readHistory({ since: '2026-11-26T00:00:00Z' })).items.length).toBeLessThan(total);
    });

    it('refuses an id rather than ignoring it', async () => {
        await expect(new SuggestarrAdapter(config, stub(routes())).readHistory({ id: '1' })).rejects.toThrow(/not scoped by an id/);
    });

    it('reads every page of requests', async () => {
        const rows = fixture<Requests>('requests').data;
        const seen: string[] = [];
        const paged = (u: URL) => (u.searchParams.get('page') === '1' ? { data: rows.slice(0, 1), meta: { pages: 2 } } : { data: rows.slice(1), meta: { pages: 2 } });
        const history = await new SuggestarrAdapter(config, stub(routes({ '/api/v1/requests': paged }), seen)).readHistory({});
        expect(history.total).toBe(rows.length);
        expect(seen.filter(s => s.startsWith('GET /api/v1/requests?'))).toHaveLength(2);
    });

    it('only ever sends GETs', async () => {
        const seen: string[] = [];
        const adapter = new SuggestarrAdapter(config, stub(routes(), seen));
        await adapter.testConnection();
        await adapter.getFailedHealthChecks();
        await adapter.readAutomationOverview();
        await adapter.readHistory({});
        expect(seen.every(s => s.startsWith('GET '))).toBe(true);
    });
});

describe('get_stack_health with SuggestArr', () => {
    it('adds the jobs and their limits at full, and a healthy, versionless row', async () => {
        const adapter = new SuggestarrAdapter(config, stub(routes()));
        const full = await buildStackHealth([adapter], { detail: 'full', limit: 50 });
        expect(full.automation?.jobs).toHaveLength(2);
        expect(full.failures.total).toBe(0);
        expect(full.services[0]).toMatchObject({ ok: true, service: 'suggestarr' });
        expect(full.degraded).toEqual([]);
        const standard = await buildStackHealth([new SuggestarrAdapter(config, stub(routes()))], { detail: 'standard', limit: 50 });
        expect(standard.automation).toBeUndefined();
    });
});

describe('a SuggestArr request source', () => {
    it('maps the job tags and keeps a watched title’s id', () => {
        expect(originOf('239618')).toEqual({ reason: 'similar', sourceTmdbId: 239618 });
        expect(originOf(null)).toEqual({ reason: 'discover' });
        expect(originOf('')).toEqual({ reason: 'discover' });
        expect(originOf('list_import')).toEqual({ reason: 'list_import' });
        expect(originOf('trakt_recommendations')).toEqual({ reason: 'trakt' });
        expect(originOf('0')).toEqual({ reason: 'ai' });
        expect(originOf('ai_search')).toEqual({ reason: 'ai' });
        expect(originOf('something-new')).toEqual({ reason: 'unknown' });
    });

    it('reads as one sentence', () => {
        expect(originSentence({ service: 'suggestarr', requestedAt: '', reason: 'discover' })).toBe('suggestarr requested it, from a Discover job.');
    });
});
