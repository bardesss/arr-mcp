import { describe, expect, it } from 'vitest';
import { listInstances } from '../src/config/instances.ts';
import { ConfigEditError, addInstance, removeInstance, updateInstance } from '../src/config/mutate.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';

/**
 * The config algebra behind the Configuration page, tested without a browser.
 *
 * These are the operations that must not go wrong quietly: a bad edit that
 * reached disk would take the running instance down on the next reload, and a
 * silent rename would move a permission key out from under a live grant.
 */

const AUTH = { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [], allow_token_in_url: false };
const base = (services: unknown = {}): Config => ConfigSchema.parse({ auth: AUTH, services });

const ids = (config: Config) => listInstances(config).map(i => i.id);
const KEYED = { url: 'http://192.0.2.10:7878', api_key: 'k' };

describe('adding an instance', () => {
    it('adds the first one with no name, keeping the bare id', () => {
        const next = addInstance(base(), { type: 'radarr', fields: KEYED });
        expect(ids(next)).toEqual(['radarr']);
    });

    it('refuses a second instance of a service that may only have one', () => {
        const one = base({ prowlarr: KEYED });
        expect(() => addInstance(one, { type: 'prowlarr', name: 'b', fields: KEYED })).toThrow(ConfigEditError);
    });

    /**
     * The rename that adding a second instance forces. The existing id is the
     * permission key, the audit column, and what the agent passes — so it is
     * never changed without the caller having said what to change it to.
     */
    it('refuses to rename the existing instance behind the caller’s back', () => {
        const one = base({ radarr: KEYED });
        expect(() =>
            addInstance(one, { type: 'radarr', name: '4k', fields: KEYED })
        ).toThrow(/naming the one you already have/);
    });

    it('renames the existing instance when told what to call it', () => {
        const one = base({ radarr: { ...KEYED, permissions: { safe_write: true, destructive: false } } });
        const two = addInstance(one, {
            type: 'radarr',
            name: '4k',
            renameExistingTo: 'hd',
            fields: { url: 'http://192.0.2.11:7878', api_key: 'k2' }
        });

        expect(ids(two)).toEqual(['radarr/4k', 'radarr/hd']);
    });

    it('carries the existing instance’s permissions through the rename', () => {
        const one = base({ radarr: { ...KEYED, permissions: { safe_write: true, destructive: false } } });
        const two = addInstance(one, {
            type: 'radarr',
            name: '4k',
            renameExistingTo: 'hd',
            fields: { url: 'http://192.0.2.11:7878', api_key: 'k2' }
        });

        const hd = listInstances(two).find(i => i.id === 'radarr/hd');
        expect(hd?.config.permissions.safe_write).toBe(true);
        // The new one starts with nothing granted, like any service added by hand.
        const fourK = listInstances(two).find(i => i.id === 'radarr/4k');
        expect(fourK?.config.permissions).toEqual({ safe_write: false, destructive: false });
    });

    it('refuses a duplicate name', () => {
        const two = addInstance(base({ radarr: KEYED }), {
            type: 'radarr',
            name: '4k',
            renameExistingTo: 'hd',
            fields: KEYED
        });
        expect(() => addInstance(two, { type: 'radarr', name: '4K', fields: KEYED })).toThrow(/already has an instance/);
    });

    it('refuses an edit that would produce an invalid config, before it reaches disk', () => {
        expect(() => addInstance(base(), { type: 'radarr', fields: { url: 'not-a-url', api_key: 'k' } })).toThrow(
            ConfigEditError
        );
        expect(() => addInstance(base(), { type: 'radarr', fields: { url: KEYED.url } })).toThrow(ConfigEditError);
    });
});

describe('updating an instance', () => {
    const two = () =>
        addInstance(base({ radarr: KEYED }), {
            type: 'radarr',
            name: '4k',
            renameExistingTo: 'hd',
            fields: { url: 'http://192.0.2.11:7878', api_key: 'k2' }
        });

    it('leaves every other instance byte-identical', () => {
        const before = two();
        const after = updateInstance(before, 'radarr/4k', { url: 'http://192.0.2.99:7878' });

        const hdBefore = listInstances(before).find(i => i.id === 'radarr/hd');
        const hdAfter = listInstances(after).find(i => i.id === 'radarr/hd');
        expect(hdAfter?.config).toEqual(hdBefore?.config);
    });

    it('keeps the stored API key when the field is blank', () => {
        const after = updateInstance(two(), 'radarr/hd', { url: KEYED.url, api_key: '' });
        const hd = listInstances(after).find(i => i.id === 'radarr/hd');
        expect((hd?.config as { api_key: string }).api_key).toBe('k');
    });

    it('replaces the API key when a new one is given', () => {
        const after = updateInstance(two(), 'radarr/hd', { api_key: 'rotated' });
        const hd = listInstances(after).find(i => i.id === 'radarr/hd');
        expect((hd?.config as { api_key: string }).api_key).toBe('rotated');
    });

    it('refuses an unknown instance rather than silently doing nothing', () => {
        expect(() => updateInstance(two(), 'radarr/uhd', { url: KEYED.url })).toThrow(/not configured/);
    });
});

describe('removing an instance', () => {
    const two = () =>
        addInstance(base({ radarr: KEYED }), {
            type: 'radarr',
            name: '4k',
            renameExistingTo: 'hd',
            fields: { url: 'http://192.0.2.11:7878', api_key: 'k2' }
        });

    it('drops exactly one', () => {
        expect(ids(removeInstance(two(), 'radarr/4k'))).toEqual(['radarr/hd']);
    });

    /**
     * Collapsing `radarr/hd` back to `radarr` would be a second silent rename,
     * undoing the one the user was explicitly asked to approve.
     */
    it('leaves the last instance named rather than collapsing it', () => {
        const one = removeInstance(two(), 'radarr/4k');
        expect(ids(one)).toEqual(['radarr/hd']);
        expect(listInstances(one)[0]?.name).toBe('hd');
    });

    it('removes the service entirely when its last instance goes', () => {
        const none = removeInstance(removeInstance(two(), 'radarr/4k'), 'radarr/hd');
        expect(ids(none)).toEqual([]);
        expect(none.services.radarr).toBeUndefined();
    });

    it('removes an unnamed single instance', () => {
        expect(ids(removeInstance(base({ radarr: KEYED }), 'radarr'))).toEqual([]);
    });
});

/**
 * The keys these operations have no business touching.
 *
 * Not a hypothetical: `validate` used to rebuild the config from `auth` and
 * `services` alone, and since `saveConfig` deletes an absent `metadata` block,
 * editing a timeout on any card switched the IMDb dataset off and closed the
 * database. Nothing caught it, because every test here asked only about
 * `services`.
 */
describe('editing an instance leaves the rest of the config alone', () => {
    const withDataset = (services: unknown = { radarr: KEYED }): Config =>
        ConfigSchema.parse({ auth: AUTH, services, metadata: { imdb: { enabled: true } } });

    it('keeps the dataset switched on across an add', () => {
        const next = addInstance(withDataset({}), { type: 'radarr', fields: KEYED });
        expect(next.metadata?.imdb?.enabled).toBe(true);
    });

    it('keeps the dataset switched on across an update', () => {
        const next = updateInstance(withDataset(), 'radarr', { timeout_ms: 12_000 });
        expect(next.metadata?.imdb?.enabled).toBe(true);
    });

    it('keeps the dataset switched on across a removal', () => {
        const next = removeInstance(withDataset(), 'radarr');
        expect(next.metadata?.imdb?.enabled).toBe(true);
    });

    it('leaves auth untouched', () => {
        const next = updateInstance(withDataset(), 'radarr', { timeout_ms: 12_000 });
        expect(next.auth).toEqual(AUTH);
    });
});
