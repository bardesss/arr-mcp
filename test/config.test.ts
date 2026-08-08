import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { loadConfig } from '../src/config/load.ts';
import { saveConfig } from '../src/config/save.ts';

/** The list form makes each service key a union; every assertion here is
 *  about the single form, so this narrows once rather than at each call. */
const single = (value: unknown): KeyedServiceConfig | undefined => value as KeyedServiceConfig | undefined;

const freshDir = () => mkdtemp(join(tmpdir(), 'arr-mcp-cfg-'));
/**
 * A literal hash rather than `hashPassword('…')`: scrypt is deliberately slow
 * (~50ms), and paying that in every schema test would add seconds to the suite
 * to prove something `session.test.ts` already proves properly.
 */
const AUTH = { bearer_token: 'a'.repeat(64), password_hash: 'scrypt$00$11' };

describe('reading without writing', () => {
    /**
     * The maintainer scripts load this file only to reach the services it
     * names. A read must not have side effects on the user's credentials.
     *
     * Before `persist: false` existed, `npm run integration` against a config
     * predating the config UI silently backfilled a `password_hash` into it —
     * generating a password the script never printed, so nobody could ever
     * know it. It happened to a real config.
     */
    it('leaves a config missing the new credentials completely untouched', async () => {
        const dir = await freshDir();
        const path = join(dir, 'config.yaml');
        const original = `auth:\n  bearer_token: ${'c'.repeat(64)}\nservices:\n  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\n`;
        await writeFile(path, original, 'utf8');

        const { config } = await loadConfig(dir, { persist: false });

        // Unclaimed in memory, because inventing a password is precisely the
        // side effect this test exists to prevent…
        expect(config.auth.password_hash).toBeUndefined();
        // …and on disk nothing moved.
        expect(await readFile(path, 'utf8')).toBe(original);
    });

    /**
     * The inverse of what this test used to assert. Backfilling a generated
     * password was how a missing hash got repaired; now a missing hash is a
     * state — unclaimed — and repairing it would claim the instance on the
     * user's behalf with a password only the log ever saw.
     */
    it('never invents a password, even when persisting', async () => {
        const dir = await freshDir();
        const path = join(dir, 'config.yaml');
        await writeFile(path, `auth:\n  bearer_token: ${'d'.repeat(64)}\nservices: {}\n`, 'utf8');

        const { config } = await loadConfig(dir);

        expect(config.auth.password_hash).toBeUndefined();
        expect(await readFile(path, 'utf8')).not.toContain('password_hash');
    });

    it('still backfills a missing bearer token, which has no interactive path', async () => {
        const dir = await freshDir();
        const path = join(dir, 'config.yaml');
        await writeFile(path, 'auth: {}\nservices: {}\n', 'utf8');

        const { generated } = await loadConfig(dir);

        expect(generated.bearerToken).toHaveLength(64);
        expect(await readFile(path, 'utf8')).toContain('bearer_token');
    });

    // A script pointed at the wrong directory should say so, not create one.
    it('refuses to invent a config directory when reading only', async () => {
        const dir = await freshDir();
        await expect(loadConfig(join(dir, 'nope'), { persist: false })).rejects.toThrow(/no config\.yaml/);
    });
});

describe('ConfigSchema', () => {
    it('defaults both permission tiers to off for a newly added service', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://192.168.1.20:7878', api_key: 'k' } }
        });
        expect(single(parsed.services.radarr)?.permissions).toEqual({ safe_write: false, destructive: false });
    });

    it('defaults the per-service timeout to 10 seconds', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878', api_key: 'k' } }
        });
        expect(single(parsed.services.radarr)?.timeout_ms).toBe(10_000);
    });

    it('defaults allowed_hosts to an empty list', () => {
        const parsed = ConfigSchema.parse({ auth: AUTH, services: {} });
        expect(parsed.auth.allowed_hosts).toEqual([]);
    });

    it('rejects a service url that is not http(s)', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { radarr: { url: 'ftp://h:7878', api_key: 'k' } }
        });
        expect(result.success).toBe(false);
    });

    it('rejects an empty api key rather than silently accepting it', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878', api_key: '' } }
        });
        expect(result.success).toBe(false);
    });

    it('rejects a config whose auth block was deleted by hand', () => {
        expect(ConfigSchema.safeParse({ services: {} }).success).toBe(false);
    });

    it('rejects an unknown service id', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { plex: { url: 'http://h:32400', api_key: 'k' } }
        });
        expect(result.success).toBe(false);
    });
});

describe('an unclaimed config', () => {
    it('parses a config with no password_hash', () => {
        const parsed = ConfigSchema.parse({
            auth: { bearer_token: 'a'.repeat(64) },
            services: {}
        });
        expect(parsed.auth.password_hash).toBeUndefined();
    });

    /**
     * `setIn` with `undefined` writes a null-valued key, which reads back as a
     * *claimed* instance holding an empty hash — one nobody can sign in to and
     * that the setup page will not rescue, because it no longer looks
     * unclaimed. The only step in the unclaimed change the types do not catch.
     */
    it('omits password_hash from the file rather than writing a null', async () => {
        const dir = await freshDir();
        const path = join(dir, 'config.yaml');
        await writeFile(path, `auth:\n  bearer_token: ${'e'.repeat(64)}\nservices: {}\n`, 'utf8');

        await saveConfig(
            dir,
            ConfigSchema.parse({ auth: { bearer_token: 'e'.repeat(64) }, services: {} })
        );

        const written = await readFile(path, 'utf8');
        expect(written).not.toContain('password_hash');
        expect(written).not.toContain('null');
    });
});

describe('per-service config shapes', () => {
    it('accepts transmission with username and password and no api_key', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { transmission: { url: 'http://h:9091', username: 'u', password: 'p' } }
        });
        expect(parsed.services.transmission?.username).toBe('u');
    });

    it('accepts transmission with no credentials at all — LAN RPC is often unauthenticated', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { transmission: { url: 'http://h:9091' } }
        });
        expect(result.success).toBe(true);
    });

    it('rejects an api_key on transmission rather than silently ignoring it', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { transmission: { url: 'http://h:9091', api_key: 'k' } }
        });
        expect(result.success).toBe(false);
    });

    it('still requires an api_key on radarr', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878' } }
        });
        expect(result.success).toBe(false);
    });

    it('defaults allow_other_users to false on jellyfin', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { jellyfin: { url: 'http://h:8096', api_key: 'k' } }
        });
        expect(parsed.services.jellyfin?.allow_other_users).toBe(false);
    });

    it('leaves default_user unset when it is not configured', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { jellyfin: { url: 'http://h:8096', api_key: 'k' } }
        });
        expect(parsed.services.jellyfin?.default_user).toBeUndefined();
    });

    it('carries default_user through when configured', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { seerr: { url: 'http://h:5055', api_key: 'k', default_user: 'bartus' } }
        });
        expect(parsed.services.seerr?.default_user).toBe('bartus');
    });

    it('rejects default_user on a single-tenant service, which has no users', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878', api_key: 'k', default_user: 'bartus' } }
        });
        expect(result.success).toBe(false);
    });

    it('rejects a misspelled key rather than dropping it silently', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878', api_key: 'k', timout_ms: 500 } }
        });
        expect(result.success).toBe(false);
    });

    it('keeps an existing Phase 1 radarr-only config valid', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://192.168.1.20:7878', api_key: 'k' } }
        });
        expect(single(parsed.services.radarr)?.timeout_ms).toBe(10_000);
        expect(single(parsed.services.radarr)?.permissions).toEqual({ safe_write: false, destructive: false });
    });

    it('accepts all eight services configured at once', () => {
        const keyed = (port: number) => ({ url: `http://h:${port}`, api_key: 'k' });
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: {
                radarr: keyed(7878),
                sonarr: keyed(8989),
                prowlarr: keyed(9696),
                bazarr: keyed(6767),
                sabnzbd: keyed(8080),
                jellyfin: { ...keyed(8096), default_user: 'Bartus' },
                seerr: { ...keyed(5055), default_user: 'bartus', allow_other_users: true },
                transmission: { url: 'http://h:9091', username: 'u', password: 'p' }
            }
        });

        expect(Object.keys(parsed.services).sort()).toEqual([
            'bazarr',
            'jellyfin',
            'prowlarr',
            'radarr',
            'sabnzbd',
            'seerr',
            'sonarr',
            'transmission'
        ]);
        expect(parsed.services.seerr?.allow_other_users).toBe(true);
    });
});

describe('loadConfig', () => {
    it('creates config.yaml with a generated bearer token on first run', async () => {
        const dir = await freshDir();
        const { config, created } = await loadConfig(dir);

        expect(created).toBe(true);
        expect(config.auth.bearer_token).toMatch(/^[0-9a-f]{64}$/);
        // and it is persisted, not just returned
        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain(config.auth.bearer_token);
    });

    it('is stable across restarts — the token is not regenerated', async () => {
        const dir = await freshDir();
        const first = await loadConfig(dir);
        const second = await loadConfig(dir);

        expect(second.created).toBe(false);
        expect(second.config.auth.bearer_token).toBe(first.config.auth.bearer_token);
    });

    it('generates a distinct token per install', async () => {
        const [a, b] = await Promise.all([freshDir(), freshDir()]);
        const [one, two] = await Promise.all([loadConfig(a), loadConfig(b)]);

        expect(one.config.auth.bearer_token).not.toBe(two.config.auth.bearer_token);
    });

    it('throws an actionable error when config.yaml is malformed', async () => {
        const dir = await freshDir();
        await writeFile(join(dir, 'config.yaml'), 'services: [this is not a map]', 'utf8');

        await expect(loadConfig(dir)).rejects.toThrow(/config\.yaml/);
    });

    it('throws an actionable error when config.yaml is not valid YAML at all', async () => {
        const dir = await freshDir();
        await writeFile(join(dir, 'config.yaml'), 'auth: {unclosed', 'utf8');

        await expect(loadConfig(dir)).rejects.toThrow(/not valid YAML/);
    });

    it('backfills a missing bearer token rather than failing to start', async () => {
        const dir = await freshDir();
        await writeFile(join(dir, 'config.yaml'), 'services: {}\n', 'utf8');

        const { config } = await loadConfig(dir);
        expect(config.auth.bearer_token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('names the offending field when a service is misconfigured', async () => {
        const dir = await freshDir();
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  bearer_token: ${'a'.repeat(64)}\nservices:\n  radarr:\n    url: not-a-url\n    api_key: k\n`,
            'utf8'
        );

        await expect(loadConfig(dir)).rejects.toThrow(/url/);
    });

    it('reads a valid hand-written config', async () => {
        const dir = await freshDir();
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  bearer_token: ${'b'.repeat(64)}\n  allowed_hosts:\n    - arr.example.com\nservices:\n  radarr:\n    url: http://192.168.1.20:7878\n    api_key: abc\n    permissions:\n      safe_write: true\n      destructive: false\n`,
            'utf8'
        );

        const { config, created } = await loadConfig(dir);
        expect(created).toBe(false);
        expect(config.auth.allowed_hosts).toEqual(['arr.example.com']);
        expect(single(config.services.radarr)?.permissions.safe_write).toBe(true);
        expect(single(config.services.radarr)?.permissions.destructive).toBe(false);
    });
});

/**
 * The IMDb dataset's config block (0.8 spec §3).
 *
 * It holds no credential, which is why there is nothing here about secrets
 * being echoed back — the rule the rest of the config page is shaped by does
 * not apply to a boolean.
 */
describe('the metadata block', () => {
    it('is absent by default, the same as any service nobody configured', () => {
        const parsed = ConfigSchema.parse({ auth: AUTH, services: {} });
        expect(parsed.metadata).toBeUndefined();
    });

    it('accepts the dataset being switched on', () => {
        const parsed = ConfigSchema.parse({ auth: AUTH, services: {}, metadata: { imdb: { enabled: true } } });
        expect(parsed.metadata?.imdb?.enabled).toBe(true);
    });

    it('defaults enabled to false, so a bare block does not start a download', () => {
        const parsed = ConfigSchema.parse({ auth: AUTH, services: {}, metadata: { imdb: {} } });
        expect(parsed.metadata?.imdb?.enabled).toBe(false);
    });

    /**
     * IMDb publishes daily, so there is no second sensible interval to choose
     * between. The setting a user is most likely to invent is therefore one
     * that cannot mean anything — and silently ignoring it is worse than
     * refusing it, because a user who sets it believes it took effect.
     */
    it('refuses a refresh interval, which is not a setting', () => {
        expect(() =>
            ConfigSchema.parse({
                auth: AUTH,
                services: {},
                metadata: { imdb: { enabled: true, refresh: 'hourly' } }
            })
        ).toThrow();
    });

    it('refuses an unknown provider rather than ignoring it', () => {
        expect(() =>
            ConfigSchema.parse({ auth: AUTH, services: {}, metadata: { tmdb: { api_key: 'k' } } })
        ).toThrow();
    });
});

/**
 * `saveConfig` edits an existing YAML document in place rather than
 * re-serialising the parsed config, so a key it does not know about is
 * preserved by omission rather than by design. That is worth a test: the
 * config UI rewrites this file on every save, and a `metadata` block that
 * vanished the first time someone changed a timeout would be a silent
 * downgrade nobody would connect to the save that caused it.
 */
describe('the metadata block through a save', () => {
    it('survives a save that was about something else entirely', async () => {
        const dir = await freshDir();
        const path = join(dir, 'config.yaml');
        await writeFile(
            path,
            `auth:\n  bearer_token: ${'d'.repeat(64)}\n  password_hash: scrypt$00$11\nservices:\n  radarr:\n    url: http://192.0.2.10:7878\n    api_key: k\nmetadata:\n  imdb:\n    enabled: true\n`,
            'utf8'
        );

        const { config } = await loadConfig(dir);
        expect(config.metadata?.imdb?.enabled).toBe(true);

        await saveConfig(dir, config);

        const reloaded = await loadConfig(dir);
        expect(reloaded.config.metadata?.imdb?.enabled).toBe(true);
        expect(await readFile(path, 'utf8')).toContain('metadata:');
    });
});
