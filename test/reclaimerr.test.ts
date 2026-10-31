import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReclaimerrAdapter } from '../src/services/reclaimerr.ts';

const config = { url: 'http://reclaimerr:8000', api_key: 'rcl_x_y', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };
const fixture = <T = unknown>(name: string): T =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'reclaimerr', `${name}.json`), 'utf8')) as T;

type Page = { items: Record<string, unknown>[] };

/** Answers by path; `seen` records every request with its query. */
function stub(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
        const body = routes[url.pathname];
        const value = typeof body === 'function' ? (body as (u: URL) => unknown)(url) : body;
        return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

const routes = (over: Record<string, unknown> = {}) => ({
    '/api/v1': fixture('discovery'),
    '/api/v1/system': fixture('system'),
    '/api/v1/stats': fixture('stats'),
    '/api/v1/rules': fixture('rules'),
    '/api/v1/candidates': fixture('candidates'),
    '/api/v1/protections': fixture('protections'),
    '/api/v1/events': fixture('events'),
    ...over
});

const readOnly = { granted_scopes: ['candidates:read', 'events:read', 'protections:read', 'rules:read', 'system:read'] };

describe('ReclaimerrAdapter', () => {
    it('reads the version from /api/v1/system', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes()));
        expect(await adapter.getVersion()).toBe(fixture<{ version: string }>('system').version);
    });

    it('sends the token as a bearer', async () => {
        let header: string | null = null;
        const adapter = new ReclaimerrAdapter(config, (async (input: string, init?: RequestInit) => {
            header = new Headers(init?.headers).get('Authorization');
            const path = new URL(input).pathname;
            return new Response(JSON.stringify(path === '/api/v1' ? fixture('discovery') : fixture('system')), { status: 200 });
        }) as unknown as typeof fetch);
        await adapter.getVersion();
        expect(header).toBe('Bearer rcl_x_y');
    });

    it('says which scope is missing instead of calling an endpoint it would be refused', async () => {
        const seen: string[] = [];
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': { granted_scopes: ['candidates:read'] } }), seen));
        const result = await adapter.testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('AuthFailed');
        expect(result.error?.detail).toMatch(/system:read/);
        expect(seen.some(s => s.includes('/api/v1/system'))).toBe(false);
    });

    it('refuses a version below the floor in testConnection', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1/system': { ...fixture<object>('system'), version: '0.5.11' } })));
        const result = await adapter.testConnection();
        expect(result.error?.kind).toBe('VersionUnsupported');
    });
});

describe('ReclaimerrAdapter health', () => {
    it('is quiet on the captured instance with a read-only token', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly })));
        const checks = await adapter.getFailedHealthChecks();
        expect(checks.filter(c => c.source !== 'version')).toEqual([]);
    });

    it('flags missing read scopes and granted write scopes', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': { granted_scopes: ['system:read', 'candidates:manage'] } })));
        const messages = (await adapter.getFailedHealthChecks()).map(c => c.message).join('\n');
        expect(messages).toMatch(/lacks rules:read, events:read, protections:read/);
        expect(messages).toMatch(/also grants candidates:manage/);
    });

    it('reports a candidate whose deletion failed', async () => {
        const [first] = fixture<Page>('candidates').items;
        const failing = { ...first, delete_attempts: 3, last_delete_error: 'Radarr refused the delete' };
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/candidates': { items: [failing], total: 1, page: 1, per_page: 200, total_pages: 1 } })));
        const errors = (await adapter.getFailedHealthChecks()).filter(c => c.type === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toMatch(/after 3 attempt\(s\).*Radarr refused the delete/);
    });

    it('warns when the main media server is missing', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/system': { ...fixture<object>('system'), has_main_media_server: false } })));
        const checks = await adapter.getFailedHealthChecks();
        expect(checks.some(c => /No main media server/.test(c.message))).toBe(true);
    });
});

describe('ReclaimerrAdapter cleanup overview', () => {
    it('names the rules each candidate matched and counts protections', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly })));
        const overview = await adapter.readCleanupOverview(10);
        const captured = fixture<Page>('candidates').items;
        expect(overview.candidates?.total).toBe(captured.length);
        for (const c of overview.candidates?.items ?? []) expect(c.rules.every(r => !r.startsWith('#'))).toBe(true);
        expect(overview.protections).toBe(fixture<Page>('protections').items.filter(p => p.active === true).length);
        expect(overview.rules?.length).toBe(fixture<Page>('rules').items.length);
        expect(overview.autoDelete?.enabled).toBe(fixture<{ auto_delete_task_enabled: boolean }>('stats').auto_delete_task_enabled);
    });

    it('puts the soonest deletion first and the held-back ones last', async () => {
        const [base] = fixture<Page>('candidates').items;
        const items = [
            { ...base, id: 1, auto_delete_state: 'disabled', auto_delete_eligible_at: null },
            { ...base, id: 2, auto_delete_state: 'scheduled', auto_delete_eligible_at: '2026-12-01T00:00:00Z' },
            { ...base, id: 3, auto_delete_state: 'eligible', auto_delete_eligible_at: '2026-10-01T00:00:00Z' },
            { ...base, id: 4, auto_delete_state: 'scheduled', auto_delete_eligible_at: '2026-11-05T00:00:00Z' }
        ];
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/candidates': { items, total: 4, page: 1, per_page: 200, total_pages: 1 } })));
        const overview = await adapter.readCleanupOverview(10);
        expect(overview.candidates?.items.map(c => c.id)).toEqual(['3', '4', '2', '1']);
    });

    it('leaves out what the token cannot read', async () => {
        const seen: string[] = [];
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': { granted_scopes: ['system:read'] } }), seen));
        const overview = await adapter.readCleanupOverview(10);
        expect(overview.candidates).toBeUndefined();
        expect(overview.rules).toBeUndefined();
        expect(seen.some(s => s.includes('/candidates') || s.includes('/rules') || s.includes('/protections'))).toBe(false);
    });

    it('marks a rule deleted since with its id', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/rules': { items: [] } })));
        const overview = await adapter.readCleanupOverview(10);
        for (const c of overview.candidates?.items ?? []) expect(c.rules.every(r => r.startsWith('#'))).toBe(true);
    });
});

describe('ReclaimerrAdapter title status', () => {
    it('filters candidates by TMDB id and protections by the same id', async () => {
        const seen: string[] = [];
        const protections = fixture<Page>('protections').items;
        const target = protections.find(p => typeof p.tmdb_id === 'number' && p.media_type === 'movie');
        expect(target).toBeDefined();
        const tmdb = target?.tmdb_id as number;
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/candidates': { items: [], total: 0, page: 1, per_page: 200, total_pages: 0 } }), seen));
        const status = await adapter.readCleanupStatus('movie', tmdb);
        expect(seen.some(s => s.includes(`/api/v1/candidates?media_type=movie&tmdb_id=${tmdb}`))).toBe(true);
        expect(status.protections.length).toBeGreaterThan(0);
        expect(status.protections.every(p => p.tmdbId === tmdb)).toBe(true);
    });

    it('finds a deletion of that title in the event feed', async () => {
        const [candidate] = fixture<Page>('candidates').items;
        const deleted = {
            id: 'evt-1',
            type: 'candidate.deleted',
            occurred_at: '2026-11-02T02:00:05Z',
            candidate_id: candidate?.id,
            actor: { type: 'system' },
            payload: { schema_version: 1, candidate }
        };
        const events = (u: URL) =>
            u.searchParams.get('event_type') === 'candidate.deleted' ? { items: [deleted], next_cursor: 'evt-1', has_more: false } : { items: [], has_more: false };
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/events': events })));
        const status = await adapter.readCleanupStatus(candidate?.media_type as 'movie', candidate?.tmdb_id as number);
        expect(status.removals).toHaveLength(1);
        expect(status.removals[0]).toMatchObject({ at: '2026-11-02T02:00:05Z', operation: 'delete' });
    });
});

describe('ReclaimerrAdapter history', () => {
    it('maps the captured events newest first, with upstream spelling kept', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly })));
        const { items } = await adapter.readHistory({});
        const captured = fixture<Page>('events').items;
        expect(items).toHaveLength(captured.length);
        expect(items.every(e => e.rawEvent !== undefined && e.rawEvent !== '')).toBe(true);
        expect([...items].sort((a, b) => b.at.localeCompare(a.at))).toEqual(items);
    });

    it('widens the window from a week until it holds what was asked for', async () => {
        const seen: string[] = [];
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/events': { items: [], has_more: false } }), seen));
        await adapter.readHistory({ want: 5 });
        expect(seen.filter(s => s.includes('/api/v1/events'))).toHaveLength(4);
    });

    it('follows the cursor', async () => {
        const seen: string[] = [];
        const page = (u: URL) =>
            u.searchParams.get('cursor') === null
                ? { items: [{ id: 'a', type: 'candidate.scheduled', occurred_at: '2026-10-29T00:00:00Z', payload: {} }], next_cursor: 'a', has_more: true }
                : { items: [{ id: 'b', type: 'candidate.deleted', occurred_at: '2026-10-30T00:00:00Z', payload: {} }], next_cursor: 'b', has_more: false };
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly, '/api/v1/events': page }), seen));
        const { items } = await adapter.readHistory({ since: '2026-10-01' });
        expect(items.map(e => [e.id, e.event])).toEqual([
            ['b', 'deleted'],
            ['a', 'scheduled']
        ]);
        expect(seen.some(s => s.includes('cursor=a'))).toBe(true);
    });

    it('reads nothing for an event type Reclaimerr never emits', async () => {
        const seen: string[] = [];
        const adapter = new ReclaimerrAdapter(config, stub(routes({ '/api/v1': readOnly }), seen));
        expect(await adapter.readHistory({ eventType: 'grabbed' })).toEqual({ items: [], total: 0 });
        expect(seen).toEqual([]);
    });

    it('refuses an id', async () => {
        const adapter = new ReclaimerrAdapter(config, stub(routes()));
        await expect(adapter.readHistory({ id: '1' })).rejects.toThrow(/not scoped by a movie or series id/);
    });
});
