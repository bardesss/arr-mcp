import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigInvalidError, loadConfig, validateConfigText } from '../src/config/load.ts';

const BEARER = 'a'.repeat(64);
const AUTH = `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\n`;

const seed = async (text: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-invalid-'));
    await writeFile(join(dir, 'config.yaml'), text, 'utf8');
    return dir;
};

describe('validateConfigText', () => {
    it('accepts a valid config', () => {
        const result = validateConfigText(`${AUTH}services: {}\n`);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.auth.tokens[0]?.name).toBe('default');
    });

    it('reports unparseable YAML without throwing', () => {
        const result = validateConfigText('auth: [unclosed\n');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.detail).toContain('not valid YAML');
    });

    // The detail reaches three unauthenticated surfaces (see repair.test.ts),
    // and the line a syntax error lands on is most often a credential — a
    // value holding a `:` is the usual cause. Position, never content.
    it('locates a syntax error without quoting the line it is on', () => {
        const result = validateConfigText(`auth:\n  bearer_token: ${BEARER}\n  api_key: MY-SUPER-SECRET: oops\n`);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.detail).toContain('line 3');
        expect(result.detail).toContain('column 12');
        expect(result.detail).not.toContain('MY-SUPER-SECRET');
        expect(result.detail).not.toContain('api_key');
    });

    // The parser appends the offending source after a colon in a handful of
    // its own messages, and an unresolved alias is a ReferenceError naming the
    // anchor — neither of which `prettyErrors: false` alone takes out.
    it.each([
        ['a block scalar header', 'auth:\n  api_key: |MY-SUPER-SECRET\n    x\n'],
        ['an alias', 'auth:\n  api_key: *MY-SUPER-SECRET\n']
    ])('keeps %s error free of the file text', (_name, text) => {
        const result = validateConfigText(text);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.detail).toContain('not valid YAML');
        expect(result.detail).not.toContain('MY-SUPER-SECRET');
    });

    it('reports a top-level scalar', () => {
        const result = validateConfigText('just a string\n');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.detail).toContain('mapping at the top level');
    });

    it('reports a schema failure with the offending path', () => {
        const result = validateConfigText(`${AUTH}services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.detail).toContain('url');
    });

    it('accepts a config with no tokens', () => {
        const result = validateConfigText('auth:\n  username: admin\n  allowed_hosts: []\nservices: {}\n');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.auth.tokens).toEqual([]);
    });

    // The repair server decides whether it can authenticate anyone from this.
    it('reports the auth block when it parses even though the config does not', () => {
        const result = validateConfigText(`${AUTH}services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.auth?.username).toBe('admin');
    });

    // The oauth/allow_token_in_url refinement runs on the full config, but the
    // salvage parse must not inherit it: it runs precisely when the rest of
    // the file is already broken, and a config with both should still let the
    // operator log in and fix the YAML from the repair page rather than being
    // locked out of the whole app by unreadableAuthPage.
    it('salvages the auth block even when oauth and allow_token_in_url conflict', () => {
        const text =
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\n` +
            `  allow_token_in_url: true\n  oauth:\n    issuer: https://auth.example.com\n` +
            `    audience: arr-mcp\n    jwks_uri: https://auth.example.com/.well-known/jwks.json\n` +
            `services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`;
        const result = validateConfigText(text);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.auth?.username).toBe('admin');
    });

    // 099031e kept the oauth/allow_token_in_url refine off the salvage parse
    // so a conflicting-but-otherwise-valid auth block still logs the operator
    // in. A stray key under auth is the same situation one layer down: the
    // full ConfigSchema must still refuse it (strict, loud, at startup), but
    // the salvage parse runs precisely when the file is already broken and
    // must not let that same key turn into unreadableAuthPage.
    it('salvages the auth block even when it carries an unrecognised key', () => {
        const text =
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\n` +
            `  legacy_knob: true\n` +
            `services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`;
        const result = validateConfigText(text);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.detail).toContain('Unrecognized key');
            expect(result.auth?.username).toBe('admin');
        }
    });

    // A mistake inside auth.oauth (as opposed to beside it) is the same
    // situation one layer deeper still: the operator hand-writing this block
    // for the first time is exactly who a strict, refined OAuthSchema most
    // often catches, and that must not cost them the sign-in page too. Three
    // shapes of mistake, because each fails through a different path in
    // OAuthSchema — an unrecognised key, a missing required field, and a
    // custom refine — and widening `oauth` to `unknown` must swallow all
    // three, not just whichever one happens to be tested.
    it.each([
        ['a misspelled key', '  oauth:\n    issuer: https://auth.example.com\n    jwks_url: https://auth.example.com/jwks.json\n'],
        ['a missing required field', '  oauth:\n    issuer: https://auth.example.com\n    jwks_uri: https://auth.example.com/jwks.json\n'],
        ['a refine failure', '  oauth:\n    issuer: http://auth.example.com\n    audience: arr-mcp\n    jwks_uri: https://auth.example.com/jwks.json\n']
    ])('salvages the auth block even when auth.oauth has %s', (_name, oauthBlock) => {
        const text =
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\n${oauthBlock}` +
            `services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`;
        const result = validateConfigText(text);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.auth?.username).toBe('admin');
    });

    // A typo in one token entry, or a short bearer_token, must still reach
    // the repair editor rather than the unreadable-auth page.
    it.each([
        ['an unknown tier', `  tokens:\n    - name: phone\n      tier: reed\n      hash: sha256:${'a'.repeat(64)}\n`],
        ['an unknown key', `  tokens:\n    - name: phone\n      tier: read\n      hash: sha256:${'a'.repeat(64)}\n      expiry: 2027-01-01\n`],
        ['a numeric token', '  tokens:\n    - name: phone\n      tier: read\n      token: 12345\n'],
        ['a short bearer_token', '  bearer_token: short\n']
    ])('salvages the auth block even when it has %s', (_name, tokenBlock) => {
        const result = validateConfigText(`auth:\n  username: admin\n  allowed_hosts: []\n${tokenBlock}services: {}\n`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.auth?.username).toBe('admin');
    });

    it('reports no auth block when auth itself is unreadable', () => {
        const result = validateConfigText('auth: 12\nservices: {}\n');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.auth).toBeUndefined();
    });
});

describe('loadConfig', () => {
    it('throws ConfigInvalidError carrying the file text for a schema failure', async () => {
        const text = `${AUTH}services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`;
        const dir = await seed(text);
        await expect(loadConfig(dir)).rejects.toThrow(ConfigInvalidError);
        await loadConfig(dir).catch((err: unknown) => {
            expect(err).toBeInstanceOf(ConfigInvalidError);
            const invalid = err as ConfigInvalidError;
            expect(invalid.raw).toContain('not-a-url');
            expect(invalid.auth?.username).toBe('admin');
        });
    });

    // An invalid config is never rewritten, so `raw` is the file as it stands.
    it('leaves an invalid config untouched, and reports its text', async () => {
        const text = `${AUTH}services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`;
        const dir = await seed(text);
        const err = (await loadConfig(dir).catch((e: unknown) => e)) as ConfigInvalidError;
        expect(err).toBeInstanceOf(ConfigInvalidError);
        expect(err.raw).toBe(text);
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(text);
    });

    // Storage failures must stay fatal and untyped, so index.ts does not
    // degrade into a page whose Save can never succeed.
    it('does not use ConfigInvalidError for an unreadable directory', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-invalid-'));
        await writeFile(join(dir, 'config.yaml'), `${AUTH}services: {}\n`, 'utf8');
        const err = await loadConfig(join(dir, 'config.yaml'), { persist: false }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(ConfigInvalidError);
    });
});

describe('yaml error detail', () => {
    // The detail is cut where the parser quotes the file, but many of its
    // messages simply contain a colon-space of their own. Cutting at every one
    // turned this message into the bare word "The".
    it('keeps a message whose own text contains a colon-space', () => {
        const result = validateConfigText(`${AUTH}services:\n  ${'x'.repeat(1100)}: 1\n`);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.detail).toContain('must be at most 1024 chars');
            expect(result.detail).toMatch(/at line \d+, column \d+$/);
        }
    });

    // The other half of the same rule: where the tail really is the file, it
    // goes. A block scalar header is the case that survives `prettyErrors`.
    it('still drops the source a block scalar header quotes', () => {
        const result = validateConfigText(`${AUTH}services: |MY-SUPER-SECRET\n  x\n`);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.detail).toContain('Block scalar header');
            expect(result.detail).not.toContain('MY-SUPER-SECRET');
        }
    });
});

describe('ConfigInvalidError', () => {
    it('keeps the file text and the salvaged auth out of JSON', () => {
        const err = new ConfigInvalidError('bad', 'api_key: secret-raw', { username: 'admin', password_hash: 'secret-hash', allowed_hosts: [] });
        const text = JSON.stringify(err);
        expect(text).not.toContain('secret-raw');
        expect(text).not.toContain('secret-hash');
        expect(Object.keys(err)).not.toContain('raw');
        expect(err.raw).toBe('api_key: secret-raw');
        expect(err.auth?.password_hash).toBe('secret-hash');
    });
});
