import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { findByHash, fingerprint } from './secrets.ts';

export type ManagementKeyTier = 'read' | 'admin';
export type StoredManagementKey = { name: string; tier: ManagementKeyTier; hash: string; created: string };

export const generateManagementKey = (): string => `amk_${randomBytes(32).toString('hex')}`;

export const matchManagementKey = (
    presented: string | undefined,
    keys: readonly StoredManagementKey[]
): StoredManagementKey | undefined => findByHash(presented, keys);

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
