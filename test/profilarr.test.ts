import { describe, expect, it } from 'vitest';
import { ProfilarrAdapter } from '../src/services/profilarr.ts';

const config = { url: 'http://profilarr:6868', api_key: 'k', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };

function stub(routes: Record<string, unknown>): typeof fetch {
    return (async (input: string) => {
        const path = new URL(input).pathname;
        if (!(path in routes)) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

describe('ProfilarrAdapter', () => {
    it('reports drift per arr from /status', async () => {
        const adapter = new ProfilarrAdapter(config, stub({
            '/api/v1/status': {
                version: '2.2.0', uptime: 1, timezone: 'UTC', databases: [],
                arrs: [{ id: 1, name: 'Sonarr', type: 'sonarr', enabled: true, sync: {}, drift: { lastCheckedAt: '2026-09-14T00:00:00Z', drifted: true, details: { qualityProfiles: 2, delayProfiles: 0, mediaManagement: 0 } } }]
            }
        }));
        const status = await adapter.status();
        expect(status.arrs[0]?.drift?.drifted).toBe(true);
        expect(status.arrs[0]?.drift?.details.qualityProfiles).toBe(2);
    });

    it('keeps a null drift null rather than defaulting it to clean', async () => {
        const adapter = new ProfilarrAdapter(config, stub({
            '/api/v1/status': { version: '2.2.0', uptime: 1, timezone: 'UTC', databases: [], arrs: [{ id: 1, name: 'Sonarr', type: 'sonarr', enabled: true, sync: {}, drift: null }] }
        }));
        const status = await adapter.status();
        expect(status.arrs[0]?.drift).toBeNull();
    });

    it('returns the job id from a sync trigger', async () => {
        const adapter = new ProfilarrAdapter(config, stub({ '/api/v1/databases/3/sync': { jobId: 42 } }));
        expect(await adapter.triggerSync(3)).toBe(42);
    });
});
