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

/**
 * A service behind a URL base — the standard arrangement behind a reverse proxy,
 * and what the arr apps themselves call "URL Base". Every adapter path is
 * absolute, and `new URL('/api/...', 'http://host/bazarr')` *discards* the base
 * path, so the request landed at the host root and came back as the HTML app.
 */
describe('ServiceHttp with a url base', () => {
    const capture = (url: string) => {
        const seen: string[] = [];
        const client = new ServiceHttp(
            'bazarr',
            { ...config, url },
            apiKeyHeader('X-Api-Key', 'secret'),
            (async (input: string) => {
                seen.push(String(input));
                return json({ ok: true });
            }) as unknown as typeof fetch
        );
        return { client, seen };
    };

    it('keeps the base path in front of the adapter path', async () => {
        const { client, seen } = capture('http://bazarr:6767/bazarr');
        await client.get('/api/system/status');
        expect(seen[0]).toBe('http://bazarr:6767/bazarr/api/system/status');
    });

    it('does not double the slash when the base url ends in one', async () => {
        const { client, seen } = capture('http://bazarr:6767/bazarr/');
        await client.get('/api/system/status');
        expect(seen[0]).toBe('http://bazarr:6767/bazarr/api/system/status');
    });

    it('still keeps the query string the adapter asked for', async () => {
        const { client, seen } = capture('http://sab:8080/sabnzbd');
        await client.get('/api?mode=version&output=json');
        expect(seen[0]).toBe('http://sab:8080/sabnzbd/api?mode=version&output=json');
    });

    it('leaves a base url with no path alone', async () => {
        const { client, seen } = capture('http://192.168.1.20:7878');
        await client.get('/api/v3/system/status');
        expect(seen[0]).toBe('http://192.168.1.20:7878/api/v3/system/status');
    });

    it('names the full path, base included, when the response is not JSON', async () => {
        const client = new ServiceHttp(
            'bazarr',
            { ...config, url: 'http://bazarr:6767/bazarr' },
            apiKeyHeader('X-Api-Key', 'secret'),
            (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
        );
        await expect(client.get('/api/system/status')).rejects.toThrow(
            'response from /bazarr/api/system/status was not valid JSON'
        );
    });
});

/**
 * `put`'s `discardBody` and `deleteWithBody` had no direct test at all, and the
 * adapter suites cannot supply one: their fake fetch answers every PUT with an
 * empty 200 regardless, which makes `put(path, body, true)` and
 * `put(path, body)` indistinguishable there. So a dropped `true` at a call site
 * — the exact trap `put`'s own comment names, a successful empty-200 write
 * turning into "response was not valid JSON" — would reach production green.
 * These are the tests that can tell the two apart.
 */
describe('ServiceHttp put and deleteWithBody', () => {
    const emptyOk = () => new Response('', { status: 200 });

    it('sends a PUT with a JSON body to the given path', async () => {
        const seen: { url: string; method?: string; body?: unknown; contentType: string | null }[] = [];
        const client = http(async (input: string, init?: RequestInit) => {
            seen.push({
                url: String(input),
                ...(init?.method === undefined ? {} : { method: init.method }),
                body: init?.body,
                contentType: new Headers(init?.headers).get('content-type')
            });
            return emptyOk();
        });

        await client.put('/api/v3/episode/monitor', { episodeIds: [11], monitored: false }, true);
        expect(seen[0]?.method).toBe('PUT');
        expect(seen[0]?.url).toBe('http://192.168.1.20:7878/api/v3/episode/monitor');
        expect(seen[0]?.contentType).toBe('application/json');
        expect(seen[0]?.body).toBe(JSON.stringify({ episodeIds: [11], monitored: false }));
    });

    it('tolerates the empty 200 a successful write actually returns, when told to discard', async () => {
        const client = http(async () => emptyOk());
        await expect(client.put('/api/v3/episode/monitor', {}, true)).resolves.toBeUndefined();
    });

    it('turns that same empty 200 into an error when the flag is dropped', async () => {
        // Not a curiosity: this is what a call site forgetting `true` does to a
        // write that in fact succeeded.
        const client = http(async () => emptyOk());
        await expect(client.put('/api/v3/episode/monitor', {})).rejects.toThrow(/not valid JSON/);
    });

    it('parses the body when not told to discard it', async () => {
        const client = http(async () => json({ id: 7, monitored: false }));
        expect(await client.put('/api/v3/series/7', { monitored: false })).toEqual({ id: 7, monitored: false });
    });

    it('discards a body that is there, rather than returning it, when told to', async () => {
        const client = http(async () => json({ id: 7 }));
        await expect(client.put('/api/v3/series/7', {}, true)).resolves.toBeUndefined();
    });

    it('never auto-retries a PUT — a retried write is a second write', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            throw timeoutError();
        });
        await expect(client.put('/x', {}, true)).rejects.toThrow(/timed out/);
        expect(calls).toBe(1);
    });

    it('sends deleteWithBody as a DELETE carrying the body, and discards the response', async () => {
        const seen: { method?: string; url: string; body?: unknown }[] = [];
        const client = http(async (input: string, init?: RequestInit) => {
            seen.push({ url: String(input), ...(init?.method === undefined ? {} : { method: init.method }), body: init?.body });
            return emptyOk();
        });

        await expect(
            client.deleteWithBody('/api/v3/episodefile/bulk', { episodeFileIds: [102, 103] })
        ).resolves.toBeUndefined();
        expect(seen[0]?.method).toBe('DELETE');
        expect(seen[0]?.url).toBe('http://192.168.1.20:7878/api/v3/episodefile/bulk');
        expect(seen[0]?.body).toBe(JSON.stringify({ episodeFileIds: [102, 103] }));
    });

    it('maps a failing deleteWithBody to a ServiceError rather than resolving', async () => {
        const client = http(async () => json({ message: 'nope' }, 404));
        await expect(client.deleteWithBody('/api/v3/episodefile/bulk', { episodeFileIds: [1] })).rejects.toThrow(
            /not found/i
        );
    });

    it('sends a PATCH to the given path and discards the response', async () => {
        const seen: { method?: string; url: string }[] = [];
        const client = http(async (input: string, init?: RequestInit) => {
            seen.push({ url: String(input), ...(init?.method === undefined ? {} : { method: init.method }) });
            return emptyOk();
        });

        await expect(client.patch('/api/movies/subtitles?radarrid=1')).resolves.toBeUndefined();
        expect(seen[0]?.method).toBe('PATCH');
        expect(seen[0]?.url).toBe('http://192.168.1.20:7878/api/movies/subtitles?radarrid=1');
    });

    it('never auto-retries a PATCH — it is a write', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            throw timeoutError();
        });
        await expect(client.patch('/x')).rejects.toThrow(/timed out/);
        expect(calls).toBe(1);
    });

    it('never auto-retries a deleteWithBody either', async () => {
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            throw timeoutError();
        });
        await expect(client.deleteWithBody('/x', {})).rejects.toThrow(/timed out/);
        expect(calls).toBe(1);
    });
});

/**
 * A release search runs tens of seconds against a real Radarr/Sonarr — well
 * past the 10s default this config carries. `get`'s optional `timeoutMs`
 * exists so one caller can ask for longer without raising the adapter-wide
 * timeout, which would make every other call on a dead service wait just as
 * long. These assert the override reaches `AbortSignal.timeout` and that
 * every other call — including a plain `get` — still gets the configured
 * default.
 */
describe('ServiceHttp per-call timeout override', () => {
    it('passes an override through to AbortSignal.timeout', async () => {
        const spy = vi.spyOn(AbortSignal, 'timeout');
        try {
            const client = http(async () => json({ ok: true }));
            await client.get('/x', { timeoutMs: 120_000 });
            expect(spy).toHaveBeenCalledWith(120_000);
        } finally {
            spy.mockRestore();
        }
    });

    it('falls back to the configured timeout when no override is given', async () => {
        const spy = vi.spyOn(AbortSignal, 'timeout');
        try {
            const client = http(async () => json({ ok: true }));
            await client.get('/x');
            expect(spy).toHaveBeenCalledWith(config.timeout_ms);
        } finally {
            spy.mockRestore();
        }
    });

    it('leaves every other verb at the configured default', async () => {
        const spy = vi.spyOn(AbortSignal, 'timeout');
        try {
            const client = http(async () => json({ ok: true }));
            await client.post('/x', { a: 1 });
            await client.put('/x', { a: 1 }, true);
            await client.delete('/x');
            for (const call of spy.mock.calls) expect(call[0]).toBe(config.timeout_ms);
        } finally {
            spy.mockRestore();
        }
    });

    it('applies the override to the retry attempt too', async () => {
        const spy = vi.spyOn(AbortSignal, 'timeout');
        let calls = 0;
        try {
            const client = http(async () => {
                calls += 1;
                if (calls === 1) throw timeoutError();
                return json({ ok: true });
            });
            await client.get('/x', { timeoutMs: 120_000 });
            expect(spy.mock.calls.map(c => c[0])).toEqual([120_000, 120_000]);
        } finally {
            spy.mockRestore();
        }
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

    it('does not count a 404 towards it — a missing id is not a sick service', async () => {
        // Looking up ids that do not exist is an ordinary per-request outcome,
        // not evidence the service is failing. Counting them meant five such
        // lookups in a row made a perfectly healthy Radarr unreachable for the
        // whole cooldown, including for the calls that would have worked.
        let calls = 0;
        const client = http(async () => {
            calls += 1;
            return json({ message: 'not found' }, 404);
        });

        for (let i = 0; i < 6; i += 1) {
            await expect(client.get(`/api/v3/movie/${i}`)).rejects.toThrow(/not found/i);
        }
        expect(calls).toBe(6);
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

describe('ServiceHttp body encoding and response reading', () => {
    it('sends form fields as urlencoded, not as JSON', async () => {
        let seen: { type: string | null; body: string } | undefined;
        const client = http(async (_i: string, init?: RequestInit) => {
            seen = {
                type: new Headers(init?.headers).get('content-type'),
                body: (init?.body as string) ?? ''
            };
            return new Response('', { status: 200 });
        });

        await client.postForm('/api/v2/torrents/delete', { hashes: 'abc', deleteFiles: 'true' }, true);
        expect(seen?.type).toBe('application/x-www-form-urlencoded');
        expect(Object.fromEntries(new URLSearchParams(seen?.body ?? ''))).toEqual({
            hashes: 'abc',
            deleteFiles: 'true'
        });
    });

    it('still sends JSON bodies as JSON', async () => {
        let seen: string | null | undefined;
        const client = http(async (_i: string, init?: RequestInit) => {
            seen = new Headers(init?.headers).get('content-type');
            return json({ ok: true });
        });

        await client.post('/api/v3/command', { name: 'RefreshMovie' });
        expect(seen).toBe('application/json');
    });

    it('reads a bare string body without trying to parse it as JSON', async () => {
        const client = http(async () => new Response('v5.0.4\n', { status: 200 }));
        expect(await client.getText('/api/v2/app/version')).toBe('v5.0.4');
    });

    it('awaits an async recovery before replaying the request', async () => {
        let calls = 0;
        const auth = {
            id: 'async-test',
            apply: () => undefined,
            recover: async (response: Response) => {
                if (response.status !== 403) return false;
                await Promise.resolve();
                return calls === 1;
            }
        };
        const client = http(async () => {
            calls += 1;
            return calls === 1 ? new Response('', { status: 403 }) : json({ ok: true });
        }, auth);

        expect(await client.get('/api/v2/app/version')).toEqual({ ok: true });
        expect(calls).toBe(2);
    });
});

describe('ServiceHttp recovery failures', () => {
    it('cancels the failed response body when recover throws', async () => {
        let cancelled = false;
        const failed = new Response('denied', { status: 403 });
        // Spying on the real body stream: `discard` calls `body.cancel()`, and
        // an uncancelled body is what pins the connection.
        const original = failed.body?.cancel.bind(failed.body);
        if (failed.body !== null) {
            failed.body.cancel = async (reason?: unknown) => {
                cancelled = true;
                return original?.(reason);
            };
        }

        const boom = new Error('login refused');
        const client = http(async () => failed, {
            id: 'test-throw',
            apply: () => {},
            recover: async () => {
                throw boom;
            }
        });

        await expect(client.get('/api/v3/system/status')).rejects.toBe(boom);
        expect(cancelled).toBe(true);
    });

    it('still discards an error response when recover declines', async () => {
        let cancelled = false;
        const failed = new Response('denied', { status: 403 });
        const original = failed.body?.cancel.bind(failed.body);
        if (failed.body !== null) {
            failed.body.cancel = async (reason?: unknown) => {
                cancelled = true;
                return original?.(reason);
            };
        }

        const client = http(async () => failed, { id: 'test-decline', apply: () => {}, recover: async () => false });

        await expect(client.get('/api/v3/system/status')).rejects.toThrow();
        expect(cancelled).toBe(true);
    });
});
