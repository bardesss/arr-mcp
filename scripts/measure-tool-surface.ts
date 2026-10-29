/**
 * What `tools/list` costs a client, per stack.
 *
 * Every connected client pays this up front, on every session, before it has
 * asked for anything. Run it before and after a change to a tool schema or
 * description to see what the change did to that bill.
 *
 *   node scripts/measure-tool-surface.ts
 *
 * In-process through Hono, no network, nothing written to disk. Bytes are the
 * JSON length of the tool definitions; tokens are bytes / 4, a rough figure.
 */
import { buildApp } from '../src/app.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { rpcPayload } from './lib/rpc.ts';

const TOKEN = 'a'.repeat(64);

type Tool = { name: string; inputSchema?: unknown };

const svc = (port: number, extra: Record<string, unknown> = {}) => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    ...extra
});

const small = {
    radarr: svc(7878),
    sonarr: svc(8989),
    sabnzbd: svc(8080),
    jellyfin: svc(8096, { default_user: 'u' })
};

const STACKS: Record<string, Record<string, unknown>> = {
    empty: {},
    small,
    arr: {
        ...small,
        lidarr: svc(8686),
        prowlarr: svc(9696),
        bazarr: svc(6767),
        seerr: svc(5055, { default_user: 'u' })
    }
};

const passwordHash = await hashPassword('unused-here');

async function listTools(services: Record<string, unknown>): Promise<Tool[]> {
    const cfg: Config = ConfigSchema.parse({
        auth: { bearer_token: TOKEN, password_hash: passwordHash },
        services
    });
    const audit = WriteAudit.ephemeral();
    const logs = LogStore.ephemeral();
    const runtime = Runtime.fromConfig(cfg, audit, { adapters: [] });
    try {
        const app = buildApp({ runtime, audit, logs });
        const res = await app.request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: `Bearer ${TOKEN}`
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });
        const payload = rpcPayload<{ tools: Tool[] }>(await res.text());
        if (payload.error || !payload.result) throw new Error(`tools/list failed: ${payload.error?.message ?? res.status}`);
        return payload.result.tools;
    } finally {
        // One stack after another in one process: each closes what it opened.
        await runtime.close();
        audit.close();
        logs.close();
    }
}

const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

for (const [stack, services] of Object.entries(STACKS)) {
    const tools = await listTools(services);
    const total = size(tools);
    console.log(`${stack}: ${tools.length} tools, ${total} bytes, ~${Math.round(total / 4)} tokens`);
    const rows = tools
        .map((t) => ({ name: t.name, total: size(t), input: size(t.inputSchema ?? {}) }))
        .sort((a, b) => b.total - a.total);
    for (const r of rows) console.log(`  ${r.name} ${r.total} (input ${r.input})`);
}
