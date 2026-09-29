import { describe, expect, it } from 'vitest';
import {
    bearerCaller,
    expiresIn,
    expiringSoon,
    fingerprint,
    generateMcpToken,
    hashToken,
    isExpired,
    matchToken,
    tiersOf,
    type StoredToken
} from '../src/core/mcpTokens.ts';

const NOW = new Date('2026-09-29T12:00:00Z');
const PLAIN = 'amcp_' + 'c'.repeat(64);
const stored = (over: Partial<StoredToken> = {}): StoredToken => ({ name: 'phone', tier: 'read', hash: hashToken(PLAIN), ...over });

describe('mcp tokens', () => {
    it('generates amcp_ tokens of 32 random bytes', () => {
        const a = generateMcpToken();
        expect(a).toMatch(/^amcp_[0-9a-f]{64}$/);
        expect(generateMcpToken()).not.toBe(a);
    });

    it('hashes deterministically as sha256:<hex>', () => {
        expect(hashToken('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(fingerprint(hashToken('abc'))).toBe('ba7816bf');
    });

    it('maps tiers onto write tiers', () => {
        expect([...tiersOf('read')]).toEqual([]);
        expect([...tiersOf('write')]).toEqual(['safe']);
        expect([...tiersOf('destructive')].sort()).toEqual(['destructive', 'safe']);
    });

    it('expires at the start of the day, UTC', () => {
        expect(isExpired(undefined, NOW)).toBe(false);
        expect(isExpired('2026-09-30', NOW)).toBe(false);
        expect(isExpired('2026-09-29', NOW)).toBe(true);
        expect(isExpired('2026-09-29', new Date('2026-09-28T23:59:59Z'))).toBe(false);
    });

    it('computes expiry dates from the form choice', () => {
        expect(expiresIn('30', NOW)).toBe('2026-10-29');
        expect(expiresIn('90', NOW)).toBe('2026-12-28');
        expect(expiresIn('never', NOW)).toBeUndefined();
    });

    it('flags tokens that expire within 7 days', () => {
        expect(expiringSoon('2026-10-06', NOW)).toBe(true);
        expect(expiringSoon('2026-10-07', NOW)).toBe(false);
        expect(expiringSoon('2026-09-29', NOW)).toBe(false);
        expect(expiringSoon(undefined, NOW)).toBe(false);
    });

    it('matches a presented token against the stored hashes', () => {
        const other = stored({ name: 'other', hash: hashToken('x'.repeat(40)) });
        expect(matchToken(PLAIN, [other, stored()], NOW)).toEqual({ kind: 'match', token: stored() });
        expect(matchToken('nope', [other, stored()], NOW)).toEqual({ kind: 'none' });
        expect(matchToken('', [stored()], NOW)).toEqual({ kind: 'none' });
    });

    it('reports an expired match rather than no match', () => {
        const old = stored({ expires: '2026-09-01' });
        expect(matchToken(PLAIN, [old], NOW)).toEqual({ kind: 'expired', token: old });
    });

    it('names the caller with a fingerprint', () => {
        expect(bearerCaller(stored())).toBe(`bearer:phone#${fingerprint(hashToken(PLAIN))}`);
    });
});
