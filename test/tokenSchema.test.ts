import { describe, expect, it } from 'vitest';
import { ConfigSchema, tokensNeedingRewrite } from '../src/config/schema.ts';
import { hashToken } from '../src/core/mcpTokens.ts';

const LEGACY = 'a'.repeat(64);
const HAND = 'h'.repeat(40);
const parse = (auth: Record<string, unknown>) => ConfigSchema.safeParse({ auth, services: {} });

describe('auth.tokens', () => {
    it('turns a legacy bearer_token into a destructive default token', () => {
        const r = parse({ bearer_token: LEGACY });
        expect(r.success).toBe(true);
        if (!r.success) return;
        expect(r.data.auth.tokens).toEqual([{ name: 'default', tier: 'destructive', hash: hashToken(LEGACY) }]);
        expect('bearer_token' in r.data.auth).toBe(false);
    });

    it('hashes a hand-written plaintext token', () => {
        const r = parse({ tokens: [{ name: 'ci', tier: 'read', token: HAND }] });
        expect(r.success && r.data.auth.tokens).toEqual([{ name: 'ci', tier: 'read', hash: hashToken(HAND) }]);
    });

    it('keeps expires and parses to the same value twice', () => {
        const once = parse({ tokens: [{ name: 'p', tier: 'write', hash: hashToken(HAND), expires: '2026-12-28' }] });
        expect(once.success).toBe(true);
        if (!once.success) return;
        const twice = ConfigSchema.parse(once.data);
        expect(twice.auth.tokens).toEqual(once.data.auth.tokens);
    });

    it('defaults to no tokens', () => {
        const r = parse({});
        expect(r.success && r.data.auth.tokens).toEqual([]);
    });

    it.each([
        [{ tokens: [{ name: 'ci', tier: 'read', token: 'short' }] }, "token 'ci' must be at least 32 characters"],
        [{ bearer_token: LEGACY, tokens: [] }, 'cannot be set together with tokens'],
        [{ tokens: [{ name: 'a', tier: 'read', token: HAND }, { name: 'a', tier: 'read', token: HAND }] }, 'duplicate token name "a"'],
        [{ tokens: [{ name: 'ci', tier: 'read', token: HAND }, { name: 'CI', tier: 'read', token: HAND }] }, 'duplicate token name "CI"'],
        [{ tokens: [{ name: 'a', tier: 'read', token: HAND, hash: hashToken(HAND) }] }, "token 'a' needs exactly one of hash or token"],
        [{ tokens: [{ name: 'a', tier: 'read' }] }, "token 'a' needs exactly one of hash or token"],
        [{ tokens: [{ name: 'a', tier: 'admin', token: HAND }] }, 'tier'],
        [{ tokens: [{ name: 'a', tier: 'read', hash: 'md5:abc' }] }, 'hash'],
        [{ tokens: [{ name: 'a', tier: 'read', token: HAND, expires: '28-12-2026' }] }, 'expires']
    ])('refuses %j', (auth, message) => {
        const r = parse(auth);
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n')).toContain(message);
    });

    it('names the entries a load has to rewrite', () => {
        expect(tokensNeedingRewrite({ bearer_token: LEGACY })).toEqual(['default']);
        expect(tokensNeedingRewrite({ tokens: [{ name: 'ci', token: HAND }, { name: 'p', hash: 'sha256:x' }] })).toEqual(['ci']);
        expect(tokensNeedingRewrite(undefined)).toEqual([]);
    });
});
