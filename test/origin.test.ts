import { describe, expect, it } from 'vitest';
import { mcpEndpoint, sameOrigin } from '../src/web/origin.ts';
import type { Context } from 'hono';

describe('mcpEndpoint', () => {
    it('builds the endpoint from the address the browser actually used', () => {
        expect(mcpEndpoint('http://192.168.1.20:6060/ui', undefined)).toBe('http://192.168.1.20:6060/mcp');
    });

    it('keeps a host that carries no port', () => {
        expect(mcpEndpoint('http://arr.example.com/ui', undefined)).toBe('http://arr.example.com/mcp');
    });

    it('replaces whatever path the request was for', () => {
        expect(mcpEndpoint('http://arr.example.com/ui/logs?stream=all', undefined)).toBe(
            'http://arr.example.com/mcp'
        );
    });

    // The whole reason to read a forwarded header: without it a proxy that
    // terminates TLS gets handed an http:// URL that cannot work.
    it('uses https when the proxy reports the browser spoke https', () => {
        expect(mcpEndpoint('http://arr.example.com/ui', 'https')).toBe('https://arr.example.com/mcp');
    });

    it('reads only the first hop of a chained X-Forwarded-Proto', () => {
        expect(mcpEndpoint('http://arr.example.com/ui', 'https, http')).toBe('https://arr.example.com/mcp');
    });

    it('treats an unrecognised proto as plain http rather than trusting it', () => {
        expect(mcpEndpoint('http://arr.example.com:6060/ui', 'gopher')).toBe('http://arr.example.com:6060/mcp');
    });

    // The scheme comes from the proxy header, never from the request URL: the
    // node adapter always builds an http:// URL, so trusting it would make the
    // https case unreachable.
    it('ignores the scheme of the request URL', () => {
        expect(mcpEndpoint('https://arr.example.com/ui', undefined)).toBe('http://arr.example.com/mcp');
    });

    it('handles a bracketed IPv6 host', () => {
        expect(mcpEndpoint('http://[2001:db8::1]:6060/ui', undefined)).toBe('http://[2001:db8::1]:6060/mcp');
    });

    it('gives up rather than inventing a URL when the request URL is unusable', () => {
        expect(mcpEndpoint('', undefined)).toBeUndefined();
        expect(mcpEndpoint('/ui', undefined)).toBeUndefined();
        expect(mcpEndpoint('not a url', 'https')).toBeUndefined();
    });

    // A URL with no authority parses, but has nothing to point a client at.
    it('gives up on a URL that carries no host', () => {
        expect(mcpEndpoint('file:///etc/passwd', undefined)).toBeUndefined();
    });
});

const ctx = (headers: Record<string, string>, url = 'http://box:6060/ui/setup'): Context =>
    ({ req: { url, header: (name: string) => headers[name.toLowerCase()] } }) as unknown as Context;

describe('sameOrigin', () => {
    it('accepts a request with no Origin, since non-browser clients send none', () => {
        expect(sameOrigin(ctx({}))).toBe(true);
    });

    it('accepts a matching Origin', () => {
        expect(sameOrigin(ctx({ origin: 'http://box:6060' }))).toBe(true);
    });

    it('refuses a foreign Origin', () => {
        expect(sameOrigin(ctx({ origin: 'http://evil.example' }))).toBe(false);
    });

    it('refuses a cross-site fetch even without an Origin', () => {
        expect(sameOrigin(ctx({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    });

    it('refuses an unparseable Origin', () => {
        expect(sameOrigin(ctx({ origin: 'not a url' }))).toBe(false);
    });
});
