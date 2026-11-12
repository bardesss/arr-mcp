import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpServerFactory } from '../src/app.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { WebhookEvents } from '../src/core/webhookEvents.ts';
import { stdioCeiling } from '../src/stdio.ts';

/**
 * Tool schemas are built once and shared by every request's McpServer (#573).
 *
 * The server stays per request; only the zod objects it is handed are shared.
 * The identity checks pin the sharing, and the reload check pins that a schema
 * which depends on the config does not outlive the config it was built for.
 */

const TOKEN = 'a'.repeat(64);
const PASSWORD_HASH = await hashPassword('x');

const SERVICES = {
    radarr: { url: 'http://192.0.2.10:7878', api_key: 'k' },
    sonarr: { url: 'http://192.0.2.11:8989', api_key: 'k' },
    lidarr: { url: 'http://192.0.2.12:8686', api_key: 'k' }
};
const JELLYFIN = { url: 'http://192.0.2.20:8096', api_key: 'k' };
const PLEX = { url: 'http://192.0.2.21:32400', api_key: 'k' };

const configWith = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ConfigSchema.parse({ auth: { bearer_token: TOKEN, password_hash: PASSWORD_HASH }, services, ...extra });

type Registered = { inputSchema?: object; outputSchema?: object };
const registered = async (runtime: Runtime) => {
    const events = WebhookEvents.ephemeral();
    const server = await mcpServerFactory(runtime, events, stdioCeiling)({ era: 'modern' });
    events.close();
    return (server as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;
};
// `shapeToolSurface` wraps each schema in an `Object.create` view; the shared one is its prototype.
const underlying = (schema: object | undefined): object | undefined => (schema === undefined ? undefined : (Object.getPrototypeOf(schema) as object));

describe('two builds share their schemas', () => {
    it('hands the same input and output schema objects to a read tool', async () => {
        const runtime = Runtime.fromConfig(configWith(SERVICES), WriteAudit.ephemeral());
        try {
            const a = await registered(runtime);
            const b = await registered(runtime);
            expect(a['get_queue']).not.toBe(b['get_queue']);
            expect(underlying(a['get_queue']?.inputSchema)).toBeDefined();
            expect(underlying(a['get_queue']?.inputSchema)).toBe(underlying(b['get_queue']?.inputSchema));
            expect(underlying(a['get_calendar']?.outputSchema)).toBe(underlying(b['get_calendar']?.outputSchema));
            expect(underlying(a['get_calendar']?.outputSchema)).toBeDefined();
        } finally {
            await runtime.close();
        }
    });

    it('hands the same input schema object to a write tool', async () => {
        const runtime = Runtime.fromConfig(configWith(SERVICES), WriteAudit.ephemeral());
        try {
            const a = await registered(runtime);
            const b = await registered(runtime);
            expect(underlying(a['remove_queue_item']?.inputSchema)).toBeDefined();
            expect(underlying(a['remove_queue_item']?.inputSchema)).toBe(underlying(b['remove_queue_item']?.inputSchema));
        } finally {
            await runtime.close();
        }
    });
});

describe('a schema that depends on the config follows a reload', () => {
    it('offers `service` on get_playback only once a second media server is configured', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-schema-'));
        const write = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
            writeFile(join(dir, 'config.yaml'), JSON.stringify(configWith(services, extra)), 'utf8');
        const serviceField = async (runtime: Runtime): Promise<object | undefined> => {
            const tool = (await registered(runtime))['get_playback'];
            return (tool?.inputSchema as { shape: Record<string, object> } | undefined)?.shape['service'];
        };
        try {
            await write({ ...SERVICES, jellyfin: JELLYFIN });
            const runtime = Runtime.fromConfig(configWith({ ...SERVICES, jellyfin: JELLYFIN }), WriteAudit.ephemeral(), { configDir: dir });
            try {
                expect(await serviceField(runtime)).toBeUndefined();

                await write({ ...SERVICES, jellyfin: JELLYFIN, plex: PLEX }, { primary_media_server: 'plex' });
                await runtime.reload();
                const both = await serviceField(runtime);
                expect(both).toBeDefined();
                // Shared between requests while the config stays as it is.
                expect(await serviceField(runtime)).toBe(both);

                await write({ ...SERVICES, jellyfin: JELLYFIN });
                await runtime.reload();
                expect(await serviceField(runtime)).toBeUndefined();
            } finally {
                await runtime.close();
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
