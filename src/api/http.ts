import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { configEtag } from '../config/etag.ts';
import type { Config } from '../config/schema.ts';

export const API_BASE = '/api/v1';

export const NO_STORE = { 'cache-control': 'no-store' };

export const apiError = (c: Context, status: ContentfulStatusCode, message: string): Response =>
    c.json({ message }, status, NO_STORE);

export const withEtag = (c: Context, config: Config, body: unknown, status: ContentfulStatusCode = 200): Response =>
    c.json(body, status, { etag: configEtag(config) });

/** `*` matches anything; a `W/` prefix is tolerated since clients echo what they got. */
export function etagMatches(header: string | undefined, config: Config): boolean {
    if (header === undefined) return true;
    const current = configEtag(config);
    return header
        .split(',')
        .map(t => t.trim().replace(/^W\//, ''))
        .some(t => t === '*' || t === current);
}
