import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { fingerprint, hashToken } from './mcpTokens.ts';

export type ManagementKeyTier = 'read' | 'admin';
export type StoredManagementKey = { name: string; tier: ManagementKeyTier; hash: string; created: string };

export const generateManagementKey = (): string => `amk_${randomBytes(32).toString('hex')}`;

// Every stored hash is compared, so timing says nothing about which one matched.
export function matchManagementKey(
    presented: string | undefined,
    keys: readonly StoredManagementKey[]
): StoredManagementKey | undefined {
    if (presented === undefined || presented === '') return undefined;
    const digest = Buffer.from(hashToken(presented));
    let found: StoredManagementKey | undefined;
    for (const key of keys) {
        const want = Buffer.from(key.hash);
        const same = digest.length === want.length && timingSafeEqual(digest, want);
        if (same && found === undefined) found = key;
    }
    return found;
}

/** The field the API's log lines name their caller with, in the MCP tokens' `name#fingerprint` shape. */
export const managementKeyLabel = (key: StoredManagementKey): string => `${key.name}#${fingerprint(key.hash)}`;

const REQUEST_KEY = 'managementKey';

export const rememberManagementKey = (c: Context, key: StoredManagementKey): void => {
    c.set(REQUEST_KEY, key);
};

/** Empty outside the management API, so the config UI's shared log lines stay as they are. */
export const managementKeyField = (c: Context): { key?: string } => {
    const key = c.get(REQUEST_KEY) as StoredManagementKey | undefined;
    return key === undefined ? {} : { key: managementKeyLabel(key) };
};
