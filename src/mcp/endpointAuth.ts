import { timingSafeEqual } from 'node:crypto';

/** What a request to `/mcp` presented, and how — `queryOffered` says whether a
 *  query token showed up even when unhonoured, so a refusal can name the flag. */
export type Presented = { via: 'header' | 'query'; token: string } | { via: 'none'; queryOffered: boolean };

/** Constant-time compare; refuses a zero-length token outright rather than
 *  letting an empty presented value match an empty expected one. */
export function tokenMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length === 0 || a.length !== b.length) {
        // Burn an equivalent comparison so a wrong-length token is not
        // distinguishable from a wrong-bytes one.
        timingSafeEqual(b, b);
        return false;
    }
    return timingSafeEqual(a, b);
}

/** A Bearer header always wins, right or wrong — never falls back to the query. */
export function presentedToken(url: string, header: string | undefined, allowQuery: boolean): Presented {
    const [scheme, value] = (header ?? '').split(' ');
    if (scheme?.toLowerCase() === 'bearer') return { via: 'header', token: value ?? '' };

    const offered = queryToken(url);
    if (offered !== undefined && allowQuery) return { via: 'query', token: offered };
    return { via: 'none', queryOffered: offered !== undefined };
}

const queryToken = (url: string): string | undefined => {
    let value: string | null;
    try {
        value = new URL(url).searchParams.get('token');
    } catch {
        return undefined;
    }
    return value === null || value === '' ? undefined : value;
};
