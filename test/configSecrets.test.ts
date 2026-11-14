import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appResource } from '../src/api/resources.ts';
import { listInstances } from '../src/config/instances.ts';
import { ConfigInvalidError, loadConfig, validateConfigText } from '../src/config/load.ts';
import { addInstance, ConfigEditError, CredentialWouldMoveError, updateInstance } from '../src/config/mutate.ts';
import { saveConfig } from '../src/config/save.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { resolveSecrets, secretSource, SecretSourceError } from '../src/config/secretSources.ts';
import { buildAdapters } from '../src/services/registry.ts';
import { configPage } from '../src/web/configPage.ts';

/** Secrets read from a file or the environment instead of config.yaml (#636). */

const AUTH = { bearer_token: 'a'.repeat(64), password_hash: 'scrypt$00$11' };
const AUTH_YAML = `auth:\n  bearer_token: ${'a'.repeat(64)}\n  password_hash: scrypt$00$11\n`;

const dirs: string[] = [];
const freshDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-secrets-'));
    dirs.push(dir);
    return dir;
};

afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 3 })));
});

const parse = (services: Record<string, unknown>): Config => ConfigSchema.parse({ auth: AUTH, services });
const issues = (services: Record<string, unknown>): string[] => {
    const result = ConfigSchema.safeParse({ auth: AUTH, services });
    return result.success ? [] : result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
};

describe('the schema', () => {
    it('takes a file in place of the key, and keeps the reference as written', () => {
        const config = parse({ radarr: { url: 'http://radarr:7878', api_key_file: '/run/secrets/radarr' } });
        expect(config.services.radarr).toMatchObject({ api_key_file: '/run/secrets/radarr' });
        expect(config.services.radarr).not.toHaveProperty('api_key');
    });

    it('takes a file on each instance of a list, and a password file on a credential service', () => {
        const config = parse({
            radarr: [
                { name: 'hd', url: 'http://radarr:7878', api_key_file: '/s/hd' },
                { name: 'uhd', url: 'http://radarr4k:7878', api_key: '${RADARR_UHD}' }
            ],
            qbittorrent: { url: 'http://qb:8080', username: 'admin', password_file: '/s/qb' },
            grimmory: { url: 'http://grimmory:6060', username: 'me', password_file: '/s/grimmory' }
        });
        expect(listInstances(config).map(i => i.id)).toEqual(['grimmory', 'qbittorrent', 'radarr/hd', 'radarr/uhd']);
    });

    it('refuses a key and a key file together', () => {
        expect(issues({ radarr: { url: 'http://radarr:7878', api_key: 'k', api_key_file: '/s/k' } })).toEqual([
            'services.radarr.api_key_file: cannot be set together with api_key; keep one of them'
        ]);
    });

    it('still requires a key where one was required, and names both ways to give it', () => {
        expect(issues({ sonarr: { url: 'http://sonarr:8989' } })).toEqual([
            'services.sonarr.api_key: is required (or name a file with api_key_file)'
        ]);
        expect(issues({ radarr: [{ name: 'hd', url: 'http://radarr:7878' }] })).toEqual([
            'services.radarr.0.api_key: is required (or name a file with api_key_file)'
        ]);
    });

    it('leaves optional credentials optional', () => {
        expect(issues({ shelfmark: { url: 'http://shelfmark:8084' }, transmission: { url: 'http://tx:9091' } })).toEqual([]);
    });

    it('refuses a file key on a service that has no such credential', () => {
        expect(issues({ radarr: { url: 'http://radarr:7878', api_key: 'k', password_file: '/s/p' } })).not.toEqual([]);
    });

    it('keeps the read-only services read-only', () => {
        const config = parse({
            cleanuparr: { url: 'http://c:11011', api_key_file: '/s/c', permissions: { safe_write: true, destructive: true } }
        });
        expect(config.services.cleanuparr?.permissions).toEqual({ safe_write: false, destructive: false });
    });
});

describe('resolveSecrets', () => {
    const files: Record<string, string> = { '/s/radarr': 'filekey\n', '/s/crlf': 'crlfkey\r\n', '/s/two': 'two\n\n' };
    const readFile = (path: string): string => {
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        return text;
    };

    it('reads files minus one trailing newline, and whole-value environment references', () => {
        const config = parse({
            radarr: [
                { name: 'a', url: 'http://a:7878', api_key_file: '/s/radarr' },
                { name: 'b', url: 'http://b:7878', api_key_file: '/s/crlf' },
                { name: 'c', url: 'http://c:7878', api_key_file: '/s/two' }
            ],
            sabnzbd: { url: 'http://sab:8080', api_key: '${SAB_KEY}' },
            transmission: { url: 'http://tx:9091', username: 'tx', password: '${TX_PASS}' }
        });
        const resolved = resolveSecrets(config, { env: { SAB_KEY: 'envkey', TX_PASS: 'envpass' }, readFile });
        expect((resolved.services.radarr as { api_key: string }[]).map(r => r.api_key)).toEqual(['filekey', 'crlfkey', 'two\n']);
        expect(resolved.services.radarr).toEqual(expect.arrayContaining([expect.not.objectContaining({ api_key_file: expect.anything() })]));
        expect(resolved.services.sabnzbd).toMatchObject({ api_key: 'envkey' });
        expect(resolved.services.transmission).toMatchObject({ password: 'envpass' });
        // The config it was given is untouched.
        expect(config.services.sabnzbd).toMatchObject({ api_key: '${SAB_KEY}' });
    });

    it('reads only a whole-value reference, so a key that merely contains ${ is itself', () => {
        const config = parse({ sonarr: { url: 'http://s:8989', api_key: 'abc${SAB_KEY}' } });
        expect(resolveSecrets(config, { env: { SAB_KEY: 'x' }, readFile }).services.sonarr).toMatchObject({ api_key: 'abc${SAB_KEY}' });
        expect(secretSource({ api_key: 'abc${SAB_KEY}' }, 'api_key')).toBeUndefined();
    });

    it('names every instance and field that did not resolve, and no value', () => {
        const config = parse({
            radarr: [{ name: 'hd', url: 'http://a:7878', api_key_file: '/s/missing' }],
            sonarr: { url: 'http://s:8989', api_key: '${UNSET_KEY}' },
            sabnzbd: { url: 'http://sab:8080', api_key: '${EMPTY_KEY}' },
            prowlarr: { url: 'http://p:9696', api_key_file: '/s/empty' }
        });
        const run = () => resolveSecrets(config, { env: { EMPTY_KEY: '' }, readFile: p => (p === '/s/empty' ? '\n' : readFile(p)) });
        expect(run).toThrow(SecretSourceError);
        try {
            run();
        } catch (err) {
            expect([...(err as SecretSourceError).problems].sort()).toEqual([
                'services.prowlarr.api_key_file: the file is empty',
                'services.radarr/hd.api_key_file: the file could not be read (ENOENT)',
                'services.sabnzbd.api_key: environment variable EMPTY_KEY is empty',
                'services.sonarr.api_key: environment variable UNSET_KEY is not set'
            ]);
        }
    });
});

describe('loading', () => {
    it('starts with a key from a real file and hands the adapter the resolved key', async () => {
        const dir = await freshDir();
        const keyFile = join(dir, 'radarr_key');
        await writeFile(keyFile, 'from-the-file\n');
        await writeFile(
            join(dir, 'config.yaml'),
            `${AUTH_YAML}services:\n  radarr:\n    url: http://radarr:7878\n    api_key_file: ${JSON.stringify(keyFile)}\n`
        );
        const { config } = await loadConfig(dir, { persist: false });
        expect(config.services.radarr).toMatchObject({ api_key_file: keyFile });

        const seen: string[] = [];
        vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
            seen.push(new Headers(init?.headers).get('x-api-key') ?? '');
            return new Response('{}', { status: 401 });
        });
        const [radarr] = buildAdapters(config);
        await radarr?.testConnection();
        expect(seen).toContain('from-the-file');
    });

    it('lands in repair mode, naming the instance and field, when a variable is unset', async () => {
        const dir = await freshDir();
        await writeFile(join(dir, 'config.yaml'), `${AUTH_YAML}services:\n  sabnzbd:\n    url: http://sab:8080\n    api_key: \${ARR_MCP_TEST_UNSET_636}\n`);
        const err = await loadConfig(dir, { persist: false }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConfigInvalidError);
        expect((err as ConfigInvalidError).detail).toBe('services.sabnzbd.api_key: environment variable ARR_MCP_TEST_UNSET_636 is not set');
        // Repair mode can still sign the operator in.
        expect((err as ConfigInvalidError).auth?.password_hash).toBe('scrypt$00$11');
    });

    it('reads the environment at load', () => {
        vi.stubEnv('ARR_MCP_TEST_KEY_636', 'set');
        const verdict = validateConfigText(`${AUTH_YAML}services:\n  sabnzbd:\n    url: http://sab:8080\n    api_key: \${ARR_MCP_TEST_KEY_636}\n`);
        expect(verdict.ok).toBe(true);
    });
});

describe('editing and saving', () => {
    const referenced = () =>
        parse({
            radarr: { url: 'http://radarr:7878', api_key_file: '/run/secrets/radarr' },
            sabnzbd: { url: 'http://sab:8080', api_key: '${SAB_KEY}' },
            nzbget: { url: 'http://nzbget:6789', username: 'nzb', password_file: '/run/secrets/nzbget' }
        });

    it('keeps the reference through an edit with a blank credential', () => {
        const after = updateInstance(referenced(), 'radarr', { url: 'http://radarr:7878', api_key: '', timeout_ms: 5000 });
        expect(after.services.radarr).toMatchObject({ api_key_file: '/run/secrets/radarr', timeout_ms: 5000 });
        expect(after.services.radarr).not.toHaveProperty('api_key');
        const sab = updateInstance(referenced(), 'sabnzbd', { url: '', api_key: '' });
        expect(sab.services.sabnzbd).toMatchObject({ api_key: '${SAB_KEY}' });
    });

    it('refuses a typed credential over a reference, and says where it comes from', () => {
        expect(() => updateInstance(referenced(), 'radarr', { api_key: 'typed' })).toThrow(
            new ConfigEditError('The API key is set from the file named in api_key_file, so change it there rather than here.')
        );
        expect(() => updateInstance(referenced(), 'sabnzbd', { api_key: 'typed' })).toThrow(/environment variable SAB_KEY/);
        expect(() => updateInstance(referenced(), 'nzbget', { password: 'typed' })).toThrow(/The password is set from the file named in password_file/);
    });

    it('refuses a reference typed into the form or sent to the API, so neither can read the environment', () => {
        const inline = parse({ sonarr: { url: 'http://sonarr:8989', api_key: 'inline' } });
        const refused = 'A ${NAME} reference can only be written in config.yaml. Enter the credential itself here.';
        expect(() => updateInstance(inline, 'sonarr', { url: 'http://203.0.113.5:8989', api_key: '${ARR_MCP_TOKEN}' })).toThrow(refused);
        expect(() => addInstance(inline, { type: 'radarr', fields: { url: 'http://203.0.113.5:7878', api_key: '${HOME}' } })).toThrow(refused);
        expect(() => addInstance(inline, { type: 'nzbget', fields: { url: 'http://203.0.113.5:6789', password: '${HOME}' } })).toThrow(refused);
        // Only the whole-value form is a reference, so a key that contains one is still a key.
        expect(updateInstance(inline, 'sonarr', { api_key: 'a${HOME}' }).services.sonarr).toMatchObject({ api_key: 'a${HOME}' });
    });

    it('does not let a referenced credential follow the instance to a new host', () => {
        expect(() => updateInstance(referenced(), 'radarr', { url: 'http://203.0.113.5:7878', api_key: '' })).toThrow(CredentialWouldMoveError);
        expect(() => updateInstance(referenced(), 'sabnzbd', { url: 'http://203.0.113.5:8080' })).toThrow(/points somewhere new/);
    });

    it('writes the reference back to config.yaml, never the resolved secret', async () => {
        const dir = await freshDir();
        const keyFile = join(dir, 'key');
        await writeFile(keyFile, 'the-real-secret\n');
        vi.stubEnv('ARR_MCP_TEST_SAB_636', 'the-env-secret');
        await writeFile(
            join(dir, 'config.yaml'),
            `${AUTH_YAML}services:\n  radarr:\n    url: http://radarr:7878\n    api_key_file: ${JSON.stringify(keyFile)} # mounted secret\n  sabnzbd:\n    url: http://sab:8080\n    api_key: \${ARR_MCP_TEST_SAB_636}\n`
        );
        const { config } = await loadConfig(dir, { persist: false });
        const next = updateInstance(updateInstance(config, 'radarr', { timeout_ms: 2000 }), 'sabnzbd', { timeout_ms: 3000 });
        await saveConfig(dir, next, { expected: config });

        const text = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(text).not.toContain('the-real-secret');
        expect(text).not.toContain('the-env-secret');
        expect(text).toContain(`api_key_file: ${JSON.stringify(keyFile)} # mounted secret`);
        expect(text).toContain('api_key: ${ARR_MCP_TEST_SAB_636}');
        expect(text).toContain('timeout_ms: 2000');
    });
});

describe('saving a reference that does not resolve', () => {
    it('is refused before anything is written, so the file still loads', async () => {
        const dir = await freshDir();
        const original = `${AUTH_YAML}services:\n  sonarr:\n    url: http://sonarr:8989\n    api_key: inline\n`;
        await writeFile(join(dir, 'config.yaml'), original);
        const { config } = await loadConfig(dir, { persist: false });
        // Built by hand: the form and the API refuse a reference outright.
        const next = { ...config, services: { sonarr: { ...config.services.sonarr, api_key: '${ARR_MCP_TEST_UNSET_636}' } } } as Config;
        await expect(saveConfig(dir, next, { expected: config })).rejects.toThrow(
            'services.sonarr.api_key: environment variable ARR_MCP_TEST_UNSET_636 is not set'
        );
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(original);
    });
});

describe('what the UI and the API show', () => {
    const config = parse({
        radarr: { url: 'http://radarr:7878', api_key_file: '/run/secrets/radarr' },
        sonarr: { url: 'http://sonarr:8989', api_key: 'inline' },
        transmission: { url: 'http://tx:9091', username: 'tx', password: '${TX_PASS}' }
    });

    it('marks the source in the management API, and only where there is one', () => {
        const byId = Object.fromEntries(listInstances(config).map(i => [i.id, appResource(i)]));
        expect(byId.radarr).toMatchObject({ apiKeySet: true, apiKeyFrom: 'file' });
        expect(byId.sonarr).toMatchObject({ apiKeySet: true });
        expect(byId.sonarr).not.toHaveProperty('apiKeyFrom');
        expect(byId.transmission).toMatchObject({ passwordSet: true, passwordFrom: 'environment' });
    });

    it('renders a referenced credential read-only, with where it is set', () => {
        const page = String(configPage({ tab: 'services', version: 'test', config, csrf: 'x' }));
        expect(page).toMatch(/id="svc\.radarr\.api_key"[^>]*placeholder="set from file"\s*readonly/);
        expect(page).toContain('set from the file named in api_key_file');
        expect(page).toMatch(/id="svc\.transmission\.password"[^>]*placeholder="set from environment"\s*readonly/);
        expect(page).toContain('set from the environment variable TX_PASS');
        expect(page).not.toMatch(/id="svc\.sonarr\.api_key"[^>]*readonly/);
        expect(page).not.toContain('/run/secrets/radarr');
    });
});
