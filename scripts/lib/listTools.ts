/**
 * `tools/list` as a client sees it for a given set of services: in-process
 * through Hono, no network, nothing written to disk. Shared by
 * `scripts/measure-tool-surface.ts` and the surface tests.
 */
import { buildApp } from '../../src/app.ts';
import { ConfigSchema, type Config } from '../../src/config/schema.ts';
import { WriteAudit } from '../../src/core/audit.ts';
import { LogStore } from '../../src/core/logs.ts';
import { Runtime } from '../../src/core/runtime.ts';
import { hashPassword } from '../../src/core/session.ts';
import { rpcPayload } from './rpc.ts';

const TOKEN = 'a'.repeat(64);

export type Tool = { name: string; description?: string; inputSchema?: unknown };

export const svc = (port: number, extra: Record<string, unknown> = {}) => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    ...extra
});

const passwordHash = await hashPassword('unused-here');

export async function listTools(services: Record<string, unknown>): Promise<Tool[]> {
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
