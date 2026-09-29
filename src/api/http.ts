import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { stableJson } from '../config/save.ts';
import type { Config } from '../config/schema.ts';

export const API_BASE = '/api/v1';

export const NO_STORE = { 'cache-control': 'no-store' };

export const apiError = (c: Context, status: ContentfulStatusCode, message: string): Response =>
    c.json({ message }, status, NO_STORE);

/**
 * One tag for the whole config: that is what the save's drift check compares.
 * Strong, because If-Match never matches a weak tag.
 */
export const configEtag = (config: Config): string =>
    `"${createHash('sha256').update(stableJson(config)).digest('hex').slice(0, 16)}"`;
