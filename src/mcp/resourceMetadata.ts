import {
    buildOAuthProtectedResourceMetadata,
    getOAuthProtectedResourceMetadataUrl,
    type OAuthProtectedResourceMetadata
} from '@modelcontextprotocol/server';
import type { OAuthConfig } from '../config/schema.ts';
import { mcpEndpoint } from '../web/origin.ts';

/**
 * Both forms, because clients disagree about which to fetch: RFC 9728 derives
 * the path-suffixed one from the endpoint URL, and some clients probe the bare
 * origin form instead. They serve the same document.
 *
 * Both also answer with `resource: <scheme>://<host>/mcp` rather than one
 * bare-origin path answering with the bare origin — RFC 9728 §3.1 pairs the
 * bare-origin route with a bare-origin identifier, but every MCP client
 * derives the path-suffixed form (§3.3), so this is a deliberate compatibility
 * shim for the bare-origin probers, not a defect to "fix" into two documents.
 *
 * The second entry hardcodes `/mcp`, which `mcpEndpoint` (src/web/origin.ts)
 * also hardcodes — two places that would silently desync if the endpoint
 * path ever moved. Not worth deriving today: `src/app.ts` hardcodes `/mcp` a
 * third time for the route itself.
 */
export const RESOURCE_METADATA_PATHS = [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp'
] as const;

/**
 * The resource identifier is the address the client actually reached us on,
 * which is the one thing the server knows better than any setting would.
 *
 * Built through `mcpEndpoint` rather than from `Host` directly, and that reuse
 * is the point: `Host` is caller-supplied and Node's HTTP parser forwards
 * bytes that are legal in a header but illegal in a URL host, so the
 * validation `allowed_hosts` already depends on is the validation this needs.
 * `undefined` means the Host was not usable — the route answers 404 rather
 * than advertising a fabricated address.
 */
export function resourceMetadataUrl(requestUrl: string, proto: string | undefined): string | undefined {
    const endpoint = mcpEndpoint(requestUrl, proto);
    return endpoint === undefined ? undefined : getOAuthProtectedResourceMetadataUrl(new URL(endpoint));
}

export function resourceMetadata(
    oauth: OAuthConfig,
    requestUrl: string,
    proto: string | undefined
): OAuthProtectedResourceMetadata | undefined {
    const endpoint = mcpEndpoint(requestUrl, proto);
    if (endpoint === undefined) return undefined;

    // Reads only `oauthMetadata.issuer`, and validates it on the way past.
    // The SDK's `oauthMetadataResponse` is deliberately not used: it also
    // answers /.well-known/oauth-authorization-server with whatever is passed
    // here, and there is no OIDC discovery in this version, so there is no
    // authorization-server document to serve that would not be invented.
    return buildOAuthProtectedResourceMetadata({
        oauthMetadata: { issuer: oauth.issuer } as Parameters<typeof buildOAuthProtectedResourceMetadata>[0]['oauthMetadata'],
        resourceServerUrl: new URL(endpoint),
        resourceName: 'arr-mcp',
        scopesSupported: [oauth.scopes.read, oauth.scopes.write, oauth.scopes.destructive]
    });
}
