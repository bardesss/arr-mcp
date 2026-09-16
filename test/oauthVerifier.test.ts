import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import type { OAuthConfig } from '../src/config/schema.ts';
import { JwksUnavailable, oauthVerifier } from '../src/mcp/oauthVerifier.ts';

const oauth: OAuthConfig = {
    issuer: 'https://auth.example.com',
    audience: 'arr-mcp',
    jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
    scopes: { read: 'arr-mcp:read', write: 'arr-mcp:write', destructive: 'arr-mcp:destructive' }
};

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
const keys = createLocalJWKSet({ keys: [jwk] });

const token = (claims: Record<string, unknown>, over: { exp?: number | null; alg?: string } = {}) => {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: over.alg ?? 'RS256', kid: 'test' }).setIssuedAt();
    if (over.exp !== null) jwt = jwt.setExpirationTime(over.exp ?? '5m');
    return jwt.sign(privateKey);
};

const verify = (jwt: string) => oauthVerifier(oauth, keys).verifyAccessToken(jwt);

describe('oauthVerifier', () => {
    it('accepts a well-formed token and reports its scopes', async () => {
        const info = await verify(
            await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'client-1', scope: 'arr-mcp:read arr-mcp:write' })
        );
        expect(info.scopes).toEqual(['arr-mcp:read', 'arr-mcp:write']);
        expect(info.clientId).toBe('client-1');
        expect(typeof info.expiresAt).toBe('number');
    });

    it('prefers client_id over sub for identity, since that is what it names', async () => {
        const info = await verify(
            await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'user-9', client_id: 'cli-3', scope: 'arr-mcp:read' })
        );
        expect(info.clientId).toBe('cli-3');
    });

    it('reads the array form of scope, which some issuers mint', async () => {
        const info = await verify(await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c', scope: ['arr-mcp:read'] }));
        expect(info.scopes).toEqual(['arr-mcp:read']);
    });

    it('refuses a token from an issuer this server does not name', async () => {
        await expect(verify(await token({ iss: 'https://evil.example.com', aud: 'arr-mcp', sub: 'c' }))).rejects.toThrow();
    });

    // Without the audience check, every token that issuer ever minted for any
    // of its clients is accepted here.
    it('refuses a token minted for a different audience', async () => {
        await expect(verify(await token({ iss: oauth.issuer, aud: 'some-other-app', sub: 'c' }))).rejects.toThrow();
    });

    // A token minted without one is a credential that never expires, which is
    // the exact thing OAuth mode is meant to be better than. RFC 9068
    // requires it on access tokens.
    it('refuses a token with no exp claim at all', async () => {
        await expect(verify(await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c' }, { exp: null }))).rejects.toThrow();
    });

    it('refuses an expired token', async () => {
        const expired = await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c' }, { exp: Math.floor(Date.now() / 1000) - 60 });
        await expect(verify(expired)).rejects.toThrow();
    });

    it('refuses a token signed with a key the issuer does not publish', async () => {
        const other = await generateKeyPair('RS256');
        const forged = await new SignJWT({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c' })
            .setProtectedHeader({ alg: 'RS256', kid: 'test' })
            .setExpirationTime('5m')
            .sign(other.privateKey);
        await expect(verify(forged)).rejects.toThrow();
    });

    // The presented token may be perfectly good; we simply cannot check it.
    // A 401 sends whoever is debugging after their own credential instead of
    // the outage — so this failure must be distinguishable by type.
    it('reports a JWKS outage as JwksUnavailable, not as a bad token', async () => {
        const unreachable = () => Promise.reject(new TypeError('fetch failed'));
        const verifier = oauthVerifier(oauth, unreachable as never);
        const good = await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c', scope: 'arr-mcp:read' });
        await expect(verifier.verifyAccessToken(good)).rejects.toBeInstanceOf(JwksUnavailable);
    });
});
