import { describe, expect, it } from 'vitest';
import { apiKeyHeader, embyToken, queryParamKey, transmissionRpc } from '../src/core/auth.ts';

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
