import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import type { OAuthConfig } from '../config/schema.ts';
import { NO_CLIENT_ID } from '../core/audit.ts';

/**
 * Asymmetric only, listed rather than left open.
 *
 * An HMAC algorithm against a public JWKS is the classic alg-confusion
 * attack: the "key" is published, so anyone can mint a token. jose refuses
 * `none` and will not use an asymmetric JWK with a symmetric alg on its own,
 * but the list is one line and this is not a property to hold by implication.
 *
 * Ed25519 is here under both spellings: `EdDSA` from RFC 8037 and the fully
 * specified `Ed25519` that newer issuers emit. It carries no HMAC risk.
 */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA', 'Ed25519'];

/**
 * "The token may be perfectly good; we cannot check it."
 *
 * A distinct type because the HTTP answer differs: this is a 503, never a
 * 401. A 401 sends whoever is debugging after their own credential instead of
 * the outage.
 */
export class JwksUnavailable extends Error {}

/** jose's key-getter shape. Injectable so tests verify real signatures without a network. */
export type KeyResolver = JWTVerifyGetKey;

/**
 * A scope claim is a space-delimited string per RFC 8693, but enough issuers
 * mint the array form that refusing it would be a support burden rather than
 * a security property — the values are compared exactly either way.
 */
function scopesOf(claim: unknown): string[] {
    if (Array.isArray(claim)) return claim.filter((s): s is string => typeof s === 'string');
    if (typeof claim !== 'string') return [];
    return claim.split(' ').filter(s => s !== '');
}

/**
 * The resolver, with every failure but one reported as "could not check".
 *
 * Anything thrown while resolving a key is the issuer's side: an HTTP 500
 * or 502, an HTML error page, a timeout, a refused connection, a key set jose
 * cannot import. jose reports several of those under generic codes, so
 * listing them would leave the next unfamiliar code on the 401 path. Only
 * `jwtVerify`'s own signature and claim checks run outside this wrapper, and
 * those are the token's fault.
 *
 * `ERR_JWKS_NO_MATCHING_KEY` is the exception. It means the token names a key
 * the issuer does not publish, which is a forged token far more often than a
 * rotation we could not refetch.
 */
function outageAware(resolve: JWTVerifyGetKey): JWTVerifyGetKey {
    return async (...args) => {
        try {
            return await resolve(...args);
        } catch (err) {
            if ((err as { code?: string }).code === 'ERR_JWKS_NO_MATCHING_KEY') throw err;
            throw new JwksUnavailable("the issuer's key set could not be fetched", { cause: err });
        }
    };
}

/**
 * `createRemoteJWKSet` is the reason `jose` is here rather than a hand-rolled
 * verifier: it caches the key set, shares the in-flight fetch across a burst,
 * re-fetches on an unknown `kid` under a cooldown, and does not poison the
 * cache on a failed fetch. Built once per config load, not per request —
 * `Runtime` rebuilds it on reload.
 */
export function oauthVerifier(oauth: OAuthConfig, keys?: KeyResolver): OAuthTokenVerifier {
    const resolve = outageAware(keys ?? createRemoteJWKSet(new URL(oauth.jwks_uri)));

    return {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            let payload: JWTPayload;
            try {
                ({ payload } = await jwtVerify(token, resolve, {
                    issuer: oauth.issuer,
                    audience: oauth.audience,
                    algorithms: ALGORITHMS,
                    // Belt and braces: `verifyBearerToken` also refuses an
                    // AuthInfo with no expiresAt. Stating it here means the
                    // rule holds for any future caller of this verifier too.
                    requiredClaims: ['exp']
                }));
            } catch (err) {
                if (err instanceof JwksUnavailable) throw err;
                // Wrapped rather than rethrown: `verifyAccessToken`'s own
                // contract says to throw `OAuthError(InvalidToken)` for a bad
                // token, and `bearerAuthChallengeResponse` only recognises
                // that type — anything else, jose's own `JOSEError` included,
                // falls through to a bare 500 instead of the 401 the token
                // actually earned.
                throw new OAuthError(OAuthErrorCode.InvalidToken, err instanceof Error ? err.message : 'invalid token');
            }

            return {
                token,
                // `client_id` names the client; `sub` may name a user. Prefer
                // the one that answers "which credential is this".
                clientId: typeof payload.client_id === 'string' ? payload.client_id : ((payload.sub as string) ?? NO_CLIENT_ID),
                scopes: scopesOf(payload.scope),
                // `requiredClaims: ['exp']` above already refused a token
                // without one; the assertion just tells the type of that.
                expiresAt: payload.exp as number
                // `resource` is left unset on purpose: RFC 8707 says a set
                // value MUST match this server's resource identifier, and
                // nothing here validates that. Claiming it unchecked would be
                // worse than omitting it.
            };
        }
    };
}
