import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LineCounter, parse, parseDocument, stringify } from 'yaml';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { writeConfigAtomic } from './save.ts';
import { ConfigSchema, type Config } from './schema.ts';

export const CONFIG_FILENAME = 'config.yaml';

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
 * A config.yaml that was read but could not be understood — as opposed to one
 * that could not be read at all, which stays a plain Error. Only this one
 * starts the repair server.
 */
export class ConfigInvalidError extends Error {
    // Written out rather than as constructor parameter properties: Node runs
    // this project's TypeScript in strip-only mode, which rejects those.
    readonly detail: string;
    readonly raw: string;
    readonly auth: Config['auth'] | undefined;

    constructor(detail: string, raw: string, auth: Config['auth'] | undefined) {
        super(`config.yaml is invalid:\n${detail}`);
        this.name = 'ConfigInvalidError';
        this.detail = detail;
        this.raw = raw;
        this.auth = auth;
    }
}

export type ConfigTextResult =
    | { ok: true; config: Config; generatedBearerToken: string | undefined }
    | { ok: false; detail: string; auth: Config['auth'] | undefined; generatedBearerToken: string | undefined };

/**
 * Where a YAML syntax error is, without quoting what is there.
 *
 * This detail is served unauthenticated — `/healthz`, `/mcp`, and the
 * read-only page shown when `auth` itself is unparseable — and the line a
 * syntax error lands on is disproportionately often a credential, since the
 * usual cause is an API key holding a `:` or starting with `*`. So:
 * `prettyErrors: false` drops the code frame the parser otherwise prepends,
 * and the cut at the first `: ` drops the handful of messages that append the
 * offending source after one (`Block scalar header includes extra characters:
 * …`, and the alias `ReferenceError`, which is not even a parse error). The
 * line and column are the actionable part and carry no content.
 *
 * What survives is at most a structural indicator character — `Plain value
 * cannot start with reserved character @` — which the operator needs to read
 * the message at all.
 */
function yamlErrorDetail(err: unknown, lines: LineCounter): string {
    const e = err as { message?: unknown; pos?: [number, number] };
    const message = typeof e.message === 'string' ? e.message : 'the file could not be parsed';
    const said = message.split(': ')[0] ?? message;
    const offset = e.pos?.[0];
    if (offset === undefined) return said;
    const { line, col } = lines.linePos(offset);
    return `${said} at line ${line}, column ${col}`;
}

/**
 * The whole content pipeline — YAML, shape, bearer-token backfill, schema — in
 * one place, so the repair editor cannot accept text that startup then
 * rejects. It generates a bearer token when the text lacks one, and reports it
 * rather than writing anything.
 */
export function validateConfigText(raw: string): ConfigTextResult {
    let parsed: unknown;
    const lines = new LineCounter();
    try {
        parsed = parse(raw, { prettyErrors: false, lineCounter: lines });
    } catch (err) {
        return {
            ok: false,
            detail: `config.yaml is not valid YAML: ${yamlErrorDetail(err, lines)}`,
            auth: undefined,
            generatedBearerToken: undefined
        };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            detail: 'config.yaml must contain a YAML mapping at the top level',
            auth: undefined,
            generatedBearerToken: undefined
        };
    }

    const obj = parsed as Record<string, unknown>;

    // A non-object `auth:` has to reach safeParse to be reported properly.
    const rawAuth = obj.auth;
    const authIsMapping =
        rawAuth === undefined || (rawAuth !== null && typeof rawAuth === 'object' && !Array.isArray(rawAuth));
    const auth = (authIsMapping ? (rawAuth ?? {}) : {}) as { bearer_token?: string };

    let generatedBearerToken: string | undefined;
    if (authIsMapping && !auth.bearer_token) {
        auth.bearer_token = generateToken();
        generatedBearerToken = auth.bearer_token;
        obj.auth = auth;
    }

    const result = ConfigSchema.safeParse(obj);
    if (result.success) return { ok: true, config: result.data, generatedBearerToken };

    const authOnly = ConfigSchema.shape.auth.safeParse(obj.auth);
    return {
        ok: false,
        detail: z.prettifyError(result.error),
        auth: authOnly.success ? authOnly.data : undefined,
        generatedBearerToken
    };
}

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
    const path = join(configDir, CONFIG_FILENAME);
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

    const generated: GeneratedCredentials = {};

    const result = validateConfigText(raw);

    let text = raw;
    if (result.generatedBearerToken !== undefined) {
        generated.bearerToken = result.generatedBearerToken;
        // Through the document and the same atomic write saveConfig uses:
        // `stringify` drops every comment, and a partial write could leave a
        // truncated config holding every API key.
        const doc = parseDocument(raw);
        doc.setIn(['auth', 'bearer_token'], result.generatedBearerToken);
        text = doc.toString();
        if (persist) {
            await writeConfigAtomic(path, text);
            logger.warn({ path }, 'config.yaml was missing its bearer token; generated one');
        }
    }

    if (!result.ok) throw new ConfigInvalidError(result.detail, text, result.auth);
    return { config: result.config, created: false, generated };
}
