import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The same pattern the capture script redacts with, not a second copy: the two
// had already drifted, and the guard silently stopped covering session ids.
import { SECRET_KEY } from '../scripts/lib/redact.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const REDACTED = '__REDACTED__';

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

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
// Only the compressed form (`::`) or a full eight groups: a bare `12:34:56`
// timestamp has neither.
const IPV6 = /(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){1,7}:[0-9a-f:]*|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4})(?![0-9a-f:])/gi;

/** Private, loopback, link-local and the RFC 5737 / 3849 documentation ranges
 *  the capture script rewrites addresses to. Anything else is a real host. */
const ALLOWED_ADDRESS =
    /^(?:0\.0\.0\.0|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|::1?$|f[cd]|fe[89ab]|2001:db8:)/i;

/** Every IP-shaped token in raw text that is not an allowed address. Scans the
 *  whole file, not named fields: the next endpoint captured will carry its own. */
export const publicAddresses = (text: string): string[] => {
    // A four-part version ("2.2.0.108") is shaped like an address, and a
    // version-named key never holds one.
    const unversioned = text.replace(/"[^"]*version[^"]*"\s*:\s*"[^"]*"/gi, '');
    return [...unversioned.matchAll(IPV4), ...unversioned.matchAll(IPV6)]
        .map(m => m[0])
        .filter(a => a.includes(':') || a.split('.').every(o => Number(o) <= 255))
        .filter(a => !ALLOWED_ADDRESS.test(a));
};

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

/**
 * One pass, not one awaited read per file: serialised, these took over 3s of
 * the 5s default timeout inside a full `vitest run` and flaked.
 */
async function fixtureContents(): Promise<{ file: string; text: string }[]> {
    const files = await fixtureFiles();
    return Promise.all(files.map(async file => ({ file, text: await readFile(file, 'utf8') })));
}

describe('committed fixtures', () => {
    it('contain no secret-shaped content', async () => {
        const findings: Finding[] = [];
        for (const { file, text } of await fixtureContents()) {
            findings.push(...scan(file, JSON.parse(text)));
        }
        expect(findings).toEqual([]);
    });

    it('contain no public IP address anywhere in the file', async () => {
        const findings = (await fixtureContents()).flatMap(({ file, text }) =>
            publicAddresses(text).map(address => `${file}: ${address}`)
        );
        expect(findings).toEqual([]);
    });

    it('are valid JSON objects or arrays, not accidental HTML error pages', async () => {
        for (const { text } of await fixtureContents()) {
            const parsed: unknown = JSON.parse(text);
            expect(typeof parsed).toBe('object');
        }
    });
});

describe('the guard itself', () => {
    it('flags a public address in any field, and passes private, documentation and version-shaped ones', () => {
        expect(publicAddresses('{"anything":"8.8.8.8","v6":"2606:4700::1111"}')).toEqual(['8.8.8.8', '2606:4700::1111']);
        expect(publicAddresses('{"version":"2.2.0.108"}')).toEqual([]);
        expect(publicAddresses('"192.168.1.5 10.0.0.1 192.0.2.10 2001:db8::a fe80::1 ::1 4.0.5.1234 09:22:10"')).toEqual([]);
    });

    it('flags a session id, which the capture script also redacts', () => {
        expect(scan('t', { 'session-id': 'abc123' })).toHaveLength(1);
        expect(scan('t', { session_id: 'abc123' })).toHaveLength(1);
    });

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
