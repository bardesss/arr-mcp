import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, describe, expect, it } from 'vitest';
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

    /** Empty, not a readable word: a client's actual id could be "unknown", and
     *  the audit trail must never hold one value meaning two things. */
    it('reports a token with neither client_id nor sub as the empty client id', async () => {
        const info = await verify(await token({ iss: oauth.issuer, aud: 'arr-mcp', scope: 'arr-mcp:read' }));
        expect(info.clientId).toBe('');
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

    // `bearerAuthChallengeResponse` (the SDK helper `/mcp` hands this
    // rejection to) maps only `OAuthError` to 401/403 — anything else, a raw
    // `JOSEError` included, falls through to a bare 500. The interface's own
    // doc on `OAuthTokenVerifier.verifyAccessToken` says as much.
    it('rejects a bad token as an OAuthError carrying InvalidToken, not a raw jose error', async () => {
        const bad = await token({ iss: 'https://evil.example.com', aud: 'arr-mcp', sub: 'c' });
        await expect(verify(bad)).rejects.toBeInstanceOf(OAuthError);
        try {
            await verify(bad);
            expect.unreachable('expected verify to throw');
        } catch (err) {
            expect((err as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
        }
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

    it('reports a JWKS failure jose files under a generic code as JwksUnavailable', async () => {
        const generic = () => Promise.reject(Object.assign(new Error('Expected 200 OK'), { code: 'ERR_JOSE_GENERIC' }));
        const good = await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c', scope: 'arr-mcp:read' });
        await expect(oauthVerifier(oauth, generic as never).verifyAccessToken(good)).rejects.toBeInstanceOf(JwksUnavailable);
    });

    it('accepts an Ed25519-signed token under both alg spellings', async () => {
        const ed = await generateKeyPair('Ed25519');
        const edKeys = createLocalJWKSet({ keys: [{ ...(await exportJWK(ed.publicKey)), kid: 'ed' }] });
        for (const alg of ['EdDSA', 'Ed25519']) {
            const jwt = await new SignJWT({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c', scope: 'arr-mcp:read' })
                .setProtectedHeader({ alg, kid: 'ed' })
                .setExpirationTime('5m')
                .sign(ed.privateKey);
            await expect(oauthVerifier(oauth, edKeys).verifyAccessToken(jwt)).resolves.toMatchObject({ clientId: 'c' });
        }
    });
});

// Everything above injects its keys. This drives the real
// `createRemoteJWKSet` against a loopback issuer, because the failures that
// matter in production are HTTP ones the injected resolver cannot produce.
describe('oauthVerifier against a live jwks_uri', async () => {
    let mode: 'ok' | 'http500' | 'html' = 'ok';
    const server = createServer((_req, res) => {
        if (mode === 'http500') return void res.writeHead(500).end('{"error":"boom"}');
        if (mode === 'html') return void res.writeHead(502, { 'content-type': 'text/html' }).end('<html>502</html>');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    afterAll(() => void server.close());

    const live = { ...oauth, jwks_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks` };
    const good = await token({ iss: oauth.issuer, aud: 'arr-mcp', sub: 'c', scope: 'arr-mcp:read' });

    it('verifies a token against the fetched key set', async () => {
        mode = 'ok';
        await expect(oauthVerifier(live).verifyAccessToken(good)).resolves.toMatchObject({ clientId: 'c' });
    });

    // A fresh verifier each time, so nothing is served from a cached key set.
    it.each(['http500', 'html'] as const)('reports a %s from the issuer as JwksUnavailable, not a bad token', async m => {
        mode = m;
        await expect(oauthVerifier(live).verifyAccessToken(good)).rejects.toBeInstanceOf(JwksUnavailable);
    });
});
