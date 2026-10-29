import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isMultiInstance, listInstances } from '../config/instances.ts';
import type { Config } from '../config/schema.ts';
import { LOOKUP_TIMEOUT_MS, lookupWithin, pickPrivate, type LookupGate } from './addresses.ts';
import type { Found } from './probe.ts';

export type ResultRow = Omit<Found, 'address'> & {
    /** The same service reached a second way, when both ways agree on its version or address. */
    alsoAt?: string;
    status: 'new' | 'added' | 'configured' | 'maybe-second';
    existingUrl?: string;
    /**
     * The configured instance an `added` row is, whose own adapter can read its
     * version. A `configured` row may be another server, so it names none.
     */
    instanceId?: string;
};

const defaultLookup = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map(a => a.address);

/**
 * Turns a url into `scheme//address:port`, so `http://radarr:7878` and
 * `http://172.18.0.5:7878` compare equal when the name resolves to the address.
 * A name that does not resolve is compared as written.
 */
export function urlResolver(
    lookup: (host: string) => Promise<string[]> = defaultLookup,
    timeoutMs: number = LOOKUP_TIMEOUT_MS,
    gate?: LookupGate
): (url: string) => Promise<string> {
    return async url => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return url;
        }
        let host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (isIP(host) === 0) {
            // A name that does not resolve in time is kept as written. Among its
            // answers, the one a probe connects to (`resolvePrivate`), so an
            // IPv6-first or public-first name still matches a sweep of its address.
            const addresses = await lookupWithin(host, lookup, timeoutMs, gate);
            const chosen = addresses === undefined ? undefined : (pickPrivate(addresses) ?? addresses[0]);
            if (chosen !== undefined) host = chosen;
        }
        return normalizedAt(parsed, host);
    };
}

const normalizedAt = (parsed: URL, host: string): string => {
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
};

/** A find's url at the address its probe connected to, when it recorded one. */
function findAt(f: Found, resolve: (url: string) => Promise<string>): Promise<string> {
    if (f.address === undefined) return resolve(f.url);
    try {
        return Promise.resolve(normalizedAt(new URL(f.url), f.address));
    } catch {
        return resolve(f.url);
    }
}

/** A url's port, the scheme's default when it names none; undefined for a url that does not parse. */
const portOf = (url: string): string | undefined => {
    try {
        const u = new URL(url);
        return u.port || (u.protocol === 'https:' ? '443' : '80');
    } catch {
        return undefined;
    }
};

/** A url compared as written, give or take a trailing slash and the case of its letters. */
const asWritten = (url: string): string => url.replace(/\/+$/, '').toLowerCase();

const isHostAndContainer = (a: Found, b: Found): boolean =>
    (a.source === 'host' && b.source === 'container') || (a.source === 'container' && b.source === 'host');

export async function matchResults(
    found: readonly Found[],
    config: Config,
    resolve: (url: string) => Promise<string> = urlResolver()
): Promise<ResultRow[]> {
    const configured = await Promise.all(
        listInstances(config).map(async i => ({ id: i.id, type: i.type, url: i.config.url, normalized: await resolve(i.config.url) }))
    );

    /**
     * The configured instance a find is, by address or by its url as written:
     * a configured name whose lookup failed stays as written, while the find
     * carries the address it was probed at.
     */
    const instanceOf = (type: Found['type'], pairs: readonly { url: string; normalized: string }[]) =>
        configured.find(
            c => c.type === type && pairs.some(p => c.normalized === p.normalized || asWritten(c.url) === asWritten(p.url))
        );

    // Every found url is resolved once, up front.
    const at = await Promise.all(found.map(f => findAt(f, resolve)));

    // One row for a service seen both by the host and by its container name,
    // when there is evidence it is one service: both report the same version,
    // or both urls resolve to the same address. Two finds with no version and
    // different addresses stay two rows. The host url stays the main one.
    // A sweep hit on an address a host or container find already resolves to
    // is that same service again, not a second one: it adds no row, and a
    // sweep row gives way to a host or container find of the same address.
    const merged: { found: Found; normalized: string; alsoAt?: string; alsoNormalized?: string }[] = [];
    found.forEach((f, i) => {
        const normalized = at[i]!;
        const sameAddress = merged.find(
            m =>
                m.found.type === f.type &&
                (m.found.source === 'sweep' || f.source === 'sweep') &&
                (m.normalized === normalized || m.alsoNormalized === normalized)
        );
        if (sameAddress !== undefined) {
            if (sameAddress.found.source === 'sweep' && f.source !== 'sweep') {
                sameAddress.found = f;
                sameAddress.normalized = normalized;
            }
            return;
        }
        const twin = merged.find(m => {
            if (m.found.type !== f.type || !isHostAndContainer(m.found, f)) return false;
            if ((m.found.version !== undefined && m.found.version === f.version) || m.normalized === normalized) return true;
            // With no version to compare (an *arr says none without a key), the
            // same port and a host find that is a configured instance are enough:
            // the container name is that instance reached from inside Docker.
            // A version on either side is evidence of its own, and two finds
            // that disagree on it are two servers.
            if (m.found.version !== undefined || f.version !== undefined) return false;
            const host = m.found.source === 'host' ? { url: m.found.url, normalized: m.normalized } : { url: f.url, normalized };
            return portOf(m.found.url) === portOf(f.url) && instanceOf(f.type, [host]) !== undefined;
        });
        if (!twin) {
            merged.push({ found: f, normalized });
        } else if (twin.found.source === 'host') {
            twin.alsoAt = f.url;
            twin.alsoNormalized = normalized;
        } else {
            twin.alsoAt = twin.found.url;
            twin.alsoNormalized = twin.normalized;
            twin.found = f;
            twin.normalized = normalized;
        }
    });

    const rows: ResultRow[] = [];
    for (const { found: f, normalized, alsoAt, alsoNormalized } of merged) {
        const same = configured.filter(c => c.type === f.type);
        // The probed address only serves the match; the row shows the url.
        const { address, ...shown } = f;
        const row: ResultRow = { ...shown, status: 'new' };
        if (alsoAt !== undefined) row.alsoAt = alsoAt;
        const pairs = [
            { url: f.url, normalized },
            ...(alsoAt === undefined || alsoNormalized === undefined ? [] : [{ url: alsoAt, normalized: alsoNormalized }])
        ];
        const instance = instanceOf(f.type, pairs);
        if (instance !== undefined) {
            row.status = 'added';
            row.instanceId = instance.id;
        } else if (same.length > 0) {
            row.status = isMultiInstance(f.type) ? 'maybe-second' : 'configured';
            row.existingUrl = same[0]!.url;
        }
        rows.push(row);
    }
    return rows;
}
