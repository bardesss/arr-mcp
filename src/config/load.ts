import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LineCounter, parse, parseDocument, stringify } from 'yaml';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { writeConfigAtomic } from './save.ts';
import { AuthSchema, ConfigSchema, tokensNeedingRewrite, type Config } from './schema.ts';

export const CONFIG_FILENAME = 'config.yaml';

/** What repair mode reads of an `auth` block that did not fully validate. */
export type SalvagedAuth = Omit<z.infer<typeof AuthSchema>, 'oauth' | 'tokens' | 'bearer_token'>;

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
    readonly auth: SalvagedAuth | undefined;

    constructor(detail: string, raw: string, auth: SalvagedAuth | undefined) {
        super(`config.yaml is invalid:\n${detail}`);
        this.name = 'ConfigInvalidError';
        this.detail = detail;
        this.raw = raw;
        this.auth = auth;
    }
}

export type ConfigTextResult = { ok: true; config: Config } | { ok: false; detail: string; auth: SalvagedAuth | undefined };

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
function yamlErrorDetail(err: unknown, lines: LineCounter, raw: string): string {
    const e = err as { message?: unknown; pos?: [number, number] };
    const message = typeof e.message === 'string' ? e.message : 'the file could not be parsed';
    // Cut only where the tail is actually quoting the file. Cutting at every
    // `: ` also truncated messages that merely contain one — "The : indicator
    // must be at most 1024 chars…" became the bare word "The", which reads as
    // a rendering bug rather than an error.
    const cut = message.indexOf(': ');
    const said = cut === -1 || !raw.includes(message.slice(cut + 2)) ? message : message.slice(0, cut);
    const offset = e.pos?.[0];
    if (offset === undefined) return said;
    const { line, col } = lines.linePos(offset);
    return `${said} at line ${line}, column ${col}`;
}

/**
 * The whole content pipeline — YAML, shape, schema — in one place, so the
 * repair editor cannot accept text that startup then rejects. It writes
 * nothing; the schema normalises tokens in memory.
 */
export function validateConfigText(raw: string): ConfigTextResult {
    let parsed: unknown;
    const lines = new LineCounter();
    try {
        // `logLevel: 'error'` because the parser's warnings go to stderr through
        // `process.emitWarning`, which bypasses pino and the ring buffer — and
        // two of them quote the file (`Unresolved tag: !…`, `Unknown directive
        // %…`), so a file that parses fine could still put its own content into
        // `docker logs`.
        parsed = parse(raw, { prettyErrors: false, lineCounter: lines, logLevel: 'error' });
    } catch (err) {
        return {
            ok: false,
            detail: `config.yaml is not valid YAML: ${yamlErrorDetail(err, lines, raw)}`,
            auth: undefined
        };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            detail: 'config.yaml must contain a YAML mapping at the top level',
            auth: undefined
        };
    }

    const obj = parsed as Record<string, unknown>;
    // A file with no `auth` block is an unclaimed install with no tokens.
    if (obj.auth === undefined) obj.auth = {};

    const result = ConfigSchema.safeParse(obj);
    if (result.success) return { ok: true, config: result.data };

    // Unrefined *and* unstrict on purpose: this runs precisely when the rest
    // of the file is already broken, and neither the auth refinements nor an
    // unrecognised key under auth has anything to do with whether we can
    // authenticate whoever came to fix it. `oauth`, `tokens` and
    // `bearer_token` are dropped from the shape, because a plain `z.object`
    // ignores keys it has no field for: a mistake inside those blocks (a
    // typo in one token entry, say) no longer fails the salvage whole and
    // costs the operator the repair editor. Repair mode reads only
    // `allowed_hosts`, `password_hash` and `username`, and writes credentials
    // back through a re-read YAML document rather than through this object.
    // ConfigSchema's own `auth` field stays strict, so a typo anywhere in it
    // is still a startup failure.
    const authOnly = z.object(AuthSchema.shape).omit({ oauth: true, tokens: true, bearer_token: true }).safeParse(obj.auth);
    return {
        ok: false,
        detail: z.prettifyError(result.error),
        auth: authOnly.success ? authOnly.data : undefined
    };
}

/**
 * Written on first run so the knobs are discoverable without reading docs.
 *
 * No `password_hash`: a fresh install is *unclaimed*, and the config UI serves
 * its setup page until someone chooses a password in the browser. No tokens
 * either: the operator mints the first one there.
 */
const seedConfig = () => ({
    auth: { username: 'admin', allowed_hosts: [] as string[], tokens: [] as unknown[] },
    services: {}
});

/**
 * Reads <configDir>/config.yaml, creating it on first run. The file is the
 * source of truth; environment variables seed first-run defaults only.
 *
 * Plaintext MCP tokens (a legacy `bearer_token`, or a hand-written `token`)
 * are hashed in place and the file rewritten. If it cannot be rewritten the
 * tokens still work, and their names come back in `plaintextOnDisk`.
 *
 * `persist: false` reads without ever writing.
 *
 * The maintainer scripts load this file only to reach the services it names,
 * and a read must not have side effects on the user's credentials. Before this
 * existed, running `npm run integration` against a config predating the config
 * UI silently backfilled credentials into it. Tokens are normalised in memory
 * and nothing is written. `write` is the seam a test uses to fail the rewrite.
 */
export async function loadConfig(
    configDir: string,
    opts: { persist?: boolean; write?: (path: string, text: string) => Promise<void> } = {}
): Promise<{ config: Config; created: boolean; plaintextOnDisk: string[] }> {
    const persist = opts.persist ?? true;
    const write = opts.write ?? writeConfigAtomic;
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
        // 0o600: the file holds every service API key.
        await writeFile(path, stringify(seeded), { mode: 0o600 });
        logger.info({ path }, 'created config.yaml — no password set yet');
        return { config: ConfigSchema.parse(seeded), created: true, plaintextOnDisk: [] };
    }

    const result = validateConfigText(raw);
    if (!result.ok) throw new ConfigInvalidError(result.detail, raw, result.auth);

    const pending = tokensNeedingRewrite((parse(raw, { logLevel: 'error' }) as { auth?: unknown } | null)?.auth);
    if (pending.length === 0 || !persist) return { config: result.config, created: false, plaintextOnDisk: pending };

    // Through the document and the same atomic write saveConfig uses:
    // `stringify` drops every comment, and a partial write could leave a
    // truncated config holding every API key.
    const doc = parseDocument(raw);
    doc.deleteIn(['auth', 'bearer_token']);
    doc.setIn(['auth', 'tokens'], result.config.auth.tokens);
    try {
        await write(path, doc.toString());
        logger.warn({ path, tokens: pending }, 'hashed MCP tokens in config.yaml');
        return { config: result.config, created: false, plaintextOnDisk: [] };
    } catch (err) {
        logger.warn(
            { path, tokens: pending, err },
            'config.yaml could not be rewritten, so these MCP tokens are still plaintext on disk; they work, but remove the plaintext'
        );
        return { config: result.config, created: false, plaintextOnDisk: pending };
    }
}
