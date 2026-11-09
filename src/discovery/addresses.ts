import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { TIMED_OUT, withTimeout } from '../core/timeout.ts';

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
 * How long one name lookup may take, counted from the moment it gets a slot,
 * before it counts as not resolving. A bare container name that does not exist
 * takes seconds to fail, and lookups share libuv's four threads.
 */
export const LOOKUP_TIMEOUT_MS = 1000;

/** How many name lookups may be in flight at once, leaving libuv's pool a thread for other work. */
export const LOOKUP_CONCURRENCY = 3;

export type LookupGate = { acquire(): Promise<() => void> };

/** A counting gate: `acquire` waits for a free slot and resolves with a one-shot release. */
export function lookupGate(max: number = LOOKUP_CONCURRENCY): LookupGate {
  let active = 0;
  const waiting: Array<() => void> = [];
  const grant = (): (() => void) => {
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      waiting.shift()?.();
    };
  };
  return {
    acquire: () =>
      active < max
        ? Promise.resolve(grant())
        : new Promise<() => void>((resolve) => {
            waiting.push(() => resolve(grant()));
          }),
  };
}

/**
 * The lookup's answer, or undefined when it fails or outlasts `timeoutMs`. The
 * timeout starts when the lookup does, after it has a slot from `gate`. A slot
 * is held until the lookup itself settles, even past its timeout, so lookups
 * that time out cannot pile up in the thread pool. A lookup that loses the race
 * is left to settle on its own, with its rejection handled.
 */
export async function lookupWithin(
  host: string,
  lookup: (h: string) => Promise<string[]>,
  timeoutMs: number,
  gate?: LookupGate,
): Promise<string[] | undefined> {
  const release = gate === undefined ? undefined : await gate.acquire();
  // Started inside a promise so a lookup that throws outright counts as a failure too.
  const answer = Promise.resolve()
    .then(() => lookup(host))
    .then(
      (addresses) => addresses,
      () => undefined,
    );
  if (release !== undefined) void answer.finally(release);
  const out = await withTimeout(answer, timeoutMs);
  return out === TIMED_OUT ? undefined : out;
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
  gate?: LookupGate,
): Promise<HostOutcome> {
  const addresses = isIP(host) ? [host] : await lookupWithin(host, lookup, timeoutMs, gate);
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
