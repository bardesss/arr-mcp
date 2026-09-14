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

    it('returns the job id from a sync trigger, sent as a POST', async () => {
        let method: string | undefined;
        const adapter = new ProfilarrAdapter(
            config,
            (async (input: string, init?: RequestInit) => {
                method = init?.method;
                const path = new URL(input).pathname;
                if (path === '/api/v1/databases/3/sync') {
                    return new Response(JSON.stringify({ jobId: 42 }), { status: 202 });
                }
                return new Response('not found', { status: 404 });
            }) as unknown as typeof fetch
        );
        expect(await adapter.triggerSync(3)).toBe(42);
        expect(method).toBe('POST');
    });

    it('polls a job to a terminal state rather than trusting the 202', async () => {
        const statuses = ['queued', 'running', 'success'];
        let call = 0;
        const adapter = new ProfilarrAdapter(config, (async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === '/api/v1/databases/3/sync') return new Response(JSON.stringify({ jobId: 9 }), { status: 202 });
            if (path === '/api/v1/jobs/9')
                return new Response(JSON.stringify({ id: 9, status: statuses[Math.min(call++, 2)] }), { status: 200 });
            return new Response('not found', { status: 404 });
        }) as typeof fetch);
        expect(await adapter.triggerSync(3)).toBe(9);
        expect(await adapter.jobStatus(9)).toBe('queued');
    });

    it('reads job status from the `status` field', async () => {
        const adapter = new ProfilarrAdapter(config, stub({
            '/api/v1/jobs/7': {
                id: 7,
                jobType: 'pcd.sync',
                status: 'running',
                source: 'manual',
                createdAt: '2026-09-14T00:00:00Z',
                startedAt: null,
                finishedAt: null,
                result: null
            }
        }));
        expect(await adapter.jobStatus(7)).toBe('running');
    });

    it('lists configured arrs by id, name, type and url', async () => {
        const adapter = new ProfilarrAdapter(config, stub({
            '/api/v1/arr': [{ id: 1, name: 'Sonarr', type: 'sonarr', url: 'http://sonarr:8989', enabled: true }]
        }));
        expect(await adapter.listArrs()).toEqual([{ id: 1, name: 'Sonarr', type: 'sonarr', url: 'http://sonarr:8989' }]);
    });
});
