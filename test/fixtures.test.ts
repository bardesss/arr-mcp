import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const REDACTED = '__REDACTED__';

/** Key names whose value must always be the placeholder. */
const SECRET_KEY = /^(api_?key|apikey|token|access_?token|auth_?token|password|passwd|secret|nzb_?key)$/i;

/**
 * Values long enough to be a credential rather than an identifier.
 *
 * The threshold is 40, not 32, for a specific reason: *arr API keys are 32
 * lowercase hex characters and so are Jellyfin item and user ids. No value
 * pattern can tell those apart, so this rule deliberately does not try —
 * key-name matching above catches credentials that are correctly named, and
 * the exact-secret scan in scripts/capture-fixtures.ts catches the rest at
 * capture time, where the real secrets are known. This rule is the third net.
 */
const LONG_OPAQUE = /^[A-Za-z0-9+/=_-]{40,}$/;

/** Key names that legitimately carry long opaque values. */
const ID_KEY = /(^|_)(id|guid|hash|etag|imdbid|tvdbid|tmdbid)$/i;

type Finding = { file: string; path: string; reason: string };

export function scan(file: string, node: unknown, path = '$', out: Finding[] = []): Finding[] {
    if (Array.isArray(node)) {
        node.forEach((v, i) => scan(file, v, `${path}[${i}]`, out));
        return out;
    }
    if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            const here = `${path}.${key}`;
            if (SECRET_KEY.test(key) && value !== REDACTED && value !== null && value !== '') {
                out.push({ file, path: here, reason: `secret-named key holds ${JSON.stringify(value)}` });
            }
            if (typeof value === 'string' && !ID_KEY.test(key) && value !== REDACTED && LONG_OPAQUE.test(value)) {
                out.push({ file, path: here, reason: 'long opaque value that is not an id-named field' });
            }
            scan(file, value, here, out);
        }
    }
    return out;
}

async function fixtureFiles(): Promise<string[]> {
    const entries = await readdir(FIXTURES, { recursive: true, withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => join(e.parentPath, e.name));
}

describe('committed fixtures', () => {
    it('contain no secret-shaped content', async () => {
        const findings: Finding[] = [];
        for (const file of await fixtureFiles()) {
            findings.push(...scan(file, JSON.parse(await readFile(file, 'utf8'))));
        }
        expect(findings).toEqual([]);
    });

    it('are valid JSON objects or arrays, not accidental HTML error pages', async () => {
        for (const file of await fixtureFiles()) {
            const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
            expect(typeof parsed).toBe('object');
        }
    });
});

describe('the guard itself', () => {
    it('flags a secret-named key holding a real value', () => {
        expect(scan('t', { indexers: [{ apiKey: 'abc123' }] })).toHaveLength(1);
    });

    it('accepts a secret-named key holding the placeholder', () => {
        expect(scan('t', { indexers: [{ apiKey: REDACTED }] })).toEqual([]);
    });

    it('flags a long opaque value under an innocuous key name', () => {
        expect(scan('t', { AccessTokenValue: 'a'.repeat(48) })).toHaveLength(1);
    });

    it('does not flag a 32-character hex id, which is what Jellyfin item ids look like', () => {
        expect(scan('t', { Id: 'f137a2dd21bbc1b99aa5c0f6bf02a805' })).toEqual([]);
    });

    it('finds a secret nested several levels down', () => {
        expect(scan('t', { a: { b: [{ c: { password: 'hunter2' } }] } })).toHaveLength(1);
    });

    it('reports where it found the problem, not just that it did', () => {
        const [finding] = scan('t', { settings: { api_key: 'live-key' } });
        expect(finding?.path).toBe('$.settings.api_key');
    });
});
