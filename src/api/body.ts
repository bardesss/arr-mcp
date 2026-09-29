import { isJsonContentType } from '@modelcontextprotocol/server';
import type { Context, Next } from 'hono';
import type * as z from 'zod/v4';
import { apiError } from './http.ts';

/**
 * Claims `/api` bodies before the MCP transport's parser, which would answer
 * a malformed one in plain text. Same mechanism as `claimJsonBody`.
 */
export async function apiJsonBody(c: Context, next: Next): Promise<Response | void> {
    if (!isJsonContentType(c.req.header('content-type'))) return next();
    if (c.req.method !== 'POST' && c.req.method !== 'PUT') {
        c.set('parsedBody', null);
        return next();
    }
    try {
        c.set('parsedBody', await c.req.raw.clone().json());
    } catch {
        return apiError(c, 400, 'The request body is not valid JSON.');
    }
    return next();
}

export async function readObject(c: Context): Promise<Record<string, unknown> | Response> {
    if (!isJsonContentType(c.req.header('content-type'))) return apiError(c, 415, 'Send the body as application/json.');
    const body: unknown = await c.req.json();
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
