import { timingSafeEqual } from 'node:crypto';

/**
 * What credential a request to `/mcp` presented, and through which channel.
 *
 * `queryOffered` is what lets the refusal name the flag when someone put a
 * token in the URL against a config that does not accept one — without it, the
 * two ways to arrive unauthenticated are indistinguishable.
 */
export type Presented = { via: 'header' | 'query'; token: string } | { via: 'none'; queryOffered: boolean };

/** Constant-time compare that does not reveal the expected length by timing. */
export function tokenMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
        // Burn an equivalent comparison so a wrong-length token is not
        // distinguishable from a wrong-bytes one.
        timingSafeEqual(b, b);
        return false;
    }
    return timingSafeEqual(a, b);
}

/**
 * A bearer header is decisive, right or wrong. A misconfigured client should
 * fail rather than silently fall back to the weaker channel.
 */
export function presentedToken(url: string, header: string | undefined, allowQuery: boolean): Presented {
    const [scheme, value] = (header ?? '').split(' ');
    if (scheme === 'Bearer' && value !== undefined && value !== '') return { via: 'header', token: value };

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
