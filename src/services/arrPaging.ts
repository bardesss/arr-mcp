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

/**
 * Every record from a paged Radarr/Sonarr endpoint.
 *
 * `stopWhen`, when given, is an *additional* reason to stop — never a
 * replacement for the guards below. It is checked against each page's own
 * records, after that page has already been kept, so a caller opting in
 * (e.g. `readArrHistory`'s `since`) can end a walk early once it knows every
 * later page is out of range, without changing behaviour for anyone who
 * does not pass one.
 */
export async function pageArr<Raw>(
    http: ServiceHttp,
    path: string,
    query?: string,
    stopWhen?: (records: Raw[]) => boolean
): Promise<Raw[]> {
    const extra = query === undefined || query === '' ? '' : `&${query}`;
    const records: Raw[] = [];

    for (let page = 1; ; page++) {
        const body = await http.get<Page<Raw>>(`${path}?page=${page}&pageSize=${ARR_PAGE_SIZE}${extra}`);
        const got = body.records ?? [];
        records.push(...got);
        // An empty page ends it whatever the count says: a service that
        // disagrees with its own `totalRecords` must not spin here.
        if (got.length === 0 || body.totalRecords === undefined || records.length >= body.totalRecords) break;
        if (stopWhen?.(got) === true) break;
    }

    return records;
}
