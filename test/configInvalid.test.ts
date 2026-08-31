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
        if (result.ok) expect(result.config.auth.bearer_token).toBe(BEARER);
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

    // The repair editor must not reject text for the one field the loader
    // repairs itself, or deleting that line would be unfixable in the browser.
    it('backfills a missing bearer token in memory rather than refusing', () => {
        const result = validateConfigText('auth:\n  username: admin\n  allowed_hosts: []\nservices: {}\n');
        expect(result.ok).toBe(true);
        expect(result.generatedBearerToken).toHaveLength(64);
    });

    // The repair server decides whether it can authenticate anyone from this.
    it('reports the auth block when it parses even though the config does not', () => {
        const result = validateConfigText(`${AUTH}services:\n  radarr:\n    url: not-a-url\n    api_key: k\n`);
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

    // The token is persisted before the throw, exactly as before this change,
    // and `raw` carries the persisted text — otherwise saving the page back
    // would delete the token that was just generated and rotate it.
    it('persists a backfilled bearer token even when the config is invalid, and reports the persisted text', async () => {
        const dir = await seed('auth:\n  username: admin\n  allowed_hosts: []\nservices:\n  radarr:\n    url: not-a-url\n    api_key: k\n');
        const err = (await loadConfig(dir).catch((e: unknown) => e)) as ConfigInvalidError;
        expect(err).toBeInstanceOf(ConfigInvalidError);
        expect(err.raw).toContain('bearer_token');
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('bearer_token');
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
