import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { DEPRECATIONS, type Deprecation } from '../src/tools/deprecations.ts';
import { rpcPayload as parseRpcPayload } from '../scripts/lib/rpc.ts';

const TOKEN = 'a'.repeat(64);
const PASSWORD_HASH = await hashPassword('unused-here');

const config: Config = ConfigSchema.parse({
    auth: { bearer_token: TOKEN, password_hash: PASSWORD_HASH },
    services: {}
});

type Advertised = { name: string; description?: string; inputSchema?: { properties?: Record<string, { description?: string }> } };

const listTools = async (): Promise<Advertised[]> => {
    const app = buildApp({
        runtime: Runtime.fromConfig(config, WriteAudit.ephemeral(), { adapters: [] }),
        audit: WriteAudit.ephemeral(),
        logs: LogStore.ephemeral()
    });
    const res = await app.request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const payload = parseRpcPayload<{ tools: Advertised[] }>(await res.text());
    return payload.result!.tools;
};

describe('DEPRECATIONS', () => {
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

    it('points no other tool at a deprecated tool', async () => {
        const tools = await listTools();
        for (const entry of DEPRECATIONS.filter(e => e.param === undefined)) {
            const pointing = tools.filter(t => t.name !== entry.tool && (t.description ?? '').includes(entry.tool)).map(t => t.name);
            expect(pointing, `tools naming ${entry.tool}`).toEqual([]);
        }
    });
});
