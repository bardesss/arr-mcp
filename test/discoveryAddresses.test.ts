import { describe, expect, it, vi } from 'vitest';
import {
  defaultSweepRange,
  isPrivateAddress,
  parseSweepRange,
  requestHost,
  resolvePrivate,
} from '../src/discovery/addresses.js';

describe('isPrivateAddress', () => {
  it.each(['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1', '100.127.255.255', 'fd00::5'])(
    'accepts %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['172.32.0.1', '100.128.0.1', '8.8.8.8', '127.0.0.1', '::1', 'fe80::1', '169.254.1.1', 'nonsense'])(
    'rejects %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('requestHost', () => {
  it('strips the port and brackets', () => {
    expect(requestHost('192.168.1.10:6060')).toBe('192.168.1.10');
    expect(requestHost('[fd00::5]:6060')).toBe('fd00::5');
    expect(requestHost('arr.example.com')).toBe('arr.example.com');
    expect(requestHost('localhost:6060')).toBe('localhost');
  });
  it('returns undefined for a missing or empty header', () => {
    expect(requestHost(undefined)).toBeUndefined();
    expect(requestHost('')).toBeUndefined();
  });
});

describe('resolvePrivate', () => {
  it('refuses localhost', async () => {
    const r = await resolvePrivate('localhost', async () => ['127.0.0.1']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not a private address');
  });
  it('refuses a public name', async () => {
    const r = await resolvePrivate('arr.example.com', async () => ['104.21.3.4']);
    expect(r.ok).toBe(false);
  });
  it('accepts a private name', async () => {
    const r = await resolvePrivate('nas.lan', async () => ['192.168.1.20']);
    expect(r).toEqual({ ok: true, host: 'nas.lan', address: '192.168.1.20' });
  });
  it('accepts a private A record beside a public AAAA record, and probes the IPv4', async () => {
    const r = await resolvePrivate('fritz.box', async () => ['2a02:8109:1234::1', '192.168.178.1']);
    expect(r).toEqual({ ok: true, host: 'fritz.box', address: '192.168.178.1' });
  });
  it('prefers a private IPv4 over a unique-local IPv6 listed first', async () => {
    const r = await resolvePrivate('nas.lan', async () => ['fd00::5', '192.168.1.20']);
    expect(r).toEqual({ ok: true, host: 'nas.lan', address: '192.168.1.20' });
  });
  it('takes a unique-local IPv6 when it is the only private address', async () => {
    const r = await resolvePrivate('nas.lan', async () => ['2a02:8109:1234::1', 'fd00::5']);
    expect(r).toEqual({ ok: true, host: 'nas.lan', address: 'fd00::5' });
  });
  it('refuses a name whose addresses are all public', async () => {
    const r = await resolvePrivate('mixed.example', async () => ['104.21.3.4', '2a02:8109:1234::1']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not a private address');
  });
  it('treats a lookup that never settles as not resolving', async () => {
    const r = await resolvePrivate('slow', () => new Promise<string[]>(() => {}), 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('does not resolve');
  });
  it('leaves no unhandled rejection when a lookup fails after its timeout', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const r = await resolvePrivate(
      'late',
      () => new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('ENOTFOUND')), 40)),
      10,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    process.off('unhandledRejection', unhandled);
    expect(r.ok).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
  });
  it('turns a lookup rejection into a refusal', async () => {
    const r = await resolvePrivate('nope.lan', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('does not resolve');
  });
  it('skips the lookup for a literal IP', async () => {
    const lookup = async () => {
      throw new Error('should not be called');
    };
    expect(await resolvePrivate('192.168.1.5', lookup)).toEqual({ ok: true, host: '192.168.1.5', address: '192.168.1.5' });
    expect((await resolvePrivate('8.8.8.8', lookup)).ok).toBe(false);
  });
});

describe('parseSweepRange', () => {
  it('expands a /24', () => {
    const r = parseSweepRange('192.168.1.0/24');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.addresses).toHaveLength(256);
      expect(r.addresses[0]).toBe('192.168.1.0');
      expect(r.addresses[255]).toBe('192.168.1.255');
    }
  });
  it('handles a /32', () => {
    const r = parseSweepRange('10.0.0.7/32');
    expect(r).toEqual({ ok: true, addresses: ['10.0.0.7'] });
  });
  it('refuses a range wider than 256', () => {
    const r = parseSweepRange('192.168.0.0/23');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('256');
  });
  it('refuses public ranges', () => {
    const r = parseSweepRange('8.8.8.0/24');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('private');
  });
  it('refuses IPv6', () => {
    const r = parseSweepRange('fd00::/120');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('IPv4');
  });
  it('refuses garbage', () => {
    expect(parseSweepRange('garbage').ok).toBe(false);
    expect(parseSweepRange('192.168.1.0/abc').ok).toBe(false);
  });
});

describe('defaultSweepRange', () => {
  it('gives the /24 of a private IPv4', () => {
    expect(defaultSweepRange('192.168.1.10')).toBe('192.168.1.0/24');
  });
  it('gives nothing for IPv6 or public', () => {
    expect(defaultSweepRange('fd00::5')).toBeUndefined();
    expect(defaultSweepRange('8.8.8.8')).toBeUndefined();
  });
});
