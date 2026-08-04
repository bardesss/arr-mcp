import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { ConfigSchema, type Config } from './schema.ts';

const FILENAME = 'config.yaml';

const generateToken = (): string => randomBytes(32).toString('hex');

/** Written on first run so the knobs are discoverable without reading docs. */
const seedConfig = () => ({
    auth: { bearer_token: generateToken(), allowed_hosts: [] as string[] },
    services: {}
});

/**
 * Reads <configDir>/config.yaml, creating it with a generated bearer token on
 * first run. The file is the source of truth; environment variables seed
 * first-run defaults only (design spec §13).
 */
export async function loadConfig(configDir: string): Promise<{ config: Config; created: boolean }> {
    const path = join(configDir, FILENAME);
    await mkdir(configDir, { recursive: true });

    let raw: string | undefined;
    try {
        raw = await readFile(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (raw === undefined) {
        const seeded = seedConfig();
        // 0o600: the file holds the bearer token and every service API key.
        await writeFile(path, stringify(seeded), { mode: 0o600 });
        logger.info({ path }, 'created config.yaml with a generated bearer token');
        return { config: ConfigSchema.parse(seeded), created: true };
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
    const auth = obj.auth as { bearer_token?: string } | undefined;
    if (!auth?.bearer_token) {
        // Backfill rather than refuse to start: a user who deleted the token,
        // or hand-wrote a config without one, should get a working server and
        // a warning telling them where the new token came from.
        obj.auth = { ...(auth ?? {}), bearer_token: generateToken() };
        await writeFile(path, stringify(obj), { mode: 0o600 });
        logger.warn({ path }, 'config.yaml had no bearer token; generated one');
    }

    const result = ConfigSchema.safeParse(obj);
    if (!result.success) {
        throw new Error(`config.yaml is invalid:\n${z.prettifyError(result.error)}`);
    }
    return { config: result.data, created: false };
}
