/**
 * Per-service request shaping, and nothing else. Resilience policy lives in
 * ServiceHttp; keeping the two apart is what stops Transmission's session
 * handshake leaking into the adapter contract (design spec §6).
 */
export interface AuthContext {
    url: URL;
    headers: Headers;
    method: string;
}

export interface AuthStrategy {
    readonly id: string;
    apply(ctx: AuthContext): void;
    /**
     * Given a failed response, mutate internal state and return true when the
     * request is worth re-attempting immediately. Only Transmission uses this.
     *
     * A recovery attempt is transport-level: it must not consume the timeout
     * retry budget and must not count toward the circuit breaker.
     */
    recover?(response: Response): boolean;
}

/** Radarr, Sonarr, Prowlarr and Seerr use `X-Api-Key`; Bazarr uses `X-API-KEY`. */
export function apiKeyHeader(header: string, key: string): AuthStrategy {
    return {
        id: `header:${header}`,
        apply(ctx) {
            ctx.headers.set(header, key);
        }
    };
}

/** Jellyfin. The quoted form is what the server parses; bare tokens are rejected. */
export function embyToken(key: string): AuthStrategy {
    return {
        id: 'emby-token',
        apply(ctx) {
            ctx.headers.set('Authorization', `MediaBrowser Token="${key}"`);
        }
    };
}

/**
 * SABnzbd, whose API is entirely query-parameter driven. The key therefore
 * appears in the URL — which is why ServiceHttp never puts a full URL into an
 * error message. It uses the origin and path only.
 */
export function queryParamKey(param: string, key: string): AuthStrategy {
    return {
        id: `query:${param}`,
        apply(ctx) {
            ctx.url.searchParams.set(param, key);
        }
    };
}

/**
 * Transmission RPC. The server answers an unrecognised session with 409 and a
 * fresh `X-Transmission-Session-Id`; the client stores it and repeats the call.
 *
 * A cold start therefore always costs one 409, which is exactly why `recover`
 * exists rather than letting the breaker count it as a failure — a working
 * Transmission would otherwise trip its own breaker on startup.
 */
export function transmissionRpc(creds: { username?: string; password?: string }): AuthStrategy {
    let sessionId: string | undefined;

    return {
        id: 'transmission-rpc',
        apply(ctx) {
            if (creds.username !== undefined) {
                const basic = Buffer.from(`${creds.username}:${creds.password ?? ''}`).toString('base64');
                ctx.headers.set('Authorization', `Basic ${basic}`);
            }
            if (sessionId !== undefined) {
                ctx.headers.set('X-Transmission-Session-Id', sessionId);
            }
        },
        recover(response) {
            if (response.status !== 409) return false;
            const offered = response.headers.get('X-Transmission-Session-Id');
            if (!offered) return false;
            sessionId = offered;
            return true;
        }
    };
}
