import { describe, expect, it, vi } from 'vitest';
import type { BaseServiceConfig } from '../src/config/schema.ts';
import { apiKeyHeader, queryParamKey, transmissionRpc } from '../src/core/auth.ts';
import { ServiceHttp } from '../src/core/http.ts';

const config: BaseServiceConfig = {
    url: 'http://192.168.1.20:7878',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const timeoutError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const refusedError = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

const http = (fetchImpl: unknown, auth = apiKeyHeader('X-Api-Key', 'secret')) =>
    new ServiceHttp('radarr', config, auth, fetchImpl as typeof fetch);

describe('ServiceHttp request shaping', () => {
    it('resolves the path against the configured base url', async () => {
        const seen: string[] = [];
        const client = http(async (input: string) => {
            seen.push(String(input));
            return json({ ok: true });
        });
        await client.get('/api/v3/system/status');
        expect(seen[0]).toBe('http://192.168.1.20:7878/api/v3/system/status');
    });

    it('applies the auth strategy to every request', async () => {
        const client = http(async (_input: string, init?: RequestInit) => {
            expect(new Headers(init?.headers).get('X-Api-Key')).toBe('secret');
            return json({});
        });
        await client.get('/api/v3/system/status');
    });

    it('lets a query-parameter strategy put the key in the url', async () => {
        const seen: string[] = [];
        const client = http(
            async (input: string) => {
                seen.push(String(input));
                return json({});
            },
            queryParamKey('apikey', 'secret')
        );
        await client.get('/api?mode=version&output=json');
        expect(seen[0]).toContain('apikey=secret');
        expect(seen[0]).toContain('mode=version');
    });

    it('posts a JSON body with the right content type', async () => {
        const client = http(async (_input: string, init?: RequestInit) => {
            expect(init?.method).toBe('POST');
            expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
            expect(init?.body).toBe(JSON.stringify({ method: 'session-get' }));
            return json({ result: 'success' });
        });
        await client.post('/transmission/rpc', { method: 'session-get' });
    });
});

describe('ServiceHttp error mapping', () => {
    it('maps a 401 to AuthFailed without retrying — auth failure is not transient', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            return json({}, 401);
        });
        await expect(client.get('/api/v3/system/status')).rejects.toThrow(/auth failed/);
        expect(calls).toBe(1);
    });

    it('maps a non-JSON body to UpstreamError naming the path', async () => {
        const client = http(async () => new Response('<html>nope</html>', { status: 200 }));
        await expect(client.get('/api/v3/system/status')).rejects.toThrow(/system\/status/);
    });

    it('maps connection refused to Unreachable', async () => {
        const client = http(async () => {
            throw refusedError();
        });
        await expect(client.get('/api/v3/system/status')).rejects.toThrow(/unreachable/);
    });

    it('never puts a query-string api key into an error message', async () => {
        const client = http(
            async () => json({}, 500),
            queryParamKey('apikey', 'super-secret-key')
        );
        await expect(client.get('/api?mode=queue&output=json')).rejects.toThrow(
            expect.objectContaining({ message: expect.not.stringContaining('super-secret-key') })
        );
    });
});

describe('ServiceHttp retry policy', () => {
    it('retries a read once on timeout, then succeeds', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            if (calls === 1) throw timeoutError();
            return json({ version: '1.0' });
        });
        expect(await client.get('/x')).toEqual({ version: '1.0' });
        expect(calls).toBe(2);
    });

    it('gives up after exactly one retry — reads do not retry forever', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            throw timeoutError();
        });
        await expect(client.get('/x')).rejects.toThrow(/timed out/);
        expect(calls).toBe(2);
    });

    it('never auto-retries a write — a retried add is a double-add', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            throw timeoutError();
        });
        await expect(client.post('/x', {})).rejects.toThrow(/timed out/);
        expect(calls).toBe(1);
    });
});

describe('ServiceHttp circuit breaker', () => {
    it('opens after five consecutive failures and stops calling out', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            throw refusedError();
        });

        for (let i = 0; i < 5; i += 1) {
            await expect(client.get('/x')).rejects.toThrow();
        }
        const callsAfterFive = calls;

        await expect(client.get('/x')).rejects.toThrow(/circuit/i);
        expect(calls).toBe(callsAfterFive);
    });

    it('admits a single trial request after the cooldown', async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            const client = http(async () => {
                calls += 1;
                throw refusedError();
            });

            for (let i = 0; i < 5; i += 1) {
                await expect(client.get('/x')).rejects.toThrow();
            }
            const callsAfterFive = calls;

            vi.advanceTimersByTime(60_001);
            await expect(client.get('/x')).rejects.toThrow(/unreachable/);
            expect(calls).toBe(callsAfterFive + 1);

            // One trial only: the failed trial re-opens the circuit immediately.
            await expect(client.get('/x')).rejects.toThrow(/circuit/i);
            expect(calls).toBe(callsAfterFive + 1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resets the failure count on a success', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            if (calls <= 4) throw refusedError();
            return json({});
        });

        for (let i = 0; i < 4; i += 1) {
            await expect(client.get('/x')).rejects.toThrow();
        }
        await client.get('/x');

        // Four more failures would have opened the circuit had the count not
        // reset; instead the fifth call still reaches the network.
        const failing = http(async () => {
            calls += 1;
            throw refusedError();
        });
        await expect(failing.get('/x')).rejects.toThrow(/unreachable/);

        const before = calls;
        await client.get('/x');
        expect(calls).toBe(before + 1);
    });

    it('keeps the breaker per instance, so one dead service does not stop another', async () => {
        const dead = http(async () => {
            throw refusedError();
        });
        const alive = http(async () => json({ ok: true }));

        for (let i = 0; i < 6; i += 1) {
            await expect(dead.get('/x')).rejects.toThrow();
        }
        expect(await alive.get('/x')).toEqual({ ok: true });
    });
});

describe('ServiceHttp auth recovery', () => {
    it('replays a 409 handshake without consuming the retry budget or the breaker', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            if (calls % 2 === 1) {
                return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': `sid-${calls}` } });
            }
            return json({ result: 'success' });
        }, transmissionRpc({}));

        // Six successful calls, each costing one 409 on this deliberately
        // hostile server. A breaker that counted handshakes would have opened.
        for (let i = 0; i < 6; i += 1) {
            expect(await client.post('/transmission/rpc', { method: 'session-get' })).toEqual({
                result: 'success'
            });
        }
        expect(calls).toBe(12);
    });

    it('does not loop when recovery keeps failing', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': `sid-${calls}` } });
        }, transmissionRpc({}));

        await expect(client.post('/transmission/rpc', {})).rejects.toThrow();
        expect(calls).toBe(2);
    });
});
