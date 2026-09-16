import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import type { OAuthConfig } from '../config/schema.ts';

/**
 * Asymmetric only, listed rather than left open.
 *
 * An HMAC algorithm against a public JWKS is the classic alg-confusion
 * attack: the "key" is published, so anyone can mint a token. jose refuses
 * `none` and will not use an asymmetric JWK with a symmetric alg on its own,
 * but the list is one line and this is not a property to hold by implication.
 */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

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
 * Whether a failure means "we could not reach the issuer's keys".
 *
 * jose reports a transport problem as a timeout or an invalid JWKS document,
 * and a bare `fetch` failure propagates as a TypeError. A signature or claim
 * failure is a `JOSEError` with its own code — those are the token's fault
 * and belong on the 401 path.
 *
 * `ERR_JWKS_NO_MATCHING_KEY` is deliberately *not* here. It means the token
 * names a key the issuer does not publish, which is a forged token far more
 * often than a rotation we could not refetch.
 */
function unreachable(err: unknown): boolean {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_INVALID') return true;
    return code === undefined;
}

/**
 * `createRemoteJWKSet` is the reason `jose` is here rather than a hand-rolled
 * verifier: it caches the key set, shares the in-flight fetch across a burst,
 * re-fetches on an unknown `kid` under a cooldown, and does not poison the
 * cache on a failed fetch. Built once per config load, not per request —
 * `Runtime` rebuilds it on reload.
 */
export function oauthVerifier(oauth: OAuthConfig, keys?: KeyResolver): OAuthTokenVerifier {
    const resolve: JWTVerifyGetKey = keys ?? createRemoteJWKSet(new URL(oauth.jwks_uri));

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
                if (unreachable(err)) throw new JwksUnavailable("the issuer's key set could not be fetched", { cause: err });
                throw err;
            }

            return {
                token,
                // `client_id` names the client; `sub` may name a user. Prefer
                // the one that answers "which credential is this".
                clientId: typeof payload.client_id === 'string' ? payload.client_id : ((payload.sub as string) ?? 'unknown'),
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
