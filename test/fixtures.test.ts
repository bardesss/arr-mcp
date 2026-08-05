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

/**
 * Repeated separators are the signature of a slug or a delimited list, not a
 * credential. Real captures turned up `titleSlug`
 * ("the-fellowship-of-the-ring-2001") and a subtitle language list
 * ("eng/dut/fre/…"), both long enough to trip the pattern above.
 *
 * A token is a contiguous run: `dGhpcyBpcyBhIHRlc3Q=` has no separator
 * repeated three times, while anything human-readable and delimited does.
 */
const looksDelimited = (value: string): boolean =>
    ['-', '/', '_', '.', ' ', ','].some(sep => value.split(sep).length > 3);

/**
 * Words that legitimately end a key holding a long opaque value: identifiers,
 * content hashes and commit SHAs. Real captures turned up `avatarETag`,
 * `commitTag` and `PrimaryImageTag`, none of which a `(^|_)word$` pattern
 * matched — it could not see a camelCase boundary.
 */
const ID_WORDS = new Set([
    'id',
    'ids',
    'guid',
    'uuid',
    'hash',
    'etag',
    'tag',
    'sha',
    'digest',
    'checksum',
    'fingerprint',
    'imdbid',
    'tvdbid',
    'tmdbid',
    // `cleanTitle` is Radarr's normalised title — punctuation and spaces
    // stripped — which is contiguous and long enough to look exactly like a
    // token. A field named *title or *slug is not a credential.
    'title',
    'slug'
]);

/** Last word of a key, splitting snake_case, kebab-case and camelCase alike. */
const lastWord = (key: string): string =>
    key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+|\s+/)
        .filter(Boolean)
        .pop()
        ?.toLowerCase() ?? '';

const isIdKey = (key: string): boolean => ID_WORDS.has(lastWord(key)) || ID_WORDS.has(key.toLowerCase());

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
            if (
                typeof value === 'string' &&
                !isIdKey(key) &&
                value !== REDACTED &&
                LONG_OPAQUE.test(value) &&
                !looksDelimited(value)
            ) {
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

    it('sees id-ish words across a camelCase boundary, not only after an underscore', () => {
        // All three came out of a real capture and were false positives.
        expect(scan('t', { avatarETag: 'd'.repeat(64) })).toEqual([]);
        expect(scan('t', { commitTag: '6'.repeat(40) })).toEqual([]);
        expect(scan('t', { PrimaryImageTag: 'a'.repeat(48) })).toEqual([]);
    });

    it('still flags a long value under a key with no id-ish word in it', () => {
        expect(scan('t', { avatarThing: 'd'.repeat(64) })).toHaveLength(1);
    });

    it('does not flag a slug or a delimited list, which are long but not opaque', () => {
        // Both came out of a real capture.
        expect(scan('t', { titleSlug: 'the-lord-of-the-rings-the-fellowship-of-the-ring-2001' })).toEqual([]);
        expect(scan('t', { subtitles: 'eng/dut/fre/ger/spa/ita/por/rus/jpn/kor/chi' })).toEqual([]);
    });

    it('still flags a contiguous token of the same length', () => {
        expect(scan('t', { blob: 'dGhpc2lzYXZlcnlsb25nb3BhcXVldG9rZW52YWx1ZQ==' })).toHaveLength(1);
    });

    it('does not let an id-ish suffix excuse a secret-named key', () => {
        // `apiKeyId` ends in a word we allow, but the SECRET_KEY rule is
        // independent and must still catch keys that are named as credentials.
        expect(scan('t', { api_key: 'live-value' })).toHaveLength(1);
    });

    it('finds a secret nested several levels down', () => {
        expect(scan('t', { a: { b: [{ c: { password: 'hunter2' } }] } })).toHaveLength(1);
    });

    it('reports where it found the problem, not just that it did', () => {
        const [finding] = scan('t', { settings: { api_key: 'live-key' } });
        expect(finding?.path).toBe('$.settings.api_key');
    });
});
