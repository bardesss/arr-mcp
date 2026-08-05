/**
 * A fake fetch that answers a path→body map and 404s everything else.
 *
 * Adapter tests assert response *mapping*. Transport behaviour — retries, the
 * circuit breaker, error classification — is covered once in test/http.test.ts
 * and must not be re-asserted per adapter.
 */
export const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const serving = (routes: Record<string, unknown>): typeof fetch =>
    (async (input: string | URL | Request) => {
        const raw = input instanceof Request ? input.url : String(input);
        const path = new URL(raw).pathname;
        if (!(path in routes)) return jsonResponse({ message: 'not found' }, 404);
        return jsonResponse(routes[path]);
    }) as unknown as typeof fetch;

/** SABnzbd routes on the `mode` query parameter rather than on the path. */
export const servingModes = (byMode: Record<string, unknown>): typeof fetch =>
    (async (input: string | URL | Request) => {
        const raw = input instanceof Request ? input.url : String(input);
        const mode = new URL(raw).searchParams.get('mode') ?? '';
        if (!(mode in byMode)) return jsonResponse({ status: false, error: 'unknown mode' }, 404);
        return jsonResponse(byMode[mode]);
    }) as unknown as typeof fetch;
