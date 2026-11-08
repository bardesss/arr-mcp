import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { listInstances } from '../config/instances.ts';
import { MULTI_INSTANCE, type Config } from '../config/schema.ts';
import type { Found } from './probe.ts';

export type ResultRow = Found & {
    /** The same service reached a second way, when both ways agree on its version. */
    alsoAt?: string;
    status: 'new' | 'added' | 'configured' | 'maybe-second';
    existingUrl?: string;
};

/**
 * Turns a url into `scheme//address:port`, so `http://radarr:7878` and
 * `http://172.18.0.5:7878` compare equal when the name resolves to the address.
 * A name that does not resolve is compared as written.
 */
export function urlResolver(lookup?: (host: string) => Promise<string[]>): (url: string) => Promise<string> {
    return async url => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return url;
        }
        let host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (isIP(host) === 0) {
            try {
                const addresses = lookup ? await lookup(host) : (await dnsLookup(host, { all: true })).map(a => a.address);
                if (addresses[0] !== undefined) host = addresses[0];
            } catch {
                // keep the name
            }
        }
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        return `${parsed.protocol}//${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    };
}

const isHostAndContainer = (a: Found, b: Found): boolean =>
    (a.source === 'host' && b.source === 'container') || (a.source === 'container' && b.source === 'host');

export async function matchResults(
    found: readonly Found[],
    config: Config,
    resolve: (url: string) => Promise<string> = urlResolver()
): Promise<ResultRow[]> {
    const configured = await Promise.all(
        listInstances(config).map(async i => ({ type: i.type, url: i.config.url, normalized: await resolve(i.config.url) }))
    );

    // One row for a service seen both by the host and by its container name,
    // provided both report the same version. The host url stays the main one.
    const merged: { found: Found; alsoAt?: string }[] = [];
    for (const f of found) {
        const twin = merged.find(m => m.found.type === f.type && m.found.version === f.version && isHostAndContainer(m.found, f));
        if (!twin) {
            merged.push({ found: f });
        } else if (twin.found.source === 'host') {
            twin.alsoAt = f.url;
        } else {
            twin.alsoAt = twin.found.url;
            twin.found = f;
        }
    }

    const rows: ResultRow[] = [];
    for (const { found: f, alsoAt } of merged) {
        const normalized = await resolve(f.url);
        const same = configured.filter(c => c.type === f.type);
        const row: ResultRow = { ...f, status: 'new' };
        if (alsoAt !== undefined) row.alsoAt = alsoAt;
        if (same.some(c => c.normalized === normalized)) {
            row.status = 'added';
        } else if (same.length > 0) {
            row.status = MULTI_INSTANCE.includes(f.type) ? 'maybe-second' : 'configured';
            row.existingUrl = same[0]!.url;
        }
        rows.push(row);
    }
    return rows;
}
