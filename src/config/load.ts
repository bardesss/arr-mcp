import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, parseDocument, stringify } from 'yaml';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { writeConfigAtomic } from './save.ts';
import { ConfigSchema, type Config } from './schema.ts';

const FILENAME = 'config.yaml';

const generateToken = (): string => randomBytes(32).toString('hex');

/**
 * Credentials created on a run.
 *
 * Only the bearer token, which has no interactive path: a config without one
 * has no working `/mcp` and no way to obtain one, so it must be generated. A
 * password does have an interactive path — the setup page — so the loader
 * never invents one, and no secret here is ever passed to the logger.
 */
export type GeneratedCredentials = { bearerToken?: string };

/**
 * Written on first run so the knobs are discoverable without reading docs.
 *
 * No `password_hash`: a fresh install is *unclaimed*, and the config UI serves
 * its setup page until someone chooses a password in the browser.
 */
const seedConfig = () => ({
    auth: {
        bearer_token: generateToken(),
        username: 'admin',
        allowed_hosts: [] as string[]
    },
    services: {}
});

/**
 * Reads <configDir>/config.yaml, creating it with a generated bearer token on
 * first run. The file is the source of truth; environment variables seed
 * first-run defaults only.
 */
/**
 * `persist: false` reads without ever writing.
 *
 * The maintainer scripts load this file only to reach the services it names,
 * and a read must not have side effects on the user's credentials. Before this
 * existed, running `npm run integration` against a config predating the config
 * UI silently backfilled credentials into it. A missing bearer token is still
 * synthesised in memory, because the schema requires it and a script has no
 * business failing over a field it does not use.
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
        const seeded = seedConfig();
        // 0o600: the file holds the bearer token and every service API key.
        await writeFile(path, stringify(seeded), { mode: 0o600 });
        logger.info({ path }, 'created config.yaml — no password set yet');
        return {
            config: ConfigSchema.parse(seeded),
            created: true,
            generated: { bearerToken: seeded.auth.bearer_token }
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

    // A non-object `auth:` has to reach safeParse to be reported properly.
    // Backfilling into it first threw from assigning a property to a primitive,
    // pre-empting the schema message with a raw TypeError.
    const rawAuth = obj.auth;
    const authIsMapping =
        rawAuth === undefined || (rawAuth !== null && typeof rawAuth === 'object' && !Array.isArray(rawAuth));
    const auth = (authIsMapping ? (rawAuth ?? {}) : {}) as {
        bearer_token?: string;
        password_hash?: string;
        username?: string;
    };
    const generated: GeneratedCredentials = {};

    // The bearer token is backfilled rather than refused because it has no
    // interactive path: a config missing one has no working /mcp, and no way
    // to get a working one.
    //
    // `password_hash` is deliberately *not* backfilled. Its absence means
    // unclaimed, which the config UI resolves in the browser — repairing it
    // here would claim the instance on the user's behalf with a password
    // nobody would ever see. Deleting the line is the documented way to ask
    // for a new password, and this is what makes that work.
    if (authIsMapping && !auth.bearer_token) {
        auth.bearer_token = generateToken();
        generated.bearerToken = auth.bearer_token;
        obj.auth = auth;
        if (persist) {
            // Through the document and the same atomic write saveConfig uses:
            // `stringify(obj)` dropped every comment in the file, and writing
            // straight over it could leave a truncated config holding every
            // API key — the two things save.ts exists to prevent.
            const doc = parseDocument(raw);
            doc.setIn(['auth', 'bearer_token'], auth.bearer_token);
            await writeConfigAtomic(path, doc.toString());
            logger.warn({ path }, 'config.yaml was missing its bearer token; generated one');
        }
    }

    const result = ConfigSchema.safeParse(obj);
    if (!result.success) {
        throw new Error(`config.yaml is invalid:\n${z.prettifyError(result.error)}`);
    }
    return { config: result.data, created: false, generated };
}
