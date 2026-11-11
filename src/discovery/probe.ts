import type { ServiceId } from '../config/schema.ts';
import type { CatalogEntry, ProbeResponse } from './catalog.ts';

export type Found = {
    type: ServiceId;
    url: string;
    version?: string;
    source: 'host' | 'container' | 'sweep';
    /** The address the probe connected to, when that was not the url's host; used only to match finds. */
    address?: string;
};

export type ProbeOpts = {
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    /** Where to connect when it differs from `host`; the reported url still names `host`. */
    address?: string;
};

const MAX_BODY = 64 * 1024;

const authority = (host: string, port: number): string => `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;

/**
 * One keyless GET. Redirects are handed back as they are, never followed, and
 * the body stops at 64 KiB. Any failure resolves to undefined.
 */
async function fetchOnce(target: string, path: string, opts: ProbeOpts): Promise<ProbeResponse | undefined> {
    try {
        const res = await (opts.fetchImpl ?? fetch)(`http://${target}${path}`, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(opts.timeoutMs)
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
        });
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
        if (reader) {
            while (size < MAX_BODY) {
                const { done, value } = await reader.read();
                if (done) break;
                const take = value.length > MAX_BODY - size ? value.subarray(0, MAX_BODY - size) : value;
                chunks.push(take);
                size += take.length;
            }
            await reader.cancel().catch(() => {});
        }
        return { status: res.status, headers, body: Buffer.concat(chunks).toString('utf8') };
    } catch {
        return undefined;
    }
}

function match(host: string, entry: CatalogEntry, source: Found['source'], r: ProbeResponse, address: string | undefined): Found | undefined {
    const hit = entry.identify(r);
    if (hit === undefined) return undefined;
    const found: Found = { type: entry.type, url: `http://${authority(host, entry.port)}`, source };
    if (hit.version !== undefined) found.version = hit.version;
    if (address !== undefined && address !== host) found.address = address;
    return found;
}

/** Fetches each distinct (port, path) once and offers that one response to every entry sharing it. */
export async function probeHost(host: string, entries: readonly CatalogEntry[], source: Found['source'], opts: ProbeOpts): Promise<Found[]> {
    const groups = new Map<string, CatalogEntry[]>();
    for (const e of entries) {
        const key = `${e.port}${e.path}`;
        const g = groups.get(key);
        if (g) g.push(e);
        else groups.set(key, [e]);
    }
    const perGroup = await Promise.all(
        [...groups.values()].map(async group => {
            const first = group[0]!;
            const r = await fetchOnce(authority(opts.address ?? host, first.port), first.path, opts);
            if (r === undefined) return [];
            return group.flatMap(e => match(host, e, source, r, opts.address) ?? []);
        })
    );
    return perGroup.flat();
}
