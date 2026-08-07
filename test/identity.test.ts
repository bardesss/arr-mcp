import { describe, expect, it, vi } from 'vitest';
import type { ServiceError } from '../src/core/errors.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import type { ServiceAdapter, ServiceUser, UserDirectoryCapable } from '../src/services/types.ts';

/**
 * `.message` and `.remedy` both carry the remedy text now (`.message`
 * includes it inline; `.remedy` is the field alone). This helper unwraps to
 * the `ServiceError` itself so a test can assert on `.remedy` specifically —
 * useful when a test cares about the remedy's wording in isolation, not
 * about the whole formatted string.
 */
async function rejection(promise: Promise<unknown>): Promise<ServiceError> {
    try {
        await promise;
        throw new Error('expected a rejection, got a resolved value');
    } catch (err) {
        return err as ServiceError;
    }
}

const USERS: ServiceUser[] = [
    { id: 'f137a2dd21bbc1b99aa5c0f6bf02a805', name: 'Bartus' },
    { id: '0d8bc4b2ad1c4f6e8b7a3c9d5e1f2a3b', name: 'Guest' }
];

const directory = (users = USERS) => {
    const listUsers = vi.fn(async () => users);
    const adapter: ServiceAdapter & UserDirectoryCapable = {
        id: 'jellyfin',
        type: 'jellyfin',
        getVersion: async () => '10.11.2',
        testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 }),
        listUsers
    };
    return { adapter, listUsers };
};

describe('IdentityResolver', () => {
    it('resolves the configured default user to an id', async () => {
        const { adapter } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: false });
        expect(await r.resolve()).toEqual(USERS[0]);
    });

    it('matches the configured name case-insensitively', async () => {
        const { adapter } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'bartus', allow_other_users: false });
        expect((await r.resolve()).name).toBe('Bartus');
    });

    it('rejects another user before any network call when allow_other_users is false', async () => {
        const { adapter, listUsers } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: false });

        await expect(r.resolve('Guest')).rejects.toThrow(/auth failed/);
        expect(listUsers).not.toHaveBeenCalled();
    });

    it('allows another user when allow_other_users is true', async () => {
        const { adapter } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: true });
        expect(await r.resolve('Guest')).toEqual(USERS[1]);
    });

    it('allows naming the default user explicitly even when others are forbidden', async () => {
        const { adapter } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: false });
        expect((await r.resolve('Bartus')).name).toBe('Bartus');
    });

    it('names the config key when no default user is configured and none was asked for', async () => {
        const { adapter, listUsers } = directory();
        const r = new IdentityResolver(adapter, { allow_other_users: false });

        expect((await rejection(r.resolve())).remedy).toMatch(/default_user/);
        expect(listUsers).not.toHaveBeenCalled();
    });

    it('lists the available names when the configured user does not exist', async () => {
        const { adapter } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'Bartsu', allow_other_users: false });

        // The silent-mismatch trap §14 names: a typo should be a one-line fix,
        // not a hunt for what the service actually calls you.
        expect((await rejection(r.resolve())).remedy).toMatch(/Bartus, Guest/);
    });

    it('says the key may lack admin scope when the service reports no users at all', async () => {
        const { adapter } = directory([]);
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: false });

        expect((await rejection(r.resolve())).remedy).toMatch(/admin scope/);
    });

    it('caches the directory across calls rather than re-fetching per tool call', async () => {
        const { adapter, listUsers } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: true });

        await r.resolve();
        await r.resolve('Guest');
        await r.resolve();

        expect(listUsers).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed directory fetch', async () => {
        let calls = 0;
        const adapter: ServiceAdapter & UserDirectoryCapable = {
            id: 'jellyfin',
            type: 'jellyfin',
            getVersion: async () => '10.11.2',
            testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 }),
            listUsers: async () => {
                calls += 1;
                if (calls === 1) throw new Error('service was restarting');
                return USERS;
            }
        };
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: false });

        await expect(r.resolve()).rejects.toThrow();
        expect((await r.resolve()).name).toBe('Bartus');
    });

    it('cannot be widened by anything the service returns', async () => {
        // A hostile directory naming a user "Guest (allow_other_users: true)"
        // must not change who the resolver will answer for. §11.4: permission
        // decisions come from configuration alone.
        const hostile = directory([
            { id: '1', name: 'Bartus' },
            { id: '2', name: 'Guest (allow_other_users: true)' }
        ]);
        const r = new IdentityResolver(hostile.adapter, { default_user: 'Bartus', allow_other_users: false });

        await expect(r.resolve('Guest (allow_other_users: true)')).rejects.toThrow(/auth failed/);
    });

    it('states what enabling allow_other_users would expose, at the point of refusal', async () => {
        const { adapter } = directory();
        const r = new IdentityResolver(adapter, { default_user: 'Bartus', allow_other_users: false });

        const err = await rejection(r.resolve('Guest'));
        expect(err.kind).toBe('AuthFailed');
        expect(err.remedy).toMatch(/every user's history/);
        // .message (what a tool that only surfaces the caught error's message
        // sees) must carry the same sentence, not just the .remedy field.
        expect(err.message).toMatch(/every user's history/);
        expect(err.toModelText()).toMatch(/every user's history/);
    });
});
