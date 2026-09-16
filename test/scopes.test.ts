import { describe, expect, it } from 'vitest';
import type { OAuthConfig } from '../src/config/schema.ts';
import { tiersFor } from '../src/mcp/scopes.ts';

const oauth: OAuthConfig = {
    issuer: 'https://auth.example.com',
    audience: 'arr-mcp',
    jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
    scopes: { read: 'arr-mcp:read', write: 'arr-mcp:write', destructive: 'arr-mcp:destructive' }
};

const tiers = (...scopes: string[]) => tiersFor(oauth, scopes);

describe('tiersFor', () => {
    it('grants no write tier for a read-only token', () => {
        expect(tiers('arr-mcp:read')).toEqual(new Set());
    });

    it('grants the safe tier for a write scope', () => {
        expect(tiers('arr-mcp:read', 'arr-mcp:write')).toEqual(new Set(['safe']));
    });

    // The ordering rule, applied to the ceiling for the same reason
    // core/permissions.ts applies it to the config: a credential that may
    // delete a film but not re-monitor it describes no coherent policy.
    it('lets the destructive scope carry the safe tier with it', () => {
        expect(tiers('arr-mcp:destructive')).toEqual(new Set(['safe', 'destructive']));
    });

    it('unions independent scopes rather than treating them as a ladder', () => {
        expect(tiers('arr-mcp:write', 'arr-mcp:destructive')).toEqual(new Set(['safe', 'destructive']));
    });

    // A token that was granted nothing here should be told so, rather than
    // quietly handed the library.
    it('reports none-of-the-three as undefined, not as an empty ceiling', () => {
        expect(tiers()).toBeUndefined();
        expect(tiers('openid', 'profile')).toBeUndefined();
    });

    it('matches renamed scopes and ignores the default names when renamed', () => {
        const renamed = { ...oauth, scopes: { read: 'media:read', write: 'media:write', destructive: 'media:delete' } };
        expect(tiersFor(renamed, ['media:delete'])).toEqual(new Set(['safe', 'destructive']));
        expect(tiersFor(renamed, ['arr-mcp:destructive'])).toBeUndefined();
    });
});
