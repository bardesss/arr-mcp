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

    it('matches a bracketed IPv6 Host, with and without a port', async () => {
        // Splitting on the first colon to drop the port lands inside the
        // address for `[fd00::1]:6060` and yields "[", so every request 403s —
        // including the config page that is the only way to undo the pin.
        // web/origin.ts already parses this shape correctly.
        const pinned = appWith(configWith({ allowed_hosts: ['[fd00::1]'] }));

        const withPort = await pinned.request('http://[fd00::1]:6060/healthz', { headers: { Host: '[fd00::1]:6060' } });
        const withoutPort = await pinned.request('http://[fd00::1]/healthz', { headers: { Host: '[fd00::1]' } });

        expect(withPort.status).toBe(200);
        expect(withoutPort.status).toBe(200);
    });
});

describe('the advertised tool surface', () => {
    type Advertised = {
        name: string;
        title?: string;
        description?: string;
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    };

    const listTools = async (): Promise<Advertised[]> => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${TOKEN}` })
        );
        const body = await res.text();
        const payload = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as {
            result: { tools: Advertised[] };
        };
        return payload.result.tools;
    };

    /** The nine that can change something. Everything else only reads. */
    const WRITES = [
        'add_media',
        'delete_episode_files',
        'delete_media',
        'delete_request',
        'remove_queue_item',
        'respond_to_request',
        'set_monitoring',
        'trigger_scan',
        'trigger_search'
    ];

    /** Of those nine, the four whose effect cannot be undone by calling again. */
    const DESTRUCTIVE = ['delete_episode_files', 'delete_media', 'delete_request', 'remove_queue_item'];

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

    /**
     * Without `readOnlyHint`, `delete_media` and `get_queue` are the same kind
     * of thing to a client that decides what to auto-approve from annotations —
     * so a surface with nine writes on it reads as either all safe or all
     * dangerous. The hint is the only machine-readable way to tell them apart;
     * the descriptions say so in prose, which nothing but a model can act on.
     */
    it('says which tools only read, so a client can tell the nine writes from the rest', async () => {
        const tools = await listTools();
        const unmarked = tools.filter(t => t.annotations?.readOnlyHint === undefined);
        expect(unmarked.map(t => t.name)).toEqual([]);

        const writes = tools.filter(t => t.annotations?.readOnlyHint === false).map(t => t.name);
        expect(writes.sort()).toEqual(WRITES);
    });

    /**
     * `destructiveHint` is the permission tier the write gate already runs on,
     * said out loud. Reading it from `spec.tier` is what keeps the two from
     * drifting: a tool cannot be gated as destructive and advertised as safe.
     */
    it('marks a write destructive when its own permission tier is', async () => {
        const tools = await listTools();
        const destructive = tools.filter(t => t.annotations?.destructiveHint === true).map(t => t.name);
        expect(destructive.sort()).toEqual(DESTRUCTIVE);

        // Meaningful only when readOnlyHint is false, so a read tool must not
        // claim it either way — the spec leaves it undefined there.
        const reads = tools.filter(t => t.annotations?.readOnlyHint === true);
        expect(reads.filter(t => t.annotations?.destructiveHint !== undefined).map(t => t.name)).toEqual([]);
    });

    it('gives every tool a title, so a client shows a name a person can read', async () => {
        const untitled = (await listTools()).filter(t => (t.title ?? '') === '' || t.title === t.name);
        expect(untitled.map(t => t.name)).toEqual([]);
    });
});

/**
 * `instructions` is the one piece of documentation every client gets, whether
 * or not it surfaces prompts or resources — and this server's two rules that
 * are not derivable from any single tool's description live there: a list
 * reports `total` for the whole list rather than the window, and a write
 * previews before it applies.
 */
describe('what the server says about itself at initialize', () => {
    const initialize = async (): Promise<{ instructions?: string }> => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }
                },
                { Authorization: `Bearer ${TOKEN}` }
            )
        );
        return ((await rpcPayload(res)).result ?? {}) as { instructions?: string };
    };

    it('ships instructions, which is the only documentation a client always reads', async () => {
        const { instructions } = await initialize();
        expect(instructions ?? '').not.toBe('');
    });

    it('names the two rules no single tool description can carry', async () => {
        const { instructions = '' } = await initialize();
        // The write handshake, and what `total` counts.
        expect(instructions).toContain('confirm');
        expect(instructions).toContain('total');
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
 * Reported from a live agent session (#103): a caller sent `offset`, `source`
 * and `totally_made_up` to `get_library` and got a clean 200 back. Nothing
 * objected, so the model concluded the parameters existed and that its
 * pagination was simply broken — it then reported a 243-item library as
 * unpaginable, having never learned that `limit` was the parameter it wanted.
 *
 * A dropped argument is indistinguishable from an honoured one, which makes
 * silence the worst possible answer: the caller's next move is to trust the
 * result. These run through the real HTTP path because the SDK validates
 * against the schema *before* the handler — a test that calls the handler
 * directly, as `toolSurface.test.ts` does, never sees this at all.
 */
describe('an argument this server does not have is refused, not ignored', () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
                { Authorization: `Bearer ${TOKEN}` }
            )
        );
        const payload = await rpcPayload(res);
        return (payload.result ?? {}) as { isError?: boolean; content?: { type: string; text: string }[] };
    };

    /**
     * The call from #103, minus `offset` — which that issue asked for and this
     * tool now has, so it is no longer an invented parameter. The other two
     * never existed and still do not.
     */
    it('refuses the invented parameters from #103, naming each one', async () => {
        const result = await callTool('get_library', { source: 'media', totally_made_up: true });

        expect(result.isError).toBe(true);
        const text = result.content?.[0]?.text ?? '';
        expect(text).toContain('source');
        expect(text).toContain('totally_made_up');
    });

    it('honours `offset`, which #103 asked for, rather than refusing it', async () => {
        expect((await callTool('get_library', { offset: 100, limit: 5 })).isError).toBeFalsy();
    });

    /**
     * The half that turns a refusal into a recovery. "offset is not a
     * parameter" leaves the model exactly as stuck as silence did; naming the
     * parameters it *can* send is what lets it find `limit` on its own, which
     * is the answer it was looking for in #103.
     */
    it('names the parameters the tool does accept, so the caller can correct itself', async () => {
        const text = (await callTool('get_library', { source: 'media' })).content?.[0]?.text ?? '';

        expect(text).toContain('limit');
        expect(text).toContain('offset');
        expect(text).toContain('min_rating');
    });

    /**
     * The undocumented 1.0 spellings are accepted and stay unadvertised — an
     * error message that listed them would teach the old name to every caller
     * that made a typo, which is the one thing keeping them undocumented was
     * for.
     */
    it('still accepts the undocumented aliases, and does not advertise them', async () => {
        expect((await callTool('get_library', { watched_by: 'Someone' })).isError).toBeFalsy();
        expect((await callTool('discover_media', { media_type: 'tv' })).isError).toBeFalsy();

        const text = (await callTool('get_library', { source: 'media' })).content?.[0]?.text ?? '';
        expect(text).not.toContain('watched_by');
    });

    /**
     * `dry_run` and `confirm` are added to every write tool by
     * `registerWriteTool`, after the tool declared its own arguments — so a
     * strictness applied only to the tool's half would refuse the two
     * parameters the write protocol itself depends on.
     */
    it('keeps the write protocol’s own parameters valid on a write tool', async () => {
        const text = (await callTool('set_monitoring', { nonsense: 1 })).content?.[0]?.text ?? '';

        expect(text).toContain('nonsense');
        expect(text).toContain('dry_run');
        expect(text).toContain('confirm');
    });

    /**
     * The guard for tool number twenty. Strictness that has to be remembered
     * per tool is strictness that will be forgotten, and the failure mode is
     * silent — so this asserts the property across the whole surface rather
     * than sampling it.
     */
    it('advertises no tool that would accept an unknown argument', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${TOKEN}` })
        );
        const { result } = (await rpcPayload(res)) as {
            result: { tools: { name: string; inputSchema: { additionalProperties?: boolean } }[] };
        };

        const permissive = result.tools.filter(t => t.inputSchema.additionalProperties !== false);
        expect(permissive.map(t => t.name)).toEqual([]);
    });
});

/**
 * #103 reported `total` as missing from `structuredContent`. It was never
 * missing — but no tool declared an `outputSchema`, and a client that gates
 * `structuredContent` on a declared schema surfaces nothing without one, which
 * from the far side is the same thing. The reporter parsed the count out of the
 * summary sentence instead.
 *
 * Declaring one is not free: the SDK validates `structuredContent` against it
 * and fails the *whole call* on a mismatch. On a write that means a change that
 * already landed would be reported as an error. So these drive real payloads
 * through the validating path — an empty result validates against almost
 * anything, and would prove nothing.
 */
describe('every tool declares the shape it answers in', () => {
    const film = {
        id: 1,
        title: 'Some Film',
        year: 2026,
        monitored: true,
        hasFile: true,
        tmdbId: 550,
        movieFile: { size: 4_000_000_000, quality: { quality: { name: 'Bluray-1080p' } } }
    };

    /** Reachable, with one film and a scan capability — enough for a read, a
     *  health answer and a write preview to all produce a real payload. */
    const radarr = (): ServiceAdapter =>
        ({
            id: 'radarr',
            type: 'radarr',
            testConnection: async () => ({ ok: true, service: 'radarr', latency_ms: 3 }),
            getVersion: async () => '5.0.0',
            listLibrary: async () => [
                {
                    kind: 'movie',
                    title: film.title,
                    year: film.year,
                    ids: { tmdb: film.tmdbId },
                    acquisition: { service: 'radarr', monitored: true, hasFile: true, quality: 'Bluray-1080p' }
                }
            ],
            startLibraryScan: async () => ({ commandId: 42 })
        }) as unknown as ServiceAdapter;

    /**
     * Permissions are read from the config, never from the adapter, so a write
     * preview needs a `services.radarr` block even though the adapter above is
     * a stub. Without it `trigger_scan` is refused before it can produce the
     * shape this is here to validate.
     */
    const writable = ConfigSchema.parse({
        auth: { bearer_token: TOKEN, password_hash: hashPassword('unused-here') },
        services: { radarr: { url: 'http://192.0.2.10:7878', api_key: 'k', permissions: { safe_write: true } } }
    });

    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await appWith(writable, [radarr()]).request(
            'http://localhost:6060/mcp',
            rpc(
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
                { Authorization: `Bearer ${TOKEN}` }
            )
        );
        return ((await rpcPayload(res)).result ?? {}) as {
            isError?: boolean;
            content?: { text: string }[];
            structuredContent?: Record<string, unknown>;
        };
    };

    it('declares an output schema on every tool, not only the ones that were easy', async () => {
        const res = await app().request(
            'http://localhost:6060/mcp',
            rpc(toolsList, { Authorization: `Bearer ${TOKEN}` })
        );
        const { result } = (await rpcPayload(res)) as { result: { tools: { name: string; outputSchema?: unknown }[] } };

        expect(result.tools.filter(t => t.outputSchema === undefined).map(t => t.name)).toEqual([]);
    });

    /** The field #103 could not reach, now declared and still populated. */
    it('returns a validated envelope carrying `total` for a real library read', async () => {
        const result = await call('get_library');

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ total: 1, returned: 1, offset: 0, truncated: false });
    });

    it('validates the answer of the one read tool that is not a list', async () => {
        const result = await call('stack_health');

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toHaveProperty('services');
    });

    /**
     * A write preview, which is where a wrong schema would cost the most: the
     * call fails *after* `apply` has run, so a completed change gets reported
     * as an error. This one stops before `apply` — no token was presented —
     * but it exercises the same validation on the same shape.
     */
    it('validates a write preview, token and all', async () => {
        const result = await call('trigger_scan', { service: 'radarr' });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ applied: false, tool: 'trigger_scan', tier: 'safe' });
        expect(result.structuredContent?.['confirm_token']).toEqual(expect.any(String));
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
