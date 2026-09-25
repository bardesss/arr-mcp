import type { ServiceHttp } from '../core/http.ts';

/**
 * Sent explicitly because Radarr and Sonarr default `pageSize` to 10. Asking
 * for none meant a household with more than ten records was told ten was the
 * whole list, and nothing could report the truncation.
 *
 * Paged to completion rather than raised to one large number, because a bigger
 * silent cap is the same defect with a longer fuse.
 */
export const ARR_PAGE_SIZE = 200;

type Page<Raw> = { records?: Raw[]; totalRecords?: number };

/** What one walk read, and the service's own count of the whole list. */
export type ArrRead<Raw> = { records: Raw[]; totalRecords: number | undefined };

/**
 * Records from a paged Radarr/Sonarr endpoint, to completion unless `stopWhen`
 * ends it sooner.
 *
 * `stopWhen` is an *additional* reason to stop, never a replacement for the
 * guards below. It sees each page after that page is kept, plus how many
 * records are kept so far, so a caller can stop once it has enough (#293) or
 * once every later page is out of range (`since`).
 */
export async function readArrPages<Raw>(
    http: ServiceHttp,
    path: string,
    query?: string,
    opts: { pageSize?: number; stopWhen?: (page: Raw[], kept: number) => boolean } = {}
): Promise<ArrRead<Raw>> {
    const extra = query === undefined || query === '' ? '' : `&${query}`;
    const pageSize = opts.pageSize ?? ARR_PAGE_SIZE;
    const records: Raw[] = [];
    let totalRecords: number | undefined;

    for (let page = 1; ; page++) {
        const body = await http.get<Page<Raw>>(`${path}?page=${page}&pageSize=${pageSize}${extra}`);
        const got = body.records ?? [];
        records.push(...got);
        totalRecords = body.totalRecords;
        // An empty page ends it whatever the count says: a service that
        // disagrees with its own `totalRecords` must not spin here.
        if (got.length === 0 || body.totalRecords === undefined || records.length >= body.totalRecords) break;
        if (opts.stopWhen?.(got, records.length) === true) break;
    }

    return { records, totalRecords };
}

/** Every record from a paged Radarr/Sonarr endpoint. */
export async function pageArr<Raw>(
    http: ServiceHttp,
    path: string,
    query?: string,
    stopWhen?: (records: Raw[]) => boolean
): Promise<Raw[]> {
    return (await readArrPages<Raw>(http, path, query, stopWhen === undefined ? {} : { stopWhen })).records;
}

/** A page just big enough for `want` rows, so `limit: 10` is not 200 records. */
export const pageSizeFor = (want: number): number => Math.min(ARR_PAGE_SIZE, Math.max(1, Math.trunc(want)));

/**
 * The size of the whole list, given `kept` usable rows out of what was read.
 *
 * A read that reached the end counts exactly. One that stopped early takes the
 * service's `totalRecords`, less the rows it already dropped (no id).
 */
export const readTotal = (read: ArrRead<unknown>, kept: number): number =>
    read.totalRecords !== undefined && read.records.length < read.totalRecords
        ? read.totalRecords - (read.records.length - kept)
        : kept;
