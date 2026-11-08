import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Private IPv4 (RFC 1918 plus CGNAT, which Tailscale and many ISPs use) and IPv6 unique-local.
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE.check(ip, 'ipv4');
  if (family === 6) {
    // An IPv4-mapped address is as private as the IPv4 address inside it.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped?.[1]) return PRIVATE.check(mapped[1], 'ipv4');
    return PRIVATE.check(ip, 'ipv6');
  }
  return false;
}

export type HostOutcome =
  | { ok: true; host: string; address: string }
  | { ok: false; host: string; reason: string };

async function defaultLookup(host: string): Promise<string[]> {
  const found = await dnsLookup(host, { all: true });
  return found.map((f) => f.address);
}

/**
 * How long a name lookup may take before it counts as not resolving. A bare
 * container name that does not exist takes seconds to fail, and lookups share
 * libuv's four threads, so without a cap one quick search queues behind them.
 */
export const LOOKUP_TIMEOUT_MS = 1000;

/**
 * The lookup's answer, or undefined when it fails or outlasts `timeoutMs`. A
 * lookup that loses the race is left to settle on its own, with its rejection
 * handled, so a late failure is never an unhandled rejection.
 */
export async function lookupWithin(
  host: string,
  lookup: (h: string) => Promise<string[]>,
  timeoutMs: number,
): Promise<string[] | undefined> {
  let timer: NodeJS.Timeout | undefined;
  // Started inside a promise so a lookup that throws outright counts as a failure too.
  const answer = Promise.resolve()
    .then(() => lookup(host))
    .then(
      (addresses) => addresses,
      () => undefined,
    );
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A host is probed only at a private address. A name that resolves to a
 * private address and a public one as well (a router with a private A record
 * and a global AAAA record) is accepted, and the probe is pinned to the
 * private address, preferring IPv4: a unique-local IPv6 listed first may not
 * be reachable from a Docker bridge.
 */
export async function resolvePrivate(
  host: string,
  lookup: (h: string) => Promise<string[]> = defaultLookup,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<HostOutcome> {
  const addresses = isIP(host) ? [host] : await lookupWithin(host, lookup, timeoutMs);
  if (addresses === undefined || addresses.length === 0) return { ok: false, host, reason: `${host} does not resolve` };
  const usable = addresses.filter((a) => isPrivateAddress(a));
  const chosen = usable.find((a) => isIP(a) === 4) ?? usable[0];
  if (chosen === undefined) {
    return { ok: false, host, reason: `${host} resolves to ${addresses[0] ?? host}, which is not a private address` };
  }
  return { ok: true, host, address: chosen };
}

export function requestHost(hostHeader: string | undefined): string | undefined {
  const raw = hostHeader?.trim();
  if (!raw) return undefined;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 1 ? raw.slice(1, end) : undefined;
  }
  // A bare IPv6 literal has several colons and no port.
  if (isIP(raw) === 6) return raw;
  const host = raw.replace(/:\d*$/, '');
  return host || undefined;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function parseSweepRange(
  input: string,
): { ok: true; addresses: string[] } | { ok: false; reason: string } {
  const text = input.trim();
  const match = /^([^/]+)\/(\d+)$/.exec(text);
  if (!match) return { ok: false, reason: 'Enter a range like 192.168.1.0/24' };
  const base = match[1] ?? '';
  const bitsText = match[2] ?? '';
  if (isIP(base) === 6) return { ok: false, reason: 'Only IPv4 ranges can be swept' };
  if (isIP(base) !== 4) return { ok: false, reason: 'Enter a range like 192.168.1.0/24' };
  const bits = Number(bitsText);
  if (bits < 24 || bits > 32) {
    return { ok: false, reason: 'A sweep covers at most 256 addresses, so use /24 to /32' };
  }
  if (!isPrivateAddress(base)) return { ok: false, reason: `${base} is not a private address` };
  const size = 2 ** (32 - bits);
  const start = Math.floor(ipv4ToInt(base) / size) * size;
  const addresses = Array.from({ length: size }, (_, i) => intToIpv4(start + i));
  return { ok: true, addresses };
}

export function defaultSweepRange(address: string): string | undefined {
  if (isIP(address) !== 4 || !isPrivateAddress(address)) return undefined;
  return `${address.split('.').slice(0, 3).join('.')}.0/24`;
}
