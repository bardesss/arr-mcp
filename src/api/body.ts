import { isJsonContentType } from '@modelcontextprotocol/server';
import type { Context, Next } from 'hono';
import type * as z from 'zod/v4';
import { apiError } from './http.ts';

/**
 * Keeps the MCP transport's parser off `/api` bodies, which it would refuse
 * in plain text. Parsing waits for `readObject`, after the key check.
 */
export function apiJsonBody(c: Context, next: Next): Promise<void> {
    if (isJsonContentType(c.req.header('content-type'))) c.set('parsedBody', null);
    return next();
}

export async function readObject(c: Context): Promise<Record<string, unknown> | Response> {
    if (!isJsonContentType(c.req.header('content-type'))) return apiError(c, 415, 'Send the body as application/json.');
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return apiError(c, 400, 'The request body is not valid JSON.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return apiError(c, 400, 'The body must be a JSON object.');
    }
    return body as Record<string, unknown>;
}

export function parseWith<T>(c: Context, schema: z.ZodType<T>, body: unknown): T | Response {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    const lines = parsed.error.issues.map(i => (i.path.length === 0 ? i.message : `${i.path.join('.')}: ${i.message}`));
    return apiError(c, 400, lines.join('; '));
}
