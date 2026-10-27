import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { hasQueue } from '../src/services/types.ts';

const config: KeyedServiceConfig = {
    url: 'http://192.168.1.20:8686',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const STATUS = { appName: 'Lidarr', version: '3.0.0.1740', instanceName: 'Lidarr', urlBase: '' };

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every pathname it was asked for, so a test can prove which root was used. */
const serving = (routes: Record<string, unknown>, seen: string[] = []) =>
    ((async (input: string) => {
        const path = new URL(String(input)).pathname;
        seen.push(path);
        if (!(path in routes)) return json({ message: 'not found' }, 404);
        return json(routes[path]);
    }) as unknown) as typeof fetch;

const adapter = (routes: Record<string, unknown>, seen?: string[]) => new LidarrAdapter(config, serving(routes, seen));

describe('LidarrAdapter', () => {
    it('is lidarr, single-instance', () => {
        const a = adapter({});
        expect(a.id).toBe('lidarr');
        expect(a.type).toBe('lidarr');
        expect(a.instance).toBeUndefined();
    });

    /**
     * Lidarr never served a v3, so a `/api/v3` here means the root never reached
     * `ServiceHttp` and every shared helper is off by a version.
     */
    it('reads its version from /api/v1, not /api/v3', async () => {
        const seen: string[] = [];
        const version = await adapter({ '/api/v1/system/status': STATUS }, seen).getVersion();

        expect(version).toBe('3.0.0.1740');
        expect(seen).toEqual(['/api/v1/system/status']);
    });

    it('reports a working connection with the version', async () => {
        const diagnosis = await adapter({ '/api/v1/system/status': STATUS }).testConnection();

        expect(diagnosis).toMatchObject({ ok: true, service: 'lidarr', version: '3.0.0.1740' });
    });

    it('reports an unreachable service rather than throwing', async () => {
        const failing = new LidarrAdapter(
            config,
            ((async () => {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }) as unknown) as typeof fetch
        );
        const diagnosis = await failing.testConnection();

        expect(diagnosis.ok).toBe(false);
    });

    /**
     * Every capability interface is structural, so a method is the whole claim.
     * Listing the prototype covers all 46 guards; sampling a few of them stays
     * green when someone adds the one that was not sampled.
     */
    it('adds no method of its own, so it claims no capability', () => {
        const a = adapter({});
        const own = Object.getOwnPropertyNames(LidarrAdapter.prototype).filter(name => name !== 'constructor');

        expect(own.sort()).toEqual(['getVersion', 'testConnection']);
        expect(hasQueue(a)).toBe(false);
    });
});
