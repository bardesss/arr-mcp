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

/** Every record from a paged Radarr/Sonarr endpoint. */
export async function pageArr<Raw>(http: ServiceHttp, path: string, query?: string): Promise<Raw[]> {
    const extra = query === undefined || query === '' ? '' : `&${query}`;
    const records: Raw[] = [];

    for (let page = 1; ; page++) {
        const body = await http.get<Page<Raw>>(`${path}?page=${page}&pageSize=${ARR_PAGE_SIZE}${extra}`);
        const got = body.records ?? [];
        records.push(...got);
        // An empty page ends it whatever the count says: a service that
        // disagrees with its own `totalRecords` must not spin here.
        if (got.length === 0 || body.totalRecords === undefined || records.length >= body.totalRecords) break;
    }

    return records;
}
