import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { TOOL_NAMES } from '../src/tools/register.ts';

const TOKEN = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);

/** In-memory, so these tests never touch a config directory. */
const audit = () => WriteAudit.ephemeral();

const configWith = (over: Record<string, unknown> = {}): Config =>
    ConfigSchema.parse({
        auth: { bearer_token: TOKEN, password_hash: hashPassword('unused-here'), ...over },
        services: {}
    });

const config = configWith();

const appWith = (cfg: Config, adapters: readonly ServiceAdapter[] = []) =>
    buildApp({
        runtime: Runtime.fromConfig(cfg, audit(), { adapters }),
        audit: audit(),
        logs: LogStore.ephemeral()
    });

const app = () => appWith(config);

const rpc = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body)
});

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

/** Parses the JSON-RPC payload out of the SDK's response, which may frame it as SSE. */
const rpcPayload = async (res: Response): Promise<{ result?: Record<string, unknown> }> => {
    const body = await res.text();
    return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as { result?: Record<string, unknown> };
};

describe('GET /healthz', () => {
    it('is reachable without a token — it is a container probe, not an API', async () => {
        const res = await app().request('http://localhost:6060/healthz');
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'ok', name: 'arr-mcp' });
    });
});

describe('bearer auth on /mcp', () => {
    it('rejects a request with no Authorization header', async () => {
        const res = await app().request('http://localhost:6060/mcp', { method: 'POST' });
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer/);
    });

    it('rejects a wrong token', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${WRONG}` })
        );
        expect(res.status).toBe(401);
    });

    it('rejects a token of the wrong length without throwing', async () => {
        const res = await app().request('http://localhost:6060/mcp', rpc(toolsList, { Authorization: 'Bearer short' }));
        expect(res.status).toBe(401);
    });

    it('rejects a non-Bearer scheme', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` })
        );
        expect(res.status).toBe(401);
    });

    it('rejects a bare token with no scheme', async () => {
        const res = await app().request('http://localhost:6060/mcp', rpc(toolsList, { Authorization: TOKEN }));
        expect(res.status).toBe(401);
    });

    it('does not echo the presented token back in the body', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${WRONG}` })
        );
        expect(await res.text()).not.toContain(WRONG);
    });

    it('accepts the configured token and reaches the MCP handler', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${TOKEN}` })
        );

        expect(res.status).toBe(200);
        expect(await res.text()).toContain('stack_health');
    });

    it('guards every method on /mcp, not just POST', async () => {
        for (const method of ['GET', 'DELETE']) {
            const res = await app().request('http://localhost:6060/mcp', { method });
            expect(res.status).toBe(401);
        }
    });
});

describe('the transport stays stateless', () => {
    it('never issues an Mcp-Session-Id header', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${TOKEN}` })
        );
        expect(res.headers.get('Mcp-Session-Id')).toBeNull();
    });

    it('answers a second request without any prior initialize handshake', async () => {
        // Statelessness means each request stands alone: no session to
        // establish, so an identical second call must succeed identically.
        const a = app();
        const first = await a.request('http://localhost:6060/mcp', rpc(toolsList, { Authorization: `Bearer ${TOKEN}` }));
        const second = await a.request(
            'http://localhost:6060/mcp',
            rpc({ ...toolsList, id: 2 }, { Authorization: `Bearer ${TOKEN}` })
        );

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(await second.text()).toContain('stack_health');
    });
});

describe('DNS rebinding protection', () => {
    it('serves requests when no hostnames are pinned', async () => {
        // Regression: the adapter gates its host-validation middleware on
        // `if (allowedHosts)`, and [] is truthy — passing an empty array
        // installs validation with an empty allow-list and 403s everything.
        // A container that rejects 100% of traffic looks healthy until used.
        const res = await app().request('http://192.168.1.50:6060/healthz');
        expect(res.status).toBe(200);
    });

    it('rejects a foreign Host once hostnames are pinned', async () => {
        const pinned = appWith(configWith({ allowed_hosts: ['arr.example.com'] }));

        // Hono's synthetic request helper does not derive a Host header from
        // the URL, so set it explicitly — the validator reads the header, not
        // the URL, and treats a missing one as invalid.
        const allowed = await pinned.request('http://arr.example.com:6060/healthz', {
            headers: { Host: 'arr.example.com:6060' }
        });
        const foreign = await pinned.request('http://evil.example.com:6060/healthz', {
            headers: { Host: 'evil.example.com:6060' }
        });

        expect(allowed.status).toBe(200); // port-agnostic match on the hostname
        expect(foreign.status).toBe(403);
    });
});

describe('the advertised tool surface', () => {
    const listTools = async (): Promise<{ name: string; description?: string }[]> => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${TOKEN}` })
        );
        const body = await res.text();
        const payload = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as {
            result: { tools: { name: string; description?: string }[] };
        };
        return payload.result.tools;
    };

    /**
     * Design spec §18: the tool surface is the public API, and renaming one
     * breaks users' saved prompts **silently** — the model stops finding the
     * tool rather than raising an error. This asserts the exact set, so any
     * change to it has to be deliberate enough to edit a test.
     */
    it('exposes exactly the frozen surface, no more and no fewer', async () => {
        expect((await listTools()).map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    });

    it('registers every tool even when its service is not configured', async () => {
        // Nothing is configured in this test app. Hiding a tool would make the
        // surface depend on config, so a model that learned a tool exists must
        // not find it missing after an edit.
        expect(await listTools()).toHaveLength(TOOL_NAMES.length);
    });

    it('gives every tool a description, which is the only documentation a model reads', async () => {
        const undocumented = (await listTools()).filter(t => (t.description ?? '').length < 40);
        expect(undocumented.map(t => t.name)).toEqual([]);
    });
});

describe('a thrown ServiceError reaches the client with its remedy', () => {
    const radarrConfig = {
        url: 'http://192.0.2.10:7878',
        api_key: 'k',
        timeout_ms: 10_000,
        permissions: { safe_write: false, destructive: false }
    };

    /**
     * This is the exact path a live tool call takes: registerGetMediaDetails
     * throws a ServiceError, the MCP SDK's own dispatch loop catches it and
     * builds the tool result from `error.message` alone
     * (`@modelcontextprotocol/server`'s `createToolError`) — it never calls
     * `toModelText()`. A remedy that does not reach `.message` is dropped here,
     * not in application code, which is why the fix has to live in the error
     * class rather than in a tool-layer catch.
     */
    it('surfaces the remedy for an auth failure through get_media_details', async () => {
        const unauthorized: typeof fetch = async () =>
            new Response(JSON.stringify({ message: 'Unauthorized' }), {
                status: 401,
                headers: { 'content-type': 'application/json' }
            });
        const withRadarr = appWith(config, [new RadarrAdapter(radarrConfig, unauthorized)]);

        const callTool = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'get_media_details', arguments: { service: 'radarr', id: '42', detail: 'standard', limit: 50 } }
        };
        const res = await withRadarr.request(
            'http://localhost:6060/mcp',
            rpc(callTool, { Authorization: `Bearer ${TOKEN}` })
        );

        const payload = await rpcPayload(res);
        const result = payload.result as { isError?: boolean; content?: { type: string; text: string }[] };
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/API key is wrong/i);
    });

    /**
     * The reported bug, reproduced end to end: a request for a Radarr id that
     * does not exist. Confirmed live against the published 0.3.1 container as
     * `radarr not found: HTTP 404 at /api/v3/movie/999999` with no remedy at
     * all. With both fixes in, the model is told a remedy, and the right one —
     * a missing id, not a misconfigured base URL.
     */
    it('tells the model to check the id, not the base URL, for a 404 on a nonexistent Radarr id', async () => {
        const notFound: typeof fetch = async () =>
            new Response(JSON.stringify({ message: 'NotFound' }), {
                status: 404,
                headers: { 'content-type': 'application/json' }
            });
        const withRadarr = appWith(config, [new RadarrAdapter(radarrConfig, notFound)]);

        const callTool = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'get_media_details',
                arguments: { service: 'radarr', id: '999999', detail: 'standard', limit: 50 }
            }
        };
        const res = await withRadarr.request(
            'http://localhost:6060/mcp',
            rpc(callTool, { Authorization: `Bearer ${TOKEN}` })
        );

        const payload = await rpcPayload(res);
        const result = payload.result as { isError?: boolean; content?: { type: string; text: string }[] };
        const text = result.content?.[0]?.text ?? '';
        expect(result.isError).toBe(true);
        expect(text).toContain('HTTP 404 at /api/v3/movie/999999');
        expect(text).not.toMatch(/base path/i);
        expect(text).toMatch(/id/i);
    });
});

/**
 * The bet this whole phase rests on: client support for prompts and resources
 * is uneven, and arr-mcp has to work on all of them. So a client that surfaces
 * neither must be exactly as capable as before. Too central to leave resting on
 * it being obvious.
 */
describe('prompts and resources, beside the tools rather than instead of them', () => {
    const list = async (method: string): Promise<Record<string, unknown>> => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc({ jsonrpc: '2.0', id: 1, method }, { Authorization: `Bearer ${TOKEN}` })
        );
        return (await rpcPayload(res)).result ?? {};
    };

    it('advertises the five prompts', async () => {
        const { prompts } = (await list('prompts/list')) as { prompts: { name: string }[] };
        expect(prompts.map(p => p.name).sort()).toEqual([
            'best_in_library',
            'what_to_watch',
            'whats_new',
            'whats_wrong',
            'why_not_playable'
        ]);
    });

    it('advertises the three resources', async () => {
        const { resources } = (await list('resources/list')) as { resources: { uri: string }[] };
        expect(resources.map(r => r.uri).sort()).toEqual([
            'arr://health',
            'arr://instances',
            'arr://library/summary'
        ]);
    });

    /**
     * Nineteen, unchanged. 0.9 extended three existing tools and added none —
     * `CONTRIBUTING.md` calls the count a hard constraint because accuracy
     * degrades past roughly forty, and a phase that quietly spent four of that
     * budget on convenience would be the wrong trade.
     */
    /**
     * The count is asserted against TOOL_NAMES rather than a literal, because a
     * literal in a test is a second place the number lives and the two drift.
     * `CONTRIBUTING.md` caps this near forty — accuracy degrades past it — so
     * the guard that matters is the ceiling, not the exact figure.
     */
    it('advertises exactly the frozen tool list, well inside the ceiling', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${TOKEN}` })
        );
        const { result } = (await rpcPayload(res)) as { result: { tools: unknown[] } };
        expect(result.tools).toHaveLength(TOOL_NAMES.length);
        expect(TOOL_NAMES.length).toBeLessThan(40);
    });
});
