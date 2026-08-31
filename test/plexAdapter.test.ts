import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { logger } from '../src/core/logger.ts';
import { PlexAdapter } from '../src/services/plex.ts';
import { serving } from './helpers/serve.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/plex', name), 'utf8'));

// Hand-built and unverified — nobody on this side runs Plex. See
// docs/superpowers/plans/2026-08-31-plex-adapter.md.
const IDENTITY = read('unverified-identity.json');
const ACCOUNTS = read('unverified-accounts.json');

const config = (over: Partial<MultiUserServiceConfig> = {}): MultiUserServiceConfig => ({
    url: 'http://192.0.2.10:32400',
    api_key: 'tok',
    timeout_ms: 10_000,
    allow_other_users: false,
    permissions: { safe_write: false, destructive: false },
    ...over
});

const plex = (routes: Record<string, unknown>, over: Partial<MultiUserServiceConfig> = {}) => {
    const adapter = new PlexAdapter(config(over), serving(routes));
    return { adapter };
};

describe('PlexAdapter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads the server version', async () => {
        const { adapter } = plex({ '/identity': IDENTITY });
        expect(await adapter.getVersion()).toBe('1.43.3.10896');
    });

    it('throws when /identity has no version field', async () => {
        const { adapter } = plex({ '/identity': { MediaContainer: {} } });
        await expect(adapter.getVersion()).rejects.toThrow(/version/);
    });

    it('reports exactly one user, the token owner, however many accounts the server lists', async () => {
        const { adapter } = plex({ '/identity': IDENTITY, '/accounts': ACCOUNTS });
        expect(await adapter.listUsers()).toEqual([{ id: '1', name: 'Bartus' }]);
    });

    it('falls back to default_user when the owner account has no usable name', async () => {
        const blank = { MediaContainer: { Account: [{ id: 1, name: '' }] } };
        const { adapter } = plex({ '/accounts': blank }, { default_user: 'Bartus' });
        expect(await adapter.listUsers()).toEqual([{ id: '1', name: 'Bartus' }]);
    });

    it('falls back to default_user when the owner row is missing entirely', async () => {
        const noOwner = { MediaContainer: { Account: [{ id: 2, name: 'Guest' }] } };
        const { adapter } = plex({ '/accounts': noOwner }, { default_user: 'Bartus' });
        expect(await adapter.listUsers()).toEqual([{ id: '1', name: 'Bartus' }]);
    });

    it('logs the unverified fallback exactly once across repeated calls', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
        const blank = { MediaContainer: { Account: [{ id: 1, name: '' }] } };
        const { adapter } = plex({ '/accounts': blank }, { default_user: 'Bartus' });

        await adapter.listUsers();
        await adapter.listUsers();

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('names the config key when the owner cannot be identified and nothing is configured', async () => {
        const blank = { MediaContainer: { Account: [{ id: 1, name: '' }] } };
        const { adapter } = plex({ '/accounts': blank });
        await expect(adapter.listUsers()).rejects.toThrow(/default_user/);
    });

    it('returns a diagnosis rather than throwing when the server is unreachable', async () => {
        const { adapter } = plex({});
        const d = await adapter.testConnection();
        expect(d.ok).toBe(false);
        expect(d.service).toBe('plex');
    });

    it('returns a passing diagnosis with the reported version when the server answers', async () => {
        const { adapter } = plex({ '/identity': IDENTITY });
        const d = await adapter.testConnection();
        expect(d.ok).toBe(true);
        expect(d.version).toBe('1.43.3.10896');
    });
});
