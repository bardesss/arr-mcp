/**
 * A fake fetch that answers a path→body map and 404s everything else.
 *
 * Adapter tests assert response *mapping*. Transport behaviour — retries, the
 * circuit breaker, error classification — is covered once in test/http.test.ts
 * and must not be re-asserted per adapter.
 */
export const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const textResponse = (body: string, status = 200): Response =>
    new Response(body, { status, headers: { 'content-type': 'text/plain' } });

/** A route mapped to a bare string is served as text, not JSON — qBittorrent's
 *  `/api/v2/app/version` answers `v5.0.4`, which is not valid JSON. */
export const serving = (routes: Record<string, unknown>): typeof fetch =>
    (async (input: string | URL | Request) => {
        const raw = input instanceof Request ? input.url : String(input);
        const url = new URL(raw);
        // Query string first, so a route keyed on the full path (e.g.
        // Jellyfin's `/Items?userId=…`) matches exactly rather than only by its
        // pathname. Falling back to pathname-only keeps every route registered
        // without a query string working unchanged.
        const withQuery = `${url.pathname}${url.search}`;
        const key = withQuery in routes ? withQuery : url.pathname;
        if (!(key in routes)) return jsonResponse({ message: 'not found' }, 404);

        const matched = routes[key];
        return typeof matched === 'string' ? textResponse(matched) : jsonResponse(matched);
    }) as unknown as typeof fetch;

/** SABnzbd routes on the `mode` query parameter rather than on the path. */
export const servingModes = (byMode: Record<string, unknown>): typeof fetch =>
    (async (input: string | URL | Request) => {
        const raw = input instanceof Request ? input.url : String(input);
        const mode = new URL(raw).searchParams.get('mode') ?? '';
        if (!(mode in byMode)) return jsonResponse({ status: false, error: 'unknown mode' }, 404);
        return jsonResponse(byMode[mode]);
    }) as unknown as typeof fetch;
