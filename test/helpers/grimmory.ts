import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import * as z from 'zod/v4';
import { ConfigSchema } from '../../src/config/schema.ts';
import { WriteAudit } from '../../src/core/audit.ts';
import { ConfirmTokens } from '../../src/core/confirm.ts';
import { permissionSourceFrom } from '../../src/core/permissions.ts';
import type { LibraryLoader } from '../../src/tools/library.ts';
import type { WriteContext, WriteToolResult } from '../../src/tools/write.ts';
import { instancesOf } from './instances.ts';

/**
 * Shared by the tests of every Grimmory write: a config with chosen
 * permissions, a fetch that answers by `METHOD path`, and the harness a write
 * tool is called through. Each test file resets the login lockout itself with
 * `beforeEach(resetGrimmoryLockouts)`.
 */

type Perms = { safe_write?: boolean; destructive?: boolean };

/** Writes allowed, nothing destructive, unless `perms` says otherwise (`{}` allows nothing). */
export const grimmoryConfig = (perms: Perms = { safe_write: true }) =>
    ConfigSchema.parse({
        auth: { bearer_token: 'a'.repeat(64) },
        services: {
            grimmory: {
                url: 'http://grimmory:6060',
                username: 'reader',
                password: 'hunter2',
                permissions: { safe_write: perms.safe_write ?? false, destructive: perms.destructive ?? false }
            }
        }
    }).services.grimmory as never;

export type Reply = () => Response;

export const json =
    (body: unknown, status = 200): Reply =>
    () =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A `text/event-stream` body of one `data:` event per item, as Grimmory's metadata lookup answers. */
export const sse =
    (items: unknown[]): Reply =>
    () =>
        new Response(items.map(item => `data:${JSON.stringify(item)}\n\n`).join(''), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
        });

/** A captured or hand-made response body under test/fixtures/grimmory; `.json` is optional. */
export const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../fixtures/grimmory/${name.endsWith('.json') ? name : `${name}.json`}`, import.meta.url), 'utf8')) as unknown;

export type Sent = { method: string; path: string; query: string; body: unknown };

const TOKENS = { accessToken: 'tok', refreshToken: 'ref', expires: 7200 };

/**
 * A fetch answering by `METHOD pathname`. Each route is one reply or a list
 * used in turn (the last repeats). Login and the healthcheck are already
 * wired; any other route is a 404. `sent` records every request that reached
 * a route, with its parsed body.
 */
export function grimmoryServer(routes: Record<string, Reply | Reply[]>): { fetch: typeof fetch; sent: Sent[] } {
    const sent: Sent[] = [];
    const used: Record<string, number> = {};
    const all: Record<string, Reply | Reply[]> = {
        'POST /api/v1/auth/login': json(TOKENS),
        'GET /api/v1/healthcheck': json(fixture('healthcheck')),
        ...routes
    };

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        const key = `${method} ${url.pathname}`;
        const raw = typeof init?.body === 'string' ? init.body : undefined;
        let body: unknown = raw;
        if (raw !== undefined) {
            try {
                body = JSON.parse(raw);
            } catch {
                body = raw;
            }
        }
        sent.push({ method, path: url.pathname, query: url.search.replace(/^\?/, ''), body });

        const route = all[key];
        if (route === undefined) return new Response('not found', { status: 404 });
        const replies = Array.isArray(route) ? route : [route];
        const n = used[key] ?? 0;
        used[key] = n + 1;
        return replies[Math.min(n, replies.length - 1)]!();
    }) as unknown as typeof fetch;

    return { fetch: impl, sent };
}

export type WriteCall = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

/**
 * Registers one write tool against a fake server and returns a function that
 * calls it the way a client would: arguments parsed by the tool's own schema.
 * The permissions are Grimmory's, `perms` as in `grimmoryConfig`.
 */
export function writeTool(register: (server: never, context: WriteContext) => void, perms?: Perms, confirm: ConfirmTokens = new ConfirmTokens()): WriteCall {
    let call: WriteCall = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_name: string, config: { inputSchema: z.ZodObject }, handler: WriteCall) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    register(server as never, {
        permissions: permissionSourceFrom(instancesOf({ grimmory: grimmoryConfig(perms) })),
        confirm,
        audit: WriteAudit.ephemeral(),
        library: { invalidate: vi.fn() } as unknown as LibraryLoader
    });

    return args => call(args);
}
