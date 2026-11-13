import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { clientAddress, forwardedElements, forwardedProto, isAddressOrCidr, isTrustedProxy } from '../src/core/trustedProxies.ts';

describe('auth.trusted_proxies entries', () => {
    it.each(['10.0.0.1', '172.18.0.0/16', 'fd00::1', 'fd00::/8', '0.0.0.0/0'])('accepts %s', entry => {
        expect(isAddressOrCidr(entry)).toBe(true);
    });

    it.each(['proxy.lan', '10.0.0.0/33', 'fd00::/129', '10.0.0.1/', '10.0.0.0/x', ''])('refuses %s', entry => {
        expect(isAddressOrCidr(entry)).toBe(false);
    });

    it('fails a config that names something other than an address', () => {
        const result = ConfigSchema.safeParse({ auth: { trusted_proxies: ['traefik'] }, services: {} });
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain('CIDR');
    });
});

describe('clientAddress', () => {
    const TRUSTED = ['172.18.0.0/16', 'fd00::/8'];

    it('is the peer when the list is empty, whatever the header says', () => {
        expect(clientAddress('192.168.1.50', '203.0.113.9', [])).toBe('192.168.1.50');
    });

    it('is the peer when the peer is not on the list', () => {
        expect(clientAddress('192.168.1.50', '203.0.113.9', TRUSTED)).toBe('192.168.1.50');
    });

    it('is the last hop a trusted proxy added', () => {
        expect(clientAddress('172.18.0.5', '198.51.100.1, 203.0.113.9', TRUSTED)).toBe('203.0.113.9');
    });

    it('skips hops that are themselves trusted proxies', () => {
        expect(clientAddress('172.18.0.5', '203.0.113.9, 172.18.0.7', TRUSTED)).toBe('203.0.113.9');
    });

    it('strips a port and brackets from a hop', () => {
        expect(clientAddress('172.18.0.5', '203.0.113.9:51234', TRUSTED)).toBe('203.0.113.9');
        expect(clientAddress('fd00::2', '[2001:db8::1]:443', TRUSTED)).toBe('2001:db8::1');
    });

    it('is the peer when a trusted proxy sends no header', () => {
        expect(clientAddress('172.18.0.5', undefined, TRUSTED)).toBe('172.18.0.5');
    });

    it('reads the Forwarded header when X-Forwarded-For is absent', () => {
        expect(clientAddress('172.18.0.5', undefined, TRUSTED, 'for=198.51.100.1, for=203.0.113.9;proto=https')).toBe('203.0.113.9');
        expect(clientAddress('172.18.0.5', undefined, TRUSTED, 'for="[2001:db8::1]:443", for=172.18.0.7')).toBe('2001:db8::1');
        expect(clientAddress('172.18.0.5', undefined, TRUSTED, 'For="203.0.113.9:51234"')).toBe('203.0.113.9');
    });

    it('ignores Forwarded from a peer that is not on the list', () => {
        expect(clientAddress('192.168.1.50', undefined, TRUSTED, 'for=203.0.113.9')).toBe('192.168.1.50');
    });

    // nginx and Traefik append to X-Forwarded-For but pass Forwarded through
    // untouched, so there it is whatever the client wrote.
    it('prefers X-Forwarded-For when both arrive', () => {
        expect(clientAddress('172.18.0.5', '203.0.113.9', TRUSTED, 'for=198.51.100.1')).toBe('203.0.113.9');
    });

    it('is the peer when Forwarded names no one', () => {
        expect(clientAddress('172.18.0.5', undefined, TRUSTED, 'proto=https')).toBe('172.18.0.5');
    });

    it('matches IPv6 ranges', () => {
        expect(isTrustedProxy('fd00::2', TRUSTED)).toBe(true);
        expect(isTrustedProxy('2001:db8::1', TRUSTED)).toBe(false);
    });
});

describe('forwardedElements', () => {
    it('reads for and proto per element, quoted or not', () => {
        expect(forwardedElements('for=192.0.2.60;proto=http;by=203.0.113.43, for="[2001:db8:cafe::17]:4711";Proto=HTTPS')).toEqual([
            { for: '192.0.2.60', proto: 'http' },
            { for: '[2001:db8:cafe::17]:4711', proto: 'HTTPS' }
        ]);
    });

    it('keeps a comma or semicolon inside a quoted value', () => {
        expect(forwardedElements('for="_a,b;c", for=192.0.2.1')).toEqual([{ for: '_a,b;c' }, { for: '192.0.2.1' }]);
    });
});

describe('forwardedProto', () => {
    const TRUSTED = ['172.18.0.0/16'];

    it('believes X-Forwarded-Proto from anyone while the list is empty', () => {
        expect(forwardedProto('192.168.1.50', 'https', undefined, [])).toBe('https');
    });

    it('ignores Forwarded while the list is empty', () => {
        expect(forwardedProto('192.168.1.50', undefined, 'proto=https', [])).toBeUndefined();
    });

    it('believes neither header from a peer off the list once it is set', () => {
        expect(forwardedProto('192.168.1.50', 'https', 'proto=https', TRUSTED)).toBeUndefined();
    });

    it('believes a listed proxy, X-Forwarded-Proto first', () => {
        expect(forwardedProto('172.18.0.5', 'https', 'proto=http', TRUSTED)).toBe('https');
        expect(forwardedProto('172.18.0.5', undefined, 'for=203.0.113.9;proto=https', TRUSTED)).toBe('https');
    });

    it('takes proto from the element the proxy added, not one the client wrote', () => {
        expect(forwardedProto('172.18.0.5', undefined, 'for=198.51.100.1;proto=https, for=203.0.113.9;proto=http', TRUSTED)).toBe('http');
    });
});
