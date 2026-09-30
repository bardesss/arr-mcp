import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configEtag } from '../src/config/etag.ts';
import { stableJson } from '../src/config/save.ts';
import { ConfigSchema } from '../src/config/schema.ts';

const config = ConfigSchema.parse({ auth: { username: 'admin', allowed_hosts: [] }, services: {} });

describe('configEtag', () => {
    it('is a strong 16-hex tag, stable within the process', () => {
        const tag = configEtag(config);
        expect(tag).toMatch(/^"[0-9a-f]{16}"$/);
        expect(configEtag(structuredClone(config))).toBe(tag);
    });

    it('changes when the config changes', () => {
        const other = { ...config, auth: { ...config.auth, username: 'owner' } };
        expect(configEtag(other)).not.toBe(configEtag(config));
    });

    it('is keyed, so it cannot be recomputed offline from a guessed config', () => {
        const plain = createHash('sha256').update(stableJson(config)).digest('hex').slice(0, 16);
        expect(configEtag(config)).not.toBe(`"${plain}"`);
    });
});
