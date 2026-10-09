import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppBody } from '../src/api/bodies.ts';
import { AuthSchema, ConfigSchema, ServiceIdSchema } from '../src/config/schema.ts';
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

/** Each service field, as `GET /app` shows it and the body field that sets it. */
const SERVICE_FIELDS: Record<string, { read: string[]; write: string[] }> = {
    url: { read: ['url'], write: ['url'] },
    timeout_ms: { read: ['timeoutMs'], write: ['timeoutMs'] },
    permissions: { read: ['safeWrite', 'destructive'], write: ['safeWrite', 'destructive'] },
    safe_write: { read: ['safeWrite'], write: ['safeWrite'] },
    destructive: { read: ['destructive'], write: ['destructive'] },
    api_key: { read: ['apiKeySet'], write: ['apiKey'] },
    name: { read: ['name'], write: ['name'] },
    default_user: { read: ['defaultUser'], write: ['defaultUser'] },
    allow_other_users: { read: ['allowOtherUsers'], write: ['allowOtherUsers'] },
    username: { read: ['username'], write: ['username'] },
    password: { read: ['passwordSet'], write: ['password'] },
    allow_metadata_repair: { read: ['allowMetadataRepair'], write: ['allowMetadataRepair'] }
};

type Def = { type: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown; in?: unknown; out?: unknown; options?: unknown[] };

/** Every object key under a schema, through optionals, unions, lists and pipes. */
const keysUnder = (schema: unknown, found = new Set<string>()): Set<string> => {
    const def = (schema as { _zod: { def: Def } })._zod.def;
    const fields = def.type === 'object' ? Object.entries(def.shape ?? {}) : [];
    for (const [key] of fields) found.add(key);
    for (const inner of [...fields.map(([, v]) => v), def.innerType, def.element, def.in, def.out, ...(def.options ?? [])]) {
        if (inner !== undefined) keysUnder(inner, found);
    }
    return found;
};

const schemaKeys = [
    ...Object.keys(ConfigSchema.shape).filter(k => k !== 'auth'),
    ...Object.keys(AuthSchema.shape).map(k => `auth.${k}`)
];

describe('management API parity', () => {
    it('places every config key', () => {
        expect(Object.keys(COVERAGE).sort()).toEqual(schemaKeys.sort());
    });

    it('places every service field', () => {
        const ids: readonly string[] = ServiceIdSchema.options;
        const fields = [...keysUnder(ConfigSchema.shape.services)].filter(k => !ids.includes(k));
        expect(Object.keys(SERVICE_FIELDS).sort()).toEqual(fields.sort());
    });

    it('reads and writes every service field on /app', async () => {
        await seedApi({ extra: ["  plex: { url: 'http://plex:32400', api_key: 'plex-token-000', default_user: alice }"] });
        const apps = (await (await api('/app')).json()) as Record<string, unknown>[];
        const shown = new Set(apps.flatMap(a => Object.keys(a)));
        const writable = Object.keys(AppBody.shape);
        for (const [field, { read, write }] of Object.entries(SERVICE_FIELDS)) {
            for (const name of read) expect(shown.has(name), `${field} as ${name}`).toBe(true);
            for (const name of write) expect(writable, field).toContain(name);
        }
    });

    it('serves every endpoint it names', async () => {
        const paths = new Set(Object.values(COVERAGE).flatMap(c => ('api' in c ? [c.api] : [])));
        for (const path of paths) expect((await api(path)).status, path).toBe(200);
    });
});
