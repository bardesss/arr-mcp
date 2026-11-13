import { BlockList, isIP } from 'node:net';

/**
 * `auth.trusted_proxies`: the peers allowed to say who they forwarded a request
 * for. Anyone can send `X-Forwarded-For` or `Forwarded`, so the headers mean
 * something only when the socket they arrived on belongs to a proxy the
 * operator named.
 */

/** An address, or an address and prefix length such as `172.18.0.0/16`. */
export function isAddressOrCidr(entry: string): boolean {
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    if (family === 0) return false;
    if (slash === -1) return true;
    const prefix = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefix)) return false;
    return Number(prefix) <= (family === 4 ? 32 : 128);
}

/** Built once per list: the runtime swaps in a new array on every reload. */
const lists = new WeakMap<readonly string[], BlockList>();

function blockListOf(entries: readonly string[]): BlockList {
    let list = lists.get(entries);
    if (list !== undefined) return list;
    list = new BlockList();
    for (const entry of entries) {
        const [address = '', prefix] = entry.split('/');
        const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
        if (prefix === undefined) list.addAddress(address, type);
        else list.addSubnet(address, Number(prefix), type);
    }
    lists.set(entries, list);
    return list;
}

/** `[::1]:443` and `10.0.0.9:51234` as their bare addresses. */
const bare = (hop: string): string => {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(hop);
    if (bracketed !== null) return bracketed[1] ?? hop;
    const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(hop);
    return v4 === null ? hop : (v4[1] ?? hop);
};

export function isTrustedProxy(address: string, entries: readonly string[]): boolean {
    if (entries.length === 0) return false;
    const family = isIP(address);
    if (family === 0) return false;
    return blockListOf(entries).check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** One element of an RFC 7239 `Forwarded` header: the parameters read here. */
interface ForwardedElement {
    for?: string;
    proto?: string;
}

/**
 * `Forwarded: for=192.0.2.1;proto=https, for="[2001:db8::1]:443"` as its
 * elements, left to right. A quoted value may hold a comma or a semicolon, so
 * this walks the string rather than splitting it.
 */
export function forwardedElements(header: string): ForwardedElement[] {
    const elements: ForwardedElement[] = [];
    let current: ForwardedElement = {};
    let pair = '';
    let quoted = false;
    const endPair = (): void => {
        const eq = pair.indexOf('=');
        if (eq > 0) {
            const key = pair.slice(0, eq).trim().toLowerCase();
            let value = pair.slice(eq + 1).trim();
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
            if (key === 'for' || key === 'proto') current[key] = value;
        }
        pair = '';
    };
    for (let i = 0; i < header.length; i++) {
        const ch = header[i] ?? '';
        if (quoted) {
            pair += ch;
            if (ch === '\\') pair += header[++i] ?? '';
            else if (ch === '"') quoted = false;
        } else if (ch === '"') {
            quoted = true;
            pair += ch;
        } else if (ch === ';') {
            endPair();
        } else if (ch === ',') {
            endPair();
            elements.push(current);
            current = {};
        } else {
            pair += ch;
        }
    }
    endPair();
    elements.push(current);
    return elements;
}

/**
 * The element describing the client: the nearest one, read from the right,
 * whose `for` is not itself a trusted proxy. Each proxy appends what it saw;
 * everything to the left of that the client could have written itself.
 */
function clientElement(elements: readonly ForwardedElement[], entries: readonly string[]): ForwardedElement | undefined {
    for (let i = elements.length - 1; i >= 0; i--) {
        const element = elements[i];
        if (element === undefined || element.for === '') continue;
        if (element.for === undefined || !isTrustedProxy(bare(element.for), entries)) return element;
    }
    return undefined;
}

/**
 * Who a request came from: the peer, unless the peer is a trusted proxy, in
 * which case the nearest forwarded hop that is not itself one.
 * `X-Forwarded-For` wins when both headers arrive: nginx and Traefik append to
 * it but pass `Forwarded` through as the client wrote it.
 */
export function clientAddress(
    peer: string,
    forwardedFor: string | undefined,
    entries: readonly string[],
    forwarded?: string
): string {
    if (!isTrustedProxy(peer, entries)) return peer;
    const hops =
        forwardedFor !== undefined
            ? forwardedFor.split(',').map(h => ({ for: h.trim() }))
            : forwarded === undefined
              ? []
              : forwardedElements(forwarded);
    const hop = clientElement(hops, entries)?.for;
    return hop === undefined ? peer : bare(hop);
}

/**
 * The forwarded scheme to believe, in `X-Forwarded-Proto` form. With no
 * trusted proxies set, `X-Forwarded-Proto` is taken from any peer, as it was
 * before the list existed, so an install behind a TLS proxy keeps its Secure
 * cookie and https OAuth metadata URL without the setting. Once the list is
 * set, only those peers are believed, and `Forwarded`'s `proto` is read when
 * `X-Forwarded-Proto` is absent.
 */
export function forwardedProto(
    peer: string,
    xForwardedProto: string | undefined,
    forwarded: string | undefined,
    entries: readonly string[]
): string | undefined {
    if (entries.length === 0) return xForwardedProto;
    if (!isTrustedProxy(peer, entries)) return undefined;
    if (xForwardedProto !== undefined) return xForwardedProto;
    return forwarded === undefined ? undefined : clientElement(forwardedElements(forwarded), entries)?.proto;
}
