import { beforeEach, describe, expect, it } from 'vitest';
import { GRIMMORY_LOGIN_PATH, LOGIN_LOCKOUT_MS, grimmorySession, resetGrimmoryLockouts } from '../src/core/auth.ts';
import { ServiceError } from '../src/core/errors.ts';

interface Call {
    url: string;
    init: RequestInit;
}

function setup(opts: { id?: string; url?: string; replies?: Array<() => Response> } = {}) {
    const calls: Call[] = [];
    let n = 0;
    let t = 1_000_000;
    const replies = opts.replies ?? [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const reply = replies[Math.min(n, replies.length - 1)];
        n += 1;
        return reply === undefined
            ? new Response(JSON.stringify({ accessToken: `A${n}`, refreshToken: 'R', expires: 7200 }), { status: 200 })
            : reply();
    }) as unknown as typeof fetch;
    const auth = grimmorySession({
        id: opts.id ?? 'grimmory',
        url: opts.url ?? 'http://h:6060',
        username: 'u',
        password: 'p',
        timeoutMs: 1000,
        fetchImpl,
        now: () => t
    });
    return {
        auth,
        calls,
        advance: (s: number) => (t += s * 1000),
        header: () => {
            const headers = new Headers();
            auth.apply({ url: new URL('http://h:6060/api/v1/books'), headers, method: 'GET' });
            return headers.get('Authorization');
        }
    };
}

const unauthorized = () => new Response(null, { status: 401 });
const LOCKOUT_S = LOGIN_LOCKOUT_MS / 1000;

async function rejection(p: Promise<unknown>): Promise<ServiceError> {
    try {
        await p;
    } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        return err as ServiceError;
    }
    throw new Error('expected a rejection');
}

describe('grimmorySession', () => {
    beforeEach(() => resetGrimmoryLockouts());

    it('does not log in before the first request', () => {
        const s = setup();
        expect(s.header()).toBeNull();
        expect(s.calls).toHaveLength(0);
    });

    it('logs in on a 401 and retries', async () => {
        const s = setup();
        await expect(s.auth.recover?.(unauthorized())).resolves.toBe(true);
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0]?.url).toBe(`http://h:6060${GRIMMORY_LOGIN_PATH}`);
        expect(s.calls[0]?.init.method).toBe('POST');
        expect(s.calls[0]?.init.body).toBe('{"username":"u","password":"p"}');
        expect(s.header()).toBe('Bearer A1');
    });

    it('keeps a reverse proxy path prefix', async () => {
        const s = setup({ url: 'https://h/grimmory/' });
        await s.auth.recover?.(unauthorized());
        expect(s.calls[0]?.url).toBe('https://h/grimmory/api/v1/auth/login');
    });

    it('logs in again shortly before expiry', async () => {
        const s = setup();
        await s.auth.recover?.(unauthorized());
        s.advance(7139);
        expect(s.header()).toBe('Bearer A1');
        s.advance(2);
        expect(s.header()).toBeNull();
        await s.auth.recover?.(unauthorized());
        expect(s.calls).toHaveLength(2);
        expect(s.header()).toBe('Bearer A2');
    });

    it('single-flight under a burst of 401s', async () => {
        const s = setup();
        const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve(s.auth.recover?.(unauthorized()))));
        expect(results.every((r) => r === true)).toBe(true);
        expect(s.calls).toHaveLength(1);
    });

    it('never logs in twice inside the lockout', async () => {
        const s = setup({ replies: [unauthorized] });
        const first = await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(first.kind).toBe('AuthFailed');
        expect(first.remedy).toMatch(/username or password/);
        expect(first.remedy).toMatch(/15 minutes|\d{2}:\d{2}/);
        expect(s.calls).toHaveLength(1);

        s.advance(LOCKOUT_S - 1);
        for (let i = 0; i < 10; i++) {
            const err = await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
            expect(err.kind).toBe('AuthFailed');
            expect(err.remedy).toMatch(/username or password/);
        }
        expect(s.calls).toHaveLength(1);

        s.advance(2);
        await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(s.calls).toHaveLength(2);
    });

    it('locks out after a 200 with no accessToken', async () => {
        const s = setup({ replies: [() => new Response('{"expires":7200}', { status: 200 })] });
        await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(s.calls).toHaveLength(1);
    });

    it('a 403 from login starts the lockout', async () => {
        const s = setup({ replies: [() => new Response(null, { status: 403 })] });
        await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(s.calls).toHaveLength(1);
    });

    it('a 429 from login starts the lockout', async () => {
        const s = setup({ replies: [() => new Response(null, { status: 429 })] });
        await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(s.calls).toHaveLength(1);
    });

    it('a 502 from login fails without a lockout', async () => {
        const s = setup({ replies: [() => new Response(null, { status: 502 }), () => new Response(JSON.stringify({ accessToken: 'B', expires: 7200 }), { status: 200 })] });
        const err = await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(err.kind).toBe('AuthFailed');
        expect(err.detail).toBe('login returned HTTP 502');
        expect(err.message).not.toMatch(/password/i);
        await expect(s.auth.recover?.(unauthorized())).resolves.toBe(true);
        expect(s.calls).toHaveLength(2);
        expect(s.header()).toBe('Bearer B');
    });

    it('never calls refresh', async () => {
        const s = setup();
        await s.auth.recover?.(unauthorized());
        s.advance(8000);
        await s.auth.recover?.(unauthorized());
        const f = setup({ replies: [unauthorized] });
        await rejection(Promise.resolve(f.auth.recover?.(unauthorized())));
        for (const c of [...s.calls, ...f.calls]) expect(c.url).not.toContain('/auth/refresh');
    });

    it('refuses to follow a redirect with the password', async () => {
        const s = setup({ replies: [() => new Response(null, { status: 302, headers: { location: 'https://sso.example/login' } })] });
        const err = await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(err.kind).toBe('AuthFailed');
        expect(err.message + (err.detail ?? '')).toContain('sso.example');
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0]?.init.redirect).toBe('manual');
    });

    it('errors carry the given id', async () => {
        const s = setup({ id: 'grimmory', replies: [unauthorized] });
        const err = await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(err.service).toBe('grimmory');
        const again = await rejection(Promise.resolve(s.auth.recover?.(unauthorized())));
        expect(again.service).toBe('grimmory');
    });

    it('ignores a 403 on an ordinary request', async () => {
        const s = setup();
        await expect(s.auth.recover?.(new Response(null, { status: 403 }))).resolves.toBe(false);
        expect(s.calls).toHaveLength(0);
    });

    it('shares the lockout between separate session instances', async () => {
        const first = setup({ replies: [unauthorized] });
        await rejection(Promise.resolve(first.auth.recover?.(unauthorized())));
        expect(first.calls).toHaveLength(1);

        // A fresh instance, as the Test button or a config reload builds.
        const second = setup({ replies: [unauthorized] });
        second.advance(LOCKOUT_S - 1);
        const err = await rejection(Promise.resolve(second.auth.recover?.(unauthorized())));
        expect(err.kind).toBe('AuthFailed');
        expect(err.remedy).toMatch(/username or password/);
        expect(second.calls).toHaveLength(0);
    });

    it('lets a changed password have its own attempt', async () => {
        const first = setup({ replies: [unauthorized] });
        await rejection(Promise.resolve(first.auth.recover?.(unauthorized())));
        const calls: string[] = [];
        const other = grimmorySession({
            id: 'grimmory',
            url: 'http://h:6060',
            username: 'u',
            password: 'different',
            timeoutMs: 1000,
            fetchImpl: (async (url: string) => {
                calls.push(url);
                return new Response(JSON.stringify({ accessToken: 'X', expires: 7200 }), { status: 200 });
            }) as unknown as typeof fetch,
            now: () => 1_000_000
        });
        await expect(other.recover?.(unauthorized())).resolves.toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('never puts url userinfo into a request or an error', async () => {
        const calls: string[] = [];
        const strict = (async (url: string) => {
            calls.push(url);
            // What real fetch does with a url that carries credentials.
            if (url.includes('@')) throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`);
            return new Response(JSON.stringify({ accessToken: 'X', expires: 7200 }), { status: 200 });
        }) as unknown as typeof fetch;
        const auth = grimmorySession({
            id: 'grimmory',
            url: 'http://proxyuser:s3kr1tproxy@h:6060/',
            username: 'u',
            password: 'p',
            timeoutMs: 1000,
            fetchImpl: strict,
            now: () => 1_000_000
        });
        await expect(auth.recover?.(unauthorized())).resolves.toBe(true);
        expect(calls).toEqual([`http://h:6060${GRIMMORY_LOGIN_PATH}`]);
        for (const c of calls) expect(c).not.toContain('s3kr1tproxy');
    });
});
