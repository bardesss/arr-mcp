import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { loadConfig } from '../src/config/load.ts';

const freshDir = () => mkdtemp(join(tmpdir(), 'arr-mcp-cfg-'));
const AUTH = { bearer_token: 'a'.repeat(64) };

describe('ConfigSchema', () => {
    it('defaults both permission tiers to off for a newly added service', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://192.168.1.20:7878', api_key: 'k' } }
        });
        expect(parsed.services.radarr?.permissions).toEqual({ safe_write: false, destructive: false });
    });

    it('defaults the per-service timeout to 10 seconds', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878', api_key: 'k' } }
        });
        expect(parsed.services.radarr?.timeout_ms).toBe(10_000);
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
        expect(parsed.services.radarr?.timeout_ms).toBe(10_000);
        expect(parsed.services.radarr?.permissions).toEqual({ safe_write: false, destructive: false });
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
        expect(config.services.radarr?.permissions.safe_write).toBe(true);
        expect(config.services.radarr?.permissions.destructive).toBe(false);
    });
});
