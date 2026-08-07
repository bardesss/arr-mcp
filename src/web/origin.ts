/**
 * The absolute MCP endpoint, derived from the request that asked for the page.
 *
 * The dashboard used to print the relative path `/mcp` and leave the reader to
 * assemble the rest, which is the one thing the server is better placed to do
 * than they are: the request URL *is* the address the browser reached us on,
 * port included, so it is right without a setting to configure and right behind
 * a reverse proxy for free.
 *
 * Strings rather than a Hono `Context` on purpose — this is a parsing rule, and
 * a parsing rule should be testable without standing up a server.
 *
 * The host is taken from the request URL rather than from `c.req.header('host')`
 * because that is the one source present in both places it has to work: the
 * node adapter builds the URL out of the `Host` header, so the two agree on a
 * real server, but a `Request` constructed in a test carries no `Host` header at
 * all and the header read is simply `undefined`. Reading the URL means the code
 * under test is the code that ships.
 */

/**
 * Hostname, IPv4, or bracketed IPv6, each optionally with a port. Anything else
 * is refused rather than interpolated: `Host` is caller-supplied, and the result
 * is rendered into a page and copied into a client config. A value carrying a
 * space, a slash or a quote has no legitimate reading, so it does not get one.
 */
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

/**
 * `X-Forwarded-Proto` is the only forwarded header read here, and only because
 * omitting it breaks the TLS-terminating-proxy case outright — the page would
 * hand out an `http://` URL that cannot work.
 *
 * `X-Forwarded-Host` is deliberately not read. nginx, Caddy and Traefik all pass
 * the external `Host` through by default, so it buys nothing in the common case
 * and would take a rendered string from a second header anyone can set.
 *
 * Note that when `auth.allowed_hosts` is non-empty, an unlisted `Host` is
 * already rejected in `app.ts` before any UI route runs — so a pinned instance
 * only ever renders a host that passed validation. Pinning it is the answer for
 * anyone reachable off a trusted LAN.
 *
 * Returns `undefined` when there is no usable `Host`, which the dashboard shows
 * as the old relative-path prose. A fabricated URL would be worse than the
 * sentence it replaces.
 */
export function mcpEndpoint(requestUrl: string, proto: string | undefined): string | undefined {
    let host: string;
    try {
        host = new URL(requestUrl).host;
    } catch {
        return undefined;
    }
    if (!HOST.test(host)) return undefined;

    // Chained proxies append rather than replace, so this arrives as
    // `https, http` and only the first hop describes what the browser spoke.
    const first = (proto ?? '').split(',')[0]?.trim().toLowerCase();
    const scheme = first === 'https' ? 'https' : 'http';

    return `${scheme}://${host}/mcp`;
}
