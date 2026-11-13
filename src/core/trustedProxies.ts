import { BlockList, isIP } from 'node:net';

/**
 * `auth.trusted_proxies`: the peers allowed to say who they forwarded a request
 * for. Anyone can send `X-Forwarded-For`, so the header means something only
 * when the socket it arrived on belongs to a proxy the operator named.
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

/**
 * Who a request came from: the peer, unless the peer is a trusted proxy, in
 * which case the nearest `X-Forwarded-For` hop that is not itself one. Read
 * from the right, because each proxy appends the address it saw; everything
 * to the left of that the client could have written itself.
 */
export function clientAddress(peer: string, forwardedFor: string | undefined, entries: readonly string[]): string {
    if (forwardedFor === undefined || !isTrustedProxy(peer, entries)) return peer;
    const hops = forwardedFor
        .split(',')
        .map(h => bare(h.trim()))
        .filter(h => h !== '');
    for (let i = hops.length - 1; i >= 0; i--) {
        const hop = hops[i] ?? '';
        if (!isTrustedProxy(hop, entries)) return hop;
    }
    return peer;
}
