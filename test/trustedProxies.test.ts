import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { clientAddress, isAddressOrCidr, isTrustedProxy } from '../src/core/trustedProxies.ts';

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

    it('matches IPv6 ranges', () => {
        expect(isTrustedProxy('fd00::2', TRUSTED)).toBe(true);
        expect(isTrustedProxy('2001:db8::1', TRUSTED)).toBe(false);
    });
});
