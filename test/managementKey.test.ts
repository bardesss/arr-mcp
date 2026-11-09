import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addManagementKey, revokeManagementKey } from '../src/config/edits.ts';
import { ConfigInvalidError, loadConfig } from '../src/config/load.ts';
import { saveConfig } from '../src/config/save.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { generateManagementKey, managementKeyLabel, matchManagementKey } from '../src/core/managementKey.ts';
import { hashToken } from '../src/core/secrets.ts';

const base = () => ConfigSchema.parse({ auth: { username: 'admin' }, services: {} });
const HASH = hashToken('a stored key');

describe('management keys', () => {
    it('is amk_ plus 64 hex', () => {
        expect(generateManagementKey()).toMatch(/^amk_[0-9a-f]{64}$/);
    });

    it('finds the key it was hashed from among several', () => {
        const one = generateManagementKey();
        const two = generateManagementKey();
        const stored = [
            { name: 'one', tier: 'read' as const, hash: hashToken(one), created: '2026-09-29' },
            { name: 'two', tier: 'admin' as const, hash: hashToken(two), created: '2026-09-29' }
        ];
        expect(matchManagementKey(one, stored)?.name).toBe('one');
        expect(matchManagementKey(two, stored)?.name).toBe('two');
        expect(matchManagementKey(generateManagementKey(), stored)).toBeUndefined();
        expect(matchManagementKey(undefined, stored)).toBeUndefined();
        expect(matchManagementKey('', stored)).toBeUndefined();
        expect(matchManagementKey(one, [])).toBeUndefined();
    });

    it('labels a key by name and fingerprint, never by its hash', () => {
        const label = managementKeyLabel({ name: 'nzb360', tier: 'read', hash: HASH, created: '2026-09-29' });
        expect(label).toBe(`nzb360#${HASH.slice(7, 15)}`);
    });

    it('stores a hash, a tier and a date, never the key', () => {
        const { config, plaintext } = addManagementKey(base(), { name: 'nzb360', tier: 'read' }, new Date('2026-09-29T12:00:00Z'));
        expect(config.auth.management_keys).toEqual([{ name: 'nzb360', tier: 'read', hash: hashToken(plaintext), created: '2026-09-29' }]);
        expect(JSON.stringify(config)).not.toContain(plaintext);
        expect(ConfigSchema.safeParse(config).success).toBe(true);
    });

    it('refuses a name already taken, whatever its case', () => {
        const { config } = addManagementKey(base(), { name: 'nzb360', tier: 'read' }, new Date());
        expect(() => addManagementKey(config, { name: 'NZB360', tier: 'admin' }, new Date())).toThrow('already a key named');
    });

    it('refuses a name the schema would not load', () => {
        for (const name of ['', 'has space', '-leading', 'a/b']) {
            expect(() => addManagementKey(base(), { name, tier: 'read' }, new Date()), name).toThrow('Key names must be');
        }
    });

    it('revokes one key and leaves the others', () => {
        const first = addManagementKey(base(), { name: 'one', tier: 'read' }, new Date()).config;
        const both = addManagementKey(first, { name: 'two', tier: 'admin' }, new Date()).config;
        expect(revokeManagementKey(both, 'ONE').auth.management_keys?.map(k => k.name)).toEqual(['two']);
    });

    it('revoking the last key leaves no block at all', () => {
        const { config } = addManagementKey(base(), { name: 'one', tier: 'read' }, new Date());
        expect('management_keys' in revokeManagementKey(config, 'one').auth).toBe(false);
    });

    it('refuses to revoke a name it does not have', () => {
        expect(() => revokeManagementKey(base(), 'nope')).toThrow('No key named');
    });
});

describe('management keys in config.yaml', () => {
    const parsed = (auth: Record<string, unknown>) => ConfigSchema.safeParse({ auth: { username: 'admin', ...auth }, services: {} });
    const key = (over: Record<string, unknown> = {}) => ({ name: 'one', tier: 'read', hash: HASH, created: '2026-09-29', ...over });

    it('refuses a plaintext key', () => {
        expect(parsed({ management_key: { key: 'amk_x', created: '2026-09-29' } }).success).toBe(false);
        expect(parsed({ management_keys: [{ name: 'one', tier: 'read', key: 'amk_x', created: '2026-09-29' }] }).success).toBe(false);
    });

    it('refuses an unknown tier', () => {
        expect(parsed({ management_keys: [key({ tier: 'destructive' })] }).success).toBe(false);
    });

    it('refuses two keys with one name, whatever their case', () => {
        expect(parsed({ management_keys: [key(), key({ name: 'ONE' })] }).success).toBe(false);
    });

    it('turns the single key into an admin key named default', () => {
        const result = parsed({ management_key: { hash: HASH, created: '2026-09-29' } });
        expect(result.data?.auth.management_keys).toEqual([{ name: 'default', tier: 'admin', hash: HASH, created: '2026-09-29' }]);
        expect(result.data?.auth).not.toHaveProperty('management_key');
    });

    it('refuses the single key beside the list', () => {
        expect(parsed({ management_key: { hash: HASH, created: '2026-09-29' }, management_keys: [key()] }).success).toBe(false);
    });

    it('adds no key to an auth block that has none', () => {
        expect(base().auth).not.toHaveProperty('management_keys');
    });

    it('treats an empty list as off', () => {
        expect(parsed({ management_keys: [] }).data?.auth).not.toHaveProperty('management_keys');
    });

    const inDir = async (text: string, run: (dir: string) => Promise<void>) => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-keys-'));
        try {
            await writeFile(join(dir, 'config.yaml'), text, 'utf8');
            await run(dir);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    };

    it('leaves the single key on disk until the next save, then writes the list', async () => {
        const text = `auth:\n  username: admin\n  management_key: { hash: '${HASH}', created: '2026-09-29' }\nservices: {}\n`;
        await inDir(text, async dir => {
            const { config } = await loadConfig(dir);
            expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(text);

            const next = addManagementKey(config, { name: 'nzb360', tier: 'read' }, new Date()).config;
            await saveConfig(dir, next, { expected: config });

            const saved = await readFile(join(dir, 'config.yaml'), 'utf8');
            expect(saved).not.toContain('management_key:');
            const reloaded = await loadConfig(dir);
            expect(reloaded.config.auth.management_keys?.map(k => [k.name, k.tier])).toEqual([['default', 'admin'], ['nzb360', 'read']]);
        });
    });

    it('does not write a list into a file that never had a key', async () => {
        await inDir('auth:\n  username: admin\nservices: {}\n', async dir => {
            const { config } = await loadConfig(dir);
            await saveConfig(dir, { ...config, auth: { ...config.auth, username: 'root' } }, { expected: config });
            expect(await readFile(join(dir, 'config.yaml'), 'utf8')).not.toContain('management_keys');
        });
    });

    it('a broken key entry does not cost the repair editor its sign-in', async () => {
        await inDir(`auth:\n  username: admin\n  password_hash: scrypt$00$11\n  management_keys:\n    - { name: one, tier: nope }\nservices: {}\n`, async dir => {
            const failure = await loadConfig(dir).catch((err: unknown) => err);
            expect(failure).toBeInstanceOf(ConfigInvalidError);
            expect((failure as ConfigInvalidError).auth?.password_hash).toBe('scrypt$00$11');
        });
    });
});
