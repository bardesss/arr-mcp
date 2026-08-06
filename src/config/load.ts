import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { generatePassword, hashPassword } from '../core/session.ts';
import { ConfigSchema, type Config } from './schema.ts';

const FILENAME = 'config.yaml';

const generateToken = (): string => randomBytes(32).toString('hex');

/**
 * Credentials created on a run, returned so `index.ts` can print them once.
 *
 * The password is deliberately not stored anywhere — only its hash reaches
 * `config.yaml` — so this is the only moment it exists in a form anyone can
 * read. That is why it travels back out of `loadConfig` rather than being
 * logged from in here: the loader should not decide what gets printed.
 */
export type GeneratedCredentials = { bearerToken?: string; password?: string; username?: string };

/** Written on first run so the knobs are discoverable without reading docs. */
const seedConfig = (password: string) => ({
    auth: {
        bearer_token: generateToken(),
        username: 'admin',
        password_hash: hashPassword(password),
        allowed_hosts: [] as string[]
    },
    services: {}
});

/**
 * Reads <configDir>/config.yaml, creating it with a generated bearer token on
 * first run. The file is the source of truth; environment variables seed
 * first-run defaults only (design spec §13).
 */
/**
 * `persist: false` reads without ever writing.
 *
 * The maintainer scripts load this file only to reach the services it names,
 * and a read must not have side effects on the user's credentials. Before this
 * existed, running `npm run integration` against a config predating the config
 * UI silently backfilled a `password_hash` into it — generating a password
 * that the script never printed, so nobody could ever know it. Missing
 * credentials are still synthesised in memory, because the schema requires
 * them and a script has no business failing over a field it does not use.
 */
export async function loadConfig(
    configDir: string,
    opts: { persist?: boolean } = {}
): Promise<{ config: Config; created: boolean; generated: GeneratedCredentials }> {
    const persist = opts.persist ?? true;
    const path = join(configDir, FILENAME);
    if (persist) await mkdir(configDir, { recursive: true });

    let raw: string | undefined;
    try {
        raw = await readFile(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (raw === undefined) {
        if (!persist) {
            throw new Error(
                `no config.yaml in ${configDir} — start arr-mcp once to create one, or point ARR_MCP_CONFIG_DIR at an existing config directory.`
            );
        }
        const password = generatePassword();
        const seeded = seedConfig(password);
        // 0o600: the file holds the bearer token and every service API key.
        await writeFile(path, stringify(seeded), { mode: 0o600 });
        logger.info({ path }, 'created config.yaml with generated credentials');
        return {
            config: ConfigSchema.parse(seeded),
            created: true,
            generated: { bearerToken: seeded.auth.bearer_token, password, username: 'admin' }
        };
    }

    let parsed: unknown;
    try {
        parsed = parse(raw);
    } catch (err) {
        throw new Error(`config.yaml is not valid YAML: ${(err as Error).message}`, { cause: err });
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('config.yaml must contain a YAML mapping at the top level');
    }

    const obj = parsed as Record<string, unknown>;
    const auth = (obj.auth ?? {}) as { bearer_token?: string; password_hash?: string; username?: string };
    const generated: GeneratedCredentials = {};

    // Backfill rather than refuse to start: someone who deleted a credential,
    // or hand-wrote a config without one, should get a working server and be
    // told where the replacement came from. Deleting `password_hash` is also
    // the documented way to ask for a new password when you have lost it, so
    // this path is a feature, not only a repair.
    if (!auth.bearer_token) {
        auth.bearer_token = generateToken();
        generated.bearerToken = auth.bearer_token;
    }
    if (!auth.password_hash) {
        const password = generatePassword();
        auth.password_hash = hashPassword(password);
        auth.username ??= 'admin';
        generated.password = password;
        generated.username = auth.username;
    }

    if (generated.bearerToken !== undefined || generated.password !== undefined) {
        obj.auth = auth;
        if (persist) {
            await writeFile(path, stringify(obj), { mode: 0o600 });
            logger.warn({ path }, 'config.yaml was missing a credential; generated one');
        }
    }

    const result = ConfigSchema.safeParse(obj);
    if (!result.success) {
        throw new Error(`config.yaml is invalid:\n${z.prettifyError(result.error)}`);
    }
    return { config: result.data, created: false, generated };
}
