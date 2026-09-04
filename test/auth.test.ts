import { describe, expect, it } from 'vitest';
import { apiKeyHeader, embyToken, plexToken, qbittorrentSession, queryParamKey, transmissionRpc } from '../src/core/auth.ts';

const ctx = (url = 'http://h:7878/api/v3/system/status', method = 'GET') => ({
    url: new URL(url),
    headers: new Headers(),
    method
});

describe('apiKeyHeader', () => {
    it('puts the key in the named header and never in the query string', () => {
        const c = ctx();
        apiKeyHeader('X-Api-Key', 'secret').apply(c);
        expect(c.headers.get('X-Api-Key')).toBe('secret');
        expect(c.url.toString()).not.toContain('secret');
    });

    it('honours a service that spells the header differently', () => {
        const c = ctx();
        apiKeyHeader('X-API-KEY', 'secret').apply(c);
        expect(c.headers.get('x-api-key')).toBe('secret');
    });
});

describe('embyToken', () => {
    it('emits the MediaBrowser authorization header Jellyfin expects', () => {
        const c = ctx('http://h:8096/System/Info');
        embyToken('secret').apply(c);
        expect(c.headers.get('Authorization')).toBe('MediaBrowser Token="secret"');
    });
});

describe('queryParamKey', () => {
    it('appends the key as a query parameter, preserving existing ones', () => {
        const c = ctx('http://h:8080/api?mode=version&output=json');
        queryParamKey('apikey', 'secret').apply(c);
        expect(c.url.searchParams.get('apikey')).toBe('secret');
        expect(c.url.searchParams.get('mode')).toBe('version');
    });
});

describe('transmissionRpc', () => {
    it('sends Basic auth when credentials are configured', () => {
        const c = ctx('http://h:9091/transmission/rpc', 'POST');
        transmissionRpc({ username: 'u', password: 'p' }).apply(c);
        expect(c.headers.get('Authorization')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    });

    it('sends no authorization header when no credentials are configured', () => {
        const c = ctx('http://h:9091/transmission/rpc', 'POST');
        transmissionRpc({}).apply(c);
        expect(c.headers.get('Authorization')).toBeNull();
    });

    it('learns the session id from a 409 and replays it on the next request', () => {
        const auth = transmissionRpc({});
        const challenge = new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': 'sid-1' } });

        expect(auth.recover?.(challenge)).toBe(true);

        const c = ctx('http://h:9091/transmission/rpc', 'POST');
        auth.apply(c);
        expect(c.headers.get('X-Transmission-Session-Id')).toBe('sid-1');
    });

    it('does not claim recovery for a 409 that carries no session id', () => {
        const auth = transmissionRpc({});
        expect(auth.recover?.(new Response('', { status: 409 }))).toBe(false);
    });

    it('does not claim recovery for an ordinary error status', () => {
        const auth = transmissionRpc({});
        expect(auth.recover?.(new Response('', { status: 401 }))).toBe(false);
    });
});

describe('plexToken', () => {
    const apply = (token: string) => {
        const headers = new Headers();
        const url = new URL('http://192.0.2.10:32400/status/sessions');
        plexToken(token).apply({ url, headers, method: 'GET' });
        return { headers, url };
    };

    it('sends the token as a header', () => {
        expect(apply('abc123').headers.get('X-Plex-Token')).toBe('abc123');
    });

    it('never puts the token in the URL, which reaches error messages and proxy logs', () => {
        const { url } = apply('abc123');
        expect(url.toString()).not.toContain('abc123');
        expect(url.searchParams.get('X-Plex-Token')).toBeNull();
    });
});

describe('qbittorrentSession', () => {
    const BASE = 'http://h:8081';
    const forbidden = () => new Response('Forbidden', { status: 403 });
    const loggedIn = (sid = 'sid-1') =>
        new Response('Ok.', { status: 200, headers: { 'set-cookie': `SID=${sid}; path=/; HttpOnly` } });

    const session = (over: Partial<Parameters<typeof qbittorrentSession>[0]> = {}, impl?: typeof fetch) =>
        qbittorrentSession({
            url: BASE,
            timeoutMs: 1000,
            username: 'u',
            password: 'p',
            ...over,
            ...(impl === undefined ? {} : { fetchImpl: impl })
        });

    it('sends no cookie until it has logged in', () => {
        const c = ctx(`${BASE}/api/v2/app/version`);
        session().apply(c);
        expect(c.headers.get('Cookie')).toBeNull();
    });

    it('logs in on a 403 and replays the SID on the next request', async () => {
        const calls: { url: string; body: string }[] = [];
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(input), body: (init?.body as string) ?? '' });
            return loggedIn();
        }) as unknown as typeof fetch;

        const auth = session({}, impl);
        expect(await auth.recover?.(forbidden())).toBe(true);

        const c = ctx(`${BASE}/api/v2/app/version`);
        auth.apply(c);
        expect(c.headers.get('Cookie')).toBe('SID=sid-1');
        expect(calls[0]?.url).toBe(`${BASE}/api/v2/auth/login`);
        expect(Object.fromEntries(new URLSearchParams(calls[0]?.body ?? ''))).toEqual({
            username: 'u',
            password: 'p'
        });
    });

    it('honours a base URL that carries a path prefix', async () => {
        let seen: string | undefined;
        const impl = (async (input: string | URL | Request) => {
            seen = String(input);
            return loggedIn();
        }) as unknown as typeof fetch;

        await session({ url: 'http://h/qbit/' }, impl).recover?.(forbidden());
        expect(seen).toBe('http://h/qbit/api/v2/auth/login');
    });

    // A wrong password is HTTP 200 with the body "Fails.".
    it('treats a 200 "Fails." as an auth failure rather than a login', async () => {
        const impl = (async () => new Response('Fails.', { status: 200 })) as unknown as typeof fetch;
        await expect(session({}, impl).recover?.(forbidden())).rejects.toThrow(/auth failed/i);
    });

    it('fails rather than silently continuing when login sets no cookie', async () => {
        const impl = (async () => new Response('Ok.', { status: 200 })) as unknown as typeof fetch;
        await expect(session({}, impl).recover?.(forbidden())).rejects.toThrow(/no SID cookie/i);
    });

    it('names the ban when qBittorrent refuses the login itself', async () => {
        const impl = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
        await expect(session({}, impl).recover?.(forbidden())).rejects.toThrow(/bans a client/i);
    });

    // A banned client sees this 403 on every login attempt for the ban's
    // duration, so leaving its body unread pins one connection per attempt.
    it('reads the login response body even when the login itself is refused', async () => {
        let loginResponse: Response | undefined;
        const impl = (async () => {
            loginResponse = new Response('', { status: 403 });
            return loginResponse;
        }) as unknown as typeof fetch;

        await expect(session({}, impl).recover?.(forbidden())).rejects.toThrow(/bans a client/i);
        expect(loginResponse?.bodyUsed).toBe(true);
    });

    it('does not attempt a login when no credentials are configured', async () => {
        let called = false;
        const impl = (async () => {
            called = true;
            return loggedIn();
        }) as unknown as typeof fetch;

        const auth = qbittorrentSession({ url: BASE, timeoutMs: 1000, fetchImpl: impl });
        expect(await auth.recover?.(forbidden())).toBe(false);
        expect(called).toBe(false);
    });

    it('recovers from 403 only — a 404 is not an expired session', async () => {
        expect(await session().recover?.(new Response('', { status: 404 }))).toBe(false);
    });
});
