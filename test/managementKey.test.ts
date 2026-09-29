import { describe, expect, it } from 'vitest';
import { clearManagementKey, setManagementKey } from '../src/config/edits.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { generateManagementKey, matchesManagementKey } from '../src/core/managementKey.ts';
import { hashToken } from '../src/core/mcpTokens.ts';

const base = () => ConfigSchema.parse({ auth: { username: 'admin' }, services: {} });

describe('management key', () => {
    it('is amk_ plus 64 hex', () => {
        expect(generateManagementKey()).toMatch(/^amk_[0-9a-f]{64}$/);
    });

    it('matches only the key it was hashed from', () => {
        const key = generateManagementKey();
        const stored = { hash: hashToken(key) };
        expect(matchesManagementKey(key, stored)).toBe(true);
        expect(matchesManagementKey(generateManagementKey(), stored)).toBe(false);
        expect(matchesManagementKey(undefined, stored)).toBe(false);
        expect(matchesManagementKey('', stored)).toBe(false);
        expect(matchesManagementKey(key, undefined)).toBe(false);
    });

    it('stores a hash and a date, never the key', () => {
        const { config, plaintext } = setManagementKey(base(), new Date('2026-09-29T12:00:00Z'));
        expect(config.auth.management_key).toEqual({ hash: hashToken(plaintext), created: '2026-09-29' });
        expect(JSON.stringify(config)).not.toContain(plaintext);
        expect(ConfigSchema.safeParse(config).success).toBe(true);
    });

    it('clears to no block at all', () => {
        const { config } = setManagementKey(base(), new Date());
        expect('management_key' in clearManagementKey(config).auth).toBe(false);
    });

    it('refuses a plaintext key in config.yaml', () => {
        const parsed = ConfigSchema.safeParse({
            auth: { username: 'admin', management_key: { key: 'amk_x', created: '2026-09-29' } },
            services: {}
        });
        expect(parsed.success).toBe(false);
    });
});
