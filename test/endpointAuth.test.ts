import { describe, expect, it } from 'vitest';
import { presentedToken, tokenMatches } from '../src/mcp/endpointAuth.ts';

const URL_BASE = 'http://localhost:6060/mcp';

describe('tokenMatches', () => {
    it('accepts an exact match and rejects anything else', () => {
        expect(tokenMatches('a'.repeat(64), 'a'.repeat(64))).toBe(true);
        expect(tokenMatches('b'.repeat(64), 'a'.repeat(64))).toBe(false);
    });

    it('rejects a token of the wrong length without throwing', () => {
        expect(tokenMatches('short', 'a'.repeat(64))).toBe(false);
    });

    it('refuses an empty presented token, even against an empty expected one', () => {
        expect(tokenMatches('', '')).toBe(false);
    });
});

describe('presentedToken', () => {
    it('reads a bearer header', () => {
        expect(presentedToken(URL_BASE, 'Bearer abc', false)).toEqual({ via: 'header', token: 'abc' });
    });

    it('lets a header win over a query parameter, even a wrong one', () => {
        expect(presentedToken(`${URL_BASE}?token=right`, 'Bearer wrong', true)).toEqual({
            via: 'header',
            token: 'wrong'
        });
    });

    it('reads the query parameter when the flag is on and no header was sent', () => {
        expect(presentedToken(`${URL_BASE}?token=abc`, undefined, true)).toEqual({ via: 'query', token: 'abc' });
    });

    it('ignores the query parameter when the flag is off, but records that one was offered', () => {
        expect(presentedToken(`${URL_BASE}?token=abc`, undefined, false)).toEqual({
            via: 'none',
            queryOffered: true
        });
    });

    it('treats an empty token parameter as absent', () => {
        expect(presentedToken(`${URL_BASE}?token=`, undefined, true)).toEqual({ via: 'none', queryOffered: false });
    });

    it('reports nothing offered when there is neither header nor parameter', () => {
        expect(presentedToken(URL_BASE, undefined, true)).toEqual({ via: 'none', queryOffered: false });
    });

    it('ignores a non-bearer authorization scheme', () => {
        expect(presentedToken(URL_BASE, 'Basic abc', true)).toEqual({ via: 'none', queryOffered: false });
    });

    it('treats a valueless Bearer header as decisive, not as no header at all', () => {
        const url = `${URL_BASE}?token=right`;
        expect(presentedToken(url, 'Bearer', true)).toEqual({ via: 'header', token: '' });
        expect(presentedToken(url, 'Bearer ', true)).toEqual({ via: 'header', token: '' });
    });

    it('recognizes a lowercase scheme as decisive too, per RFC 7235', () => {
        expect(presentedToken(`${URL_BASE}?token=right`, 'bearer wrong', true)).toEqual({
            via: 'header',
            token: 'wrong'
        });
    });
});
