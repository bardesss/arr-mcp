import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthSchema, ConfigSchema } from '../src/config/schema.ts';
import { api, closeApi, seedApi } from './helpers/apiStack.ts';

beforeEach(async () => {
    await seedApi();
});

afterEach(async () => {
    await closeApi();
});

/**
 * Every config key the owner can set, and where the management API reads it.
 * A new key fails here until someone decides: an endpoint, or a reason it stays
 * on the config page.
 */
const COVERAGE: Record<string, { api: string } | { pageOnly: string }> = {
    'auth.bearer_token': { pageOnly: 'pre-1.34 token, normalised into tokens on load' },
    'auth.tokens': { api: '/token' },
    'auth.username': { pageOnly: 'the config page login' },
    'auth.password_hash': { pageOnly: 'the config page login' },
    'auth.allow_token_in_url': { api: '/settings/mcp' },
    'auth.allowed_hosts': { api: '/settings/mcp' },
    'auth.oauth': { api: '/settings/mcp' },
    'auth.management_key': { pageOnly: 'the API key cannot rotate itself' },
    services: { api: '/app' },
    primary_media_server: { api: '/settings/media-servers' },
    metadata: { api: '/settings/imdb' },
    ui: { pageOnly: 'the config page theme' }
};

const schemaKeys = [
    ...Object.keys(ConfigSchema.shape).filter(k => k !== 'auth'),
    ...Object.keys(AuthSchema.shape).map(k => `auth.${k}`)
];

describe('management API parity', () => {
    it('places every config key', () => {
        expect(Object.keys(COVERAGE).sort()).toEqual(schemaKeys.sort());
    });

    it('serves every endpoint it names', async () => {
        const paths = new Set(Object.values(COVERAGE).flatMap(c => ('api' in c ? [c.api] : [])));
        for (const path of paths) expect((await api(path)).status, path).toBe(200);
    });
});
