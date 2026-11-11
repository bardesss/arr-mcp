import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { ALIAS_DESCRIPTION, DEPRECATIONS, type Deprecation } from '../src/tools/deprecations.ts';
import { TOOL_DOCS } from '../src/mcp/toolDocs.ts';
import { rpcPayload as parseRpcPayload } from '../scripts/lib/rpc.ts';

const TOKEN = 'a'.repeat(64);
const PASSWORD_HASH = await hashPassword('unused-here');

const config: Config = ConfigSchema.parse({
    auth: { bearer_token: TOKEN, password_hash: PASSWORD_HASH },
    services: {}
});

type Advertised = { name: string; description?: string; inputSchema?: { properties?: Record<string, { description?: string }> } };

const call = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const app = buildApp({
        runtime: Runtime.fromConfig(config, WriteAudit.ephemeral(), { adapters: [] }),
        audit: WriteAudit.ephemeral(),
        logs: LogStore.ephemeral()
    });
    const res = await app.request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) })
    });
    return (parseRpcPayload<Record<string, unknown>>(await res.text())).result ?? {};
};

const listTools = async (): Promise<Advertised[]> => ((await call('tools/list')) as { tools: Advertised[] }).tools;

/** Everything else a client is shown: each prompt's text, each resource's description, and the per-tool reference. */
const otherSurfaces = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const { prompts } = (await call('prompts/list')) as { prompts: { name: string; arguments?: { name: string }[] }[] };
    for (const p of prompts) {
        const args = Object.fromEntries((p.arguments ?? []).map(a => [a.name, 'x']));
        out[`prompt ${p.name}`] = JSON.stringify(await call('prompts/get', { name: p.name, arguments: args }));
    }
    const { resources } = (await call('resources/list')) as { resources: { uri: string; description?: string }[] };
    // The `arr://docs/` page under an old tool name is the alias itself.
    out.resources = JSON.stringify(resources.filter(r => !(r.uri.startsWith('arr://docs/') && r.description?.startsWith('Deprecated:'))));
    for (const [tool, doc] of Object.entries(TOOL_DOCS)) out[`TOOL_DOCS ${tool}`] = doc;
    return out;
};

/** The tool name as a word: `get_stack_health` does not name `stack_health`. */
const names = (text: string, tool: string): boolean => new RegExp(`(?<![A-Za-z0-9_])${tool}(?![A-Za-z0-9_])`).test(text);

describe('DEPRECATIONS', () => {
    it('gives a renamed tool a one-line alias description', async () => {
        const tools = await listTools();
        for (const entry of DEPRECATIONS.filter(e => e.rename === true)) {
            expect(tools.find(t => t.name === entry.tool)?.description, entry.tool).toBe(ALIAS_DESCRIPTION(entry.use));
            expect(ALIAS_DESCRIPTION(entry.use)).toBe(`Deprecated: use ${entry.use}, which takes the same arguments.`);
        }
    });

    it('answers the old name with the same result', async () => {
        for (const [oldName, newName, args] of [
            ['stack_health', 'get_stack_health', {}],
            ['diagnose', 'diagnose_media', { query: 'nothing in this library' }]
        ] as const) {
            const asked = await call('tools/call', { name: newName, arguments: args });
            const aliased = await call('tools/call', { name: oldName, arguments: args });
            expect(aliased.isError, oldName).not.toBe(true);
            expect(aliased.structuredContent, oldName).toEqual(asked.structuredContent);
            expect(aliased.structuredContent, oldName).toBeDefined();
        }
    });

    it('keeps the old arr://docs/ pages as aliases of the new ones', async () => {
        const read = async (uri: string) => ((await call('resources/read', { uri })) as { contents: { text: string }[] }).contents[0]?.text;
        expect(await read('arr://docs/stack_health')).toBe(TOOL_DOCS.get_stack_health);
        expect(await read('arr://docs/diagnose')).toBe(TOOL_DOCS.diagnose_media);
    });

    it('says Deprecated and names the replacement on every deprecated tool or parameter', async () => {
        const tools = await listTools();
        for (const entry of DEPRECATIONS as readonly Deprecation[]) {
            const tool = tools.find(t => t.name === entry.tool);
            expect(tool, entry.tool).toBeDefined();
            const text = entry.param === undefined ? tool!.description : tool!.inputSchema?.properties?.[entry.param]?.description;
            expect(text, `${entry.tool} ${entry.param ?? ''}`).toMatch(/^Deprecated|Deprecated:/);
            expect(text).toContain(entry.use);
        }
    });

    it('points no other tool, prompt, resource or reference at a deprecated tool', async () => {
        const tools = await listTools();
        const surfaces = await otherSurfaces();
        for (const entry of DEPRECATIONS.filter(e => e.param === undefined)) {
            // The description and the whole input schema, so a parameter's own text counts.
            const pointing = tools
                .filter(t => t.name !== entry.tool && names(JSON.stringify({ description: t.description, inputSchema: t.inputSchema }), entry.tool))
                .map(t => t.name);
            expect(pointing, `tools naming ${entry.tool}`).toEqual([]);
            const elsewhere = Object.entries(surfaces)
                .filter(([, text]) => names(text, entry.tool))
                .map(([name]) => name);
            expect(elsewhere, `prompts, resources or references naming ${entry.tool}`).toEqual([]);
        }
    });
});
