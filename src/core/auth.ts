import { ServiceError } from './errors.ts';

/**
 * Per-service request shaping, and nothing else. Resilience policy lives in
 * ServiceHttp; keeping the two apart is what stops Transmission's session
 * handshake leaking into the adapter contract.
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
     * request is worth re-attempting immediately. Transmission and qBittorrent
     * use this.
     *
     * A recovery attempt is transport-level: it must not consume the timeout
     * retry budget and must not count toward the circuit breaker.
     *
     * Async is allowed because qBittorrent's recovery is a login round trip,
     * not a header read.
     */
    recover?(response: Response): boolean | Promise<boolean>;
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


const QB_LOGIN_PATH = '/api/v2/auth/login';

/**
 * qBittorrent's WebUI: POST the credentials to `/api/v2/auth/login`, keep the
 * `SID` cookie, send it back on every call.
 *
 * Nothing logs in ahead of time — there is no cheap way to ask whether a
 * session is still valid, so this lets the 403 happen and recovers from it, the
 * same shape as Transmission's 409. An instance with "bypass authentication for
 * clients on localhost" enabled therefore never logs in at all.
 */
export function qbittorrentSession(creds: {
    url: string;
    username?: string;
    password?: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
}): AuthStrategy {
    const doFetch = creds.fetchImpl ?? fetch;
    let sid: string | undefined;

    return {
        id: 'qbittorrent-session',
        apply(ctx) {
            if (sid !== undefined) ctx.headers.set('Cookie', `SID=${sid}`);
        },
        async recover(response) {
            if (response.status !== 403) return false;
            // Nothing to retry with; let the 403 stand as AuthFailed.
            if (creds.username === undefined) return false;

            sid = await qbittorrentLogin(creds, doFetch);
            return true;
        }
    };
}

async function qbittorrentLogin(
    creds: { url: string; username?: string; password?: string; timeoutMs: number },
    doFetch: typeof fetch
): Promise<string> {
    const base = new URL(creds.url);
    const url = new URL(base.pathname.replace(/\/+$/, '') + QB_LOGIN_PATH, base);

    let response: Response;
    try {
        response = await doFetch(url.toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                username: creds.username ?? '',
                password: creds.password ?? ''
            }).toString(),
            signal: AbortSignal.timeout(creds.timeoutMs)
        });
    } catch (err) {
        throw new ServiceError('AuthFailed', 'qbittorrent', 'the login request failed', { cause: err });
    }

    if (response.status === 403) {
        throw new ServiceError('AuthFailed', 'qbittorrent', 'login refused', {
            remedy: 'qBittorrent bans a client after repeated failed logins. Wait, or clear the ban in Options → Web UI.'
        });
    }

    // A wrong password is HTTP 200 with the body "Fails.", so the status line
    // alone would read as a successful login that set no cookie.
    const body = (await response.text()).trim();
    if (!response.ok || body !== 'Ok.') {
        throw new ServiceError('AuthFailed', 'qbittorrent', `login returned "${body || response.status}"`, {
            remedy: 'Check username and password against Options → Web UI in qBittorrent.'
        });
    }

    const offered = readSid(response);
    if (offered === undefined) {
        throw new ServiceError('AuthFailed', 'qbittorrent', 'login succeeded but set no SID cookie');
    }
    return offered;
}

function readSid(response: Response): string | undefined {
    const multi = response.headers.getSetCookie?.() ?? [];
    const single = response.headers.get('set-cookie');
    const all = multi.length > 0 ? multi : single === null ? [] : [single];

    for (const cookie of all) {
        const match = /(?:^|,\s*)SID=([^;,\s]+)/.exec(cookie);
        if (match?.[1] !== undefined) return match[1];
    }
    return undefined;
}
