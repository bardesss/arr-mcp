import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpServerFactory } from '../src/app.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { logStream } from '../src/core/logger.ts';
import { Runtime } from '../src/core/runtime.ts';
import { Sessions } from '../src/core/session.ts';
import { WebhookEvents } from '../src/core/webhookEvents.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { STDIO_CALLER, serveOverStdio, stdioCeiling } from '../src/stdio.ts';
import { TOOL_NAMES } from '../src/tools/register.ts';

const initialize: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
};
const initialized: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/initialized' };

/** A client end that sends raw JSON-RPC and waits for the answer to each id. */
function clientOn(transport: InMemoryTransport) {
    const answers = new Map<string | number, (m: JSONRPCMessage) => void>();
    transport.onmessage = message => {
        const id = (message as { id?: string | number }).id;
        if (id !== undefined) answers.get(id)?.(message);
    };
    return {
        start: () => transport.start(),
        notify: (message: JSONRPCMessage) => transport.send(message),
        request: (message: JSONRPCMessage & { id: string | number }) =>
            new Promise<JSONRPCMessage>(resolve => {
                answers.set(message.id, resolve);
                void transport.send(message);
            })
    };
}

async function connect(serve: (transport: InMemoryTransport) => Promise<{ close(): Promise<void> }> | { close(): Promise<void> }) {
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    const client = clientOn(clientEnd);
    await client.start();
    const handle = await serve(serverEnd);
    await client.request(initialize as JSONRPCMessage & { id: number });
    await client.notify(initialized);
    return { client, handle };
}

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('MCP over stdio', () => {
    it('starts from an empty config directory and lists every tool', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-stdio-'));
        dirs.push(dir);
        const { client, handle } = await connect(transport =>
            serveOverStdio({
                configDir: dir,
                audit: WriteAudit.ephemeral(),
                events: WebhookEvents.ephemeral(),
                sessions: new Sessions(),
                transport
            })
        );
        try {
            const listed = (await client.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
                result?: { tools: { name: string }[] };
            };
            expect(listed.result?.tools.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort());
            // Seeded like any first start, so the same directory later opens in the config UI.
            expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('auth:');
        } finally {
            await handle.close();
        }
    });

    it('refuses writes whatever config.yaml permits, and audits the caller as stdio', async () => {
        const config = ConfigSchema.parse({
            auth: {},
            services: {
                radarr: { url: 'http://192.0.2.10:7878', api_key: 'k', permissions: { safe_write: true, destructive: true } }
            }
        });
        const radarr = {
            id: 'radarr',
            type: 'radarr',
            testConnection: async () => ({ ok: true, service: 'radarr', latency_ms: 3 }),
            getVersion: async () => '5.0.0',
            getMediaDetails: async () => ({ title: 'Alien', year: 1979, sizeBytes: 4_000_000_000 }),
            deleteMedia: async () => {
                throw new Error('a stdio connection must never reach a delete');
            }
        } as unknown as ServiceAdapter;
        const trail = WriteAudit.ephemeral();
        const runtime = Runtime.fromConfig(config, trail, { adapters: [radarr] });

        const { client, handle } = await connect(transport =>
            serveStdio(mcpServerFactory(runtime, WebhookEvents.ephemeral(), stdioCeiling), { transport })
        );
        try {
            const answer = await client.request({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'delete_media', arguments: { service: 'radarr', id: '412' } }
            });
            expect(JSON.stringify(answer)).toContain('a stdio connection is read-only');
            expect(trail.recent()[0]?.caller).toBe(STDIO_CALLER);
        } finally {
            await handle.close();
        }
    });
});

describe('where log lines go', () => {
    it('is stderr under --stdio, so stdout stays the MCP connection', () => {
        expect(logStream(['node', 'index.js', '--stdio'])).toBe(process.stderr);
        expect(logStream(['node', 'index.js'])).toBe(process.stdout);
    });
});
