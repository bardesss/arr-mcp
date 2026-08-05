import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { TOOL_NAMES } from '../src/tools/register.ts';

const TOKEN = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);

const config = ConfigSchema.parse({ auth: { bearer_token: TOKEN }, services: {} });
const app = () => buildApp({ config, adapters: [] });

const rpc = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body)
});

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

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
        const pinned = buildApp({
            config: ConfigSchema.parse({
                auth: { bearer_token: TOKEN, allowed_hosts: ['arr.example.com'] },
                services: {}
            }),
            adapters: []
        });

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
    it('exposes exactly the twelve tools of the frozen surface', async () => {
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
