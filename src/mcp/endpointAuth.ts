/** What a request to `/mcp` presented, and how — `queryOffered` says whether a
 *  query token showed up even when unhonoured, so a refusal can name the flag. */
export type Presented = { via: 'header' | 'query'; token: string } | { via: 'none'; queryOffered: boolean };

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
