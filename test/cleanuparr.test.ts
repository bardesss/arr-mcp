import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CleanuparrAdapter } from '../src/services/cleanuparr.ts';

const config = { url: 'http://cleanuparr:11011', api_key: 'k', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };
const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'cleanuparr', `${name}.json`), 'utf8'));

export function stub(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(routes[url.pathname]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

describe('CleanuparrAdapter', () => {
    it('reads the version from /api/status and drops the build part', async () => {
        const adapter = new CleanuparrAdapter(config, stub({ '/api/status': fixture('status') }));
        expect(await adapter.getVersion()).toBe('2.10.9');
    });

    it('sends the key as X-Api-Key', async () => {
        let header: string | null = null;
        const adapter = new CleanuparrAdapter(config, (async (_: string, init?: RequestInit) => {
            header = new Headers(init?.headers).get('X-Api-Key');
            return new Response(JSON.stringify(fixture('status')), { status: 200 });
        }) as unknown as typeof fetch);
        await adapter.getVersion();
        expect(header).toBe('k');
    });

    it('refuses a version below the floor in testConnection', async () => {
        const adapter = new CleanuparrAdapter(config, stub({ '/api/status': { application: { version: '2.9.0.0' } } }));
        const result = await adapter.testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('VersionUnsupported');
    });
});

const healthRoutes = (over: Record<string, unknown> = {}) => ({
    '/api/status': fixture('status'),
    '/health/detailed': fixture('health-detailed'),
    '/api/status/arrs': fixture('status-arrs'),
    '/api/status/download-client': fixture('status-download-client'),
    '/api/jobs': fixture('jobs'),
    '/api/configuration/general': fixture('configuration-general'),
    ...over
});

describe('CleanuparrAdapter health', () => {
    it('reports unhealthy entries, disconnected arrs, dry run and unscheduled cleaners', async () => {
        const adapter = new CleanuparrAdapter(config, stub(healthRoutes()));
        const checks = await adapter.getFailedHealthChecks();
        const messages = checks.map(c => c.message);
        expect(messages.some(m => m.includes('download_clients: 1 download client(s) unreachable'))).toBe(true);
        expect(messages.some(m => m.includes('Radarr') && m.includes('Connection refused'))).toBe(true);
        expect(messages.some(m => /dry run/i.test(m))).toBe(true);
        expect(messages.some(m => m.includes('Queue Cleaner is not scheduled'))).toBe(true);
        expect(messages.some(m => m.includes('Download Cleaner'))).toBe(false);
        expect(checks.every(c => c.service === 'cleanuparr')).toBe(true);
    });

    it('warns on a minor version newer than the tested one', async () => {
        const adapter = new CleanuparrAdapter(config, stub(healthRoutes({ '/api/status': { application: { version: '2.11.0.0' } } })));
        const checks = await adapter.getFailedHealthChecks();
        expect(checks.some(c => c.type === 'warning' && c.message.includes('2.11.0') && c.message.includes('2.10'))).toBe(true);
    });

    it('stays quiet about the version on the tested minor', async () => {
        const adapter = new CleanuparrAdapter(config, stub(healthRoutes()));
        const checks = await adapter.getFailedHealthChecks();
        expect(checks.some(c => c.message.includes('untested'))).toBe(false);
    });

    it('never asks for the download client configuration, which holds passwords', async () => {
        const seen: string[] = [];
        const adapter = new CleanuparrAdapter(config, stub(healthRoutes(), seen));
        await adapter.getFailedHealthChecks();
        expect(seen.some(s => s.includes('/api/configuration/download_client'))).toBe(false);
        expect(seen.every(s => s.startsWith('GET '))).toBe(true);
    });
});

const seedingRoutes = (over: Record<string, unknown> = {}) => ({
    ...healthRoutes(),
    '/api/seeding-rules/77893a81-a4e1-450e-b187-bb0d3ccd4e17': fixture('seeding-rules-transmission'),
    '/api/seeding-rules/0b6f3c1e-2a4d-4f7e-9c8b-1d2e3f4a5b6c': fixture('seeding-rules-qbittorrent'),
    '/api/configuration/download_cleaner': fixture('configuration-download_cleaner'),
    ...over
});

describe('CleanuparrAdapter seeding rules', () => {
    it('maps rules per client, turning -1 into absent and null into unsupported', async () => {
        const adapter = new CleanuparrAdapter(config, stub(seedingRoutes()));
        const seeding = await adapter.getSeedingRules();
        const tr = seeding.sets.find(s => s.clientType === 'Transmission');
        expect(tr?.endpoint).toBe('transmission.example:9091');
        expect(tr?.rules[0]).toMatchObject({ name: 'Public: stop now', privacy: 'public', maxRatio: 0, action: 'stop', unsupported: ['maxInactiveDays'] });
        expect(tr?.rules[0]?.maxSeedHours).toBeUndefined();
        expect(tr?.rules[0]?.minSeedHours).toBeUndefined();
        expect(tr?.rules[0]?.minSeeders).toBeUndefined();
        const qb = seeding.sets.find(s => s.clientType === 'qBittorrent');
        expect(qb?.rules[0]).toMatchObject({ privacy: 'both', maxSeedHours: 48, action: 'delete', unsupported: [] });
        expect(qb?.rules[0]?.maxRatio).toBeUndefined();
    });

    it('reports dry run, enforcement and the merged ignore list', async () => {
        const adapter = new CleanuparrAdapter(config, stub(seedingRoutes()));
        const seeding = await adapter.getSeedingRules();
        expect(seeding.dryRun).toBe(true);
        expect(seeding.enforced).toBe(true);
        expect(seeding.ignored).toEqual(['linux-isos', 'abcdef0123456789abcdef0123456789abcdef01']);
    });

    it('drops blank entries from the ignore list', async () => {
        const cleaner = { ...(fixture('configuration-download_cleaner') as object), ignoredDownloads: ['', '  ', ' keep '] };
        const adapter = new CleanuparrAdapter(config, stub(seedingRoutes({ '/api/configuration/download_cleaner': cleaner })));
        expect((await adapter.getSeedingRules()).ignored).toEqual(['linux-isos', 'keep']);
    });

    it('is not enforced when the Download Cleaner is not scheduled', async () => {
        const jobs = (fixture('jobs') as Array<{ jobType: string; status: string }>).map(j =>
            j.jobType === 'DownloadCleaner' ? { ...j, status: 'Not Scheduled' } : j
        );
        const adapter = new CleanuparrAdapter(config, stub(seedingRoutes({ '/api/jobs': jobs })));
        expect((await adapter.getSeedingRules()).enforced).toBe(false);
    });

    it('maps an action it does not know to unknown', async () => {
        const rules = [{ ...(fixture('seeding-rules-transmission') as object[])[0], action: 'Archive' }];
        const adapter = new CleanuparrAdapter(config, stub(seedingRoutes({ '/api/seeding-rules/77893a81-a4e1-450e-b187-bb0d3ccd4e17': rules })));
        const seeding = await adapter.getSeedingRules();
        expect(seeding.sets.find(s => s.clientType === 'Transmission')?.rules[0]?.action).toBe('unknown');
    });

    it('keeps maxInactiveDays 0 as a limit and drops minSeeders 0', async () => {
        const rules = [{ ...(fixture('seeding-rules-qbittorrent') as object[])[0], maxInactiveDays: 0, minSeeders: 0 }];
        const adapter = new CleanuparrAdapter(config, stub(seedingRoutes({ '/api/seeding-rules/0b6f3c1e-2a4d-4f7e-9c8b-1d2e3f4a5b6c': rules })));
        const rule = (await adapter.getSeedingRules()).sets.find(s => s.clientType === 'qBittorrent')?.rules[0];
        expect(rule?.maxInactiveDays).toBe(0);
        expect(rule?.minSeeders).toBeUndefined();
    });
});
