import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import {
    McpServer,
    OAuthError,
    OAuthErrorCode,
    bearerAuthChallengeResponse,
    createMcpHandler,
    verifyBearerToken,
    type AuthInfo
} from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { OAuthConfig } from './config/schema.ts';
import { NO_CLIENT_ID, OAUTH_CALLER_PREFIX, type WriteAudit } from './core/audit.ts';
import { logger } from './core/logger.ts';
import type { LogStore } from './core/logs.ts';
import type { Runtime } from './core/runtime.ts';
import { presentedToken, tokenMatches } from './mcp/endpointAuth.ts';
import { claimJsonBody } from './mcp/jsonBody.ts';
import { JwksUnavailable } from './mcp/oauthVerifier.ts';
import { acceptingBoth, acceptsStream, asPlainJson } from './mcp/plainJson.ts';
import { registerAllPrompts } from './mcp/prompts.ts';
import { registerAllResources } from './mcp/resources.ts';
import { RESOURCE_METADATA_PATHS, resourceMetadata, resourceMetadataUrl } from './mcp/resourceMetadata.ts';
import { cappedTo, tiersFor } from './mcp/scopes.ts';
import type { ServiceInstance } from './config/instances.ts';
import type { WriteTier } from './core/permissions.ts';
import { registerAllTools, type ToolContext } from './tools/register.ts';
import { originOf, registerWebRoutes } from './web/routes.ts';

const NAME = 'arr-mcp';
const VERSION = process.env.ARR_MCP_VERSION ?? '0.0.0-dev';

/**
 * A tool call is a few kilobytes and the largest legitimate body is a config
 * form. Not configurable: the only reason to raise it would be to work around
 * a problem that is never actually this.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * An hour, for every list the SDK builds itself.
 *
 * The lists are static by construction: `registerAllTools`, `registerAllPrompts`
 * and `registerAllResources` register unconditionally — nothing is filtered by
 * configuration, which is the same property that makes hiding a tool behind a
 * config key a non-option — so what a client caches for an hour cannot go
 * stale under it. Without this the SDK emits the conservative default
 * `ttlMs: 0` and every client reloads thirty-three tool descriptions every
 * session.
 *
 * `resources/read` is deliberately absent: each resource carries its own
 * `cacheHint` (`src/mcp/resources.ts`), and arr://health's is zero on purpose.
 */
const LIST_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * What the whole server is, said once.
 *
 * This is the only documentation every client reads. Prompts and resources
 * carry more, but support for both is uneven and a client that surfaces
 * neither still gets this — which is why the rules that live here are the ones
 * no single tool's description can hold: they are true *between* tools, and a
 * model that learns them from `get_library` has still not learned them for
 * `get_queue`.
 *
 * Deliberately not a tool index. `tools/list` already carries every description
 * and repeating them here would cost every session the same tokens twice; what
 * it names instead is the shape a caller cannot infer from any one of them —
 * that a list reports the whole count rather than the window, and that a write
 * happens in two calls rather than one.
 */
const INSTRUCTIONS = `One endpoint for a self-hosted media stack: Radarr and Sonarr manage films and series, Whisparr scenes, Prowlarr the indexers, Bazarr subtitles, Jellyfin playback, Seerr requests, SABnzbd, Transmission and qBittorrent downloads.

Reading:
- \`get_library\` is the join across Radarr, Sonarr, Whisparr and Jellyfin — the only tool that can say a file one service believes in is missing from the other.
- \`diagnose\` answers "why can I not play this" in one call. Prefer it over assembling that answer from several reads.
- Every list is a window: \`items\`, \`total\`, \`returned\`, \`offset\`, \`truncated\`. \`total\` counts the whole list, never the window — it is the number to report when someone asks how many. \`offset + returned < total\` means there is another page; page two of 50 is \`offset: 50\`.
- \`degraded\` names services that did not answer. A short list may be an outage rather than an answer, so say which it was.

Writing:
- Writes happen in two calls. The first previews: read \`summary\` and \`effects\`, then call again passing the returned \`confirm\` token to apply it. \`applied\` says which of the two just happened. \`dry_run: true\` previews without ever issuing a token.
- Writes take a service and an id, never a title. Get the id from \`get_library\` or \`get_media_details\` first.
- A write refused for permissions names the config key that would allow it. Report that key rather than retrying.

Arguments are strict: an argument a tool does not have is refused rather than ignored, and the error lists what it does accept.`;

/**
 * The token's ceiling, applied to the write gate and to every place that
 * reports what the gate permits.
 *
 * Everything else on the context is read-side and ungated — any of the three
 * scopes grants reads, because every write resolves its target by reading
 * first and a write-scoped token that could not read could not preview
 * anything.
 *
 * `instances` is capped as well as `write.permissions` because `stack_health`
 * and `arr://instances` report permissions from it. Left alone, they would
 * tell a read-only token it may delete what the gate then refuses.
 *
 * Fails closed. A request carrying `authInfo` got in on an OAuth token, and
 * one of those must never run uncapped. A reload between verifying the token
 * and building this context can drop `auth.oauth` or rename a scope, and the
 * worst that should cost is a spurious refusal.
 */
function cappedTools(tools: ToolContext, oauth: OAuthConfig | undefined, authInfo: AuthInfo | undefined): ToolContext {
    if (authInfo === undefined) return tools;
    const tiers = (oauth && tiersFor(oauth, authInfo.scopes)) ?? new Set<WriteTier>();
    return {
        ...tools,
        // Cast because spreading a discriminated union loses the pairing of
        // `type` and `config`; only `permissions` changes, so it still holds.
        instances: tools.instances.map(
            i =>
                ({
                    ...i,
                    config: {
                        ...i.config,
                        permissions: {
                            safe_write: i.config.permissions.safe_write && tiers.has('safe'),
                            destructive: i.config.permissions.destructive && tiers.has('destructive')
                        }
                    }
                }) as ServiceInstance
        ),
        // `caller` rides the same branch as the ceiling rather than needing its
        // own: this is the one per-request place that holds `authInfo`, and a
        // request without one is the static bearer token, which the audit
        // records under its own fixed marker.
        write: { ...tools.write, permissions: cappedTo(tools.write.permissions, tiers), caller: `${OAUTH_CALLER_PREFIX}${authInfo.clientId}` }
    };
}

export function buildApp(opts: { runtime: Runtime; audit: WriteAudit; logs: LogStore }) {
    const { runtime, audit, logs } = opts;

    // The factory runs once per request, so every call gets a fresh McpServer.
    // This is what keeps the transport stateless — do not
    // hoist the server out of the closure.
    //
    // `runtime.current` is read here, per request, rather than captured when
    // the app is built: that is what lets a config change take effect without
    // a restart. Reading it once into `snapshot` also means a call that starts
    // before a reload finishes against the configuration it began with.
    const handler = createMcpHandler(ctx => {
        const snapshot = runtime.current;
        // The ceiling is applied here rather than inside the tools because
        // this factory already runs once per request — the same property
        // that lets a config reload take effect without a restart. A request
        // with no authInfo (the static bearer token) gets the tools
        // untouched.
        const tools = cappedTools(snapshot.tools, snapshot.config.auth.oauth, ctx.authInfo);
        const server = new McpServer(
            { name: NAME, version: VERSION },
            {
                instructions: INSTRUCTIONS,
                /**
                 * Declared false rather than left to default true.
                 *
                 * `registerTool`/`registerPrompt`/`registerResource` each set
                 * `listChanged: getCapabilities().<kind>?.listChanged ?? true`,
                 * so declaring it here is what makes the answer false — and it
                 * should be. The lists are static by construction (the same
                 * property `LIST_CACHE_TTL_MS` rests on): nothing changes them,
                 * not a config reload, not the weekly IMDb refresh. A modern-era
                 * client reads these bits to decide which notifications to
                 * request on its `subscriptions/listen` filter, so advertising
                 * true means subscribing to an event that will never arrive.
                 */
                capabilities: {
                    tools: { listChanged: false },
                    prompts: { listChanged: false },
                    resources: { listChanged: false }
                },
                // A server option, not a `createMcpHandler` one — the hint
                // travels from the era-blind server configuration to the
                // era-aware encode seam, so a 2025-era response is unaffected.
                cacheHints: {
                    'tools/list': { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'private' },
                    'prompts/list': { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'private' },
                    'resources/list': { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'private' },
                    'resources/templates/list': { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'private' },
                    'server/discover': { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'private' }
                }
            }
        );
        registerAllTools(server, tools);
        // Registered beside the tools, never instead of them. Client support
        // for prompts and resources is uneven and arr-mcp has to work on all of
        // them, so a client that surfaces neither is exactly as capable as
        // before — `test/mcp.test.ts` asserts that rather than trusting it.
        registerAllPrompts(server);
        registerAllResources(server, tools);
        return server;
    });

    // We bind 0.0.0.0 because the container must be reachable across the LAN,
    // which drops the SDK's default localhost Host/Origin validation.
    //
    // `allowedHosts` is deliberately NOT passed to the adapter, even though it
    // accepts one. The adapter installs its middleware when the app is
    // constructed, which would freeze the value at build time — so pinning a
    // hostname from the config UI would silently do nothing until a restart,
    // and that is the one kind of security setting that must never appear to
    // have applied when it has not.
    //
    // Validating here instead means the list is read from the runtime on every
    // request, like the bearer token, and takes effect the moment it is saved.
    const transport = createMcpHonoApp({ host: '0.0.0.0' });

    /**
     * An outer app purely for ordering.
     *
     * The adapter installs its JSON body parser when it is constructed, so
     * anything registered on the app it returns is already behind that parser —
     * and a body it rejects never reaches a route of ours. Mounting it inside
     * an app of our own is what puts `claimJsonBody` in front of it, which is
     * the only position from which the refusal can be JSON. See `jsonBody.ts`.
     */
    const app = new Hono();
    // First, ahead of `claimJsonBody` and therefore ahead of the Host
    // allowlist and the bearer check below: both body parsers buffer the whole
    // request, so an unauthenticated peer could otherwise spend our memory.
    app.use(
        '*',
        bodyLimit({
            maxSize: MAX_BODY_BYTES,
            onError: c =>
                c.json(
                    {
                        jsonrpc: '2.0',
                        id: null,
                        error: {
                            // Invalid Request, not -32700: the body was never
                            // parsed, so calling it a parse error is wrong.
                            code: -32600,
                            message: `Request body exceeds the ${MAX_BODY_BYTES} byte limit.`
                        }
                    },
                    413
                )
        })
    );
    app.use('*', claimJsonBody);
    app.route('/', transport);

    // Ahead of the Host allowlist on purpose: the container probes
    // `localhost:${ARR_MCP_PORT}`, a name nobody pinning a proxy hostname
    // lists, so a gated `/healthz` is 403 for ever. It answers only a name and
    // a version, both already public on the login page. Nothing else is exempt.
    app.get('/healthz', c => c.json({ status: 'ok', name: NAME, version: VERSION }));

    /**
     * An empty list means "accept any Host", which is the right default for a
     * LAN container reached by IP — and the reason the adapter's own option
     * could not be used naively: it gates on `if (allowedHosts)`, and `[]` is
     * truthy, so an empty array installed validation with an empty allow-list
     * and rejected *every* request with 403. A container that rejects 100% of
     * traffic looks healthy until someone uses it.
     */
    app.use('*', async (c: Context, next) => {
        const allowed = runtime.config.auth.allowed_hosts;
        if (allowed.length === 0) return next();

        // Compared without the port: a pinned `arr.example.com` should not stop
        // working because the browser sent `arr.example.com:6060`.
        //
        // The port is stripped from the *end*, never by splitting on the first
        // colon — for `[fd00::1]:6060` that split lands inside the address and
        // yields "[", so pinning a literal IPv6 host 403'd every request,
        // including the config page that is the only way to undo the pin.
        const host = (c.req.header('host') ?? '').toLowerCase();
        const bare = host.replace(/:\d{1,5}$/, '');
        if (allowed.some(a => a.toLowerCase() === host || a.toLowerCase() === bare)) return next();

        logger.warn({ host, ...originOf(c) }, 'rejected request with an unlisted Host');
        return c.text('forbidden: Host not allowed', 403);
    });

    /**
     * RFC 9728. Present only when `auth.oauth` is configured — a server with
     * no issuer to name has nothing to say here, and a 404 is the honest
     * answer. Registered after the Host allowlist so a pinned instance can
     * only ever advertise a name that passed it.
     *
     * Permissive CORS because a browser-based client fetches this
     * cross-origin before it holds any credential; the document is public by
     * construction and names nothing an unauthenticated caller could not read
     * off the login page.
     */
    for (const path of RESOURCE_METADATA_PATHS) {
        // `app.all`, not `app.get`: a client that sets `MCP-Protocol-Version`
        // on the discovery fetch preflights it, and the browser client the
        // permissive CORS header exists for never reaches the document if
        // that preflight 404s. Mirrors the SDK's own `metadataDocumentResponse`
        // (204 for OPTIONS, 405 with `Allow` for anything but GET/HEAD), which
        // isn't reusable here directly: it comes bundled with
        // `oauthMetadataResponse`, which would also serve
        // `/.well-known/oauth-authorization-server` — the document this PR
        // deliberately doesn't fabricate.
        app.all(path, (c: Context) => {
            if (c.req.method === 'OPTIONS') {
                const requestedHeaders = c.req.header('access-control-request-headers');
                return c.body(null, 204, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    ...(requestedHeaders === undefined
                        ? {}
                        : { 'Access-Control-Allow-Headers': requestedHeaders, Vary: 'Access-Control-Request-Headers' })
                });
            }
            if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
                return c.json(
                    { error: 'method_not_allowed', detail: `${c.req.method} is not allowed for this endpoint` },
                    405,
                    { Allow: 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Origin': '*' }
                );
            }

            // Both answers above run before the `oauth` check, so an instance
            // with no issuer configured answers a preflight it will then 404.
            // Deliberate: a preflight refused at the CORS layer reaches the
            // browser client as a network error, where the 404 it is standing
            // in front of is the answer that actually says what is wrong.
            const { oauth } = runtime.config.auth;
            if (oauth === undefined) return c.notFound();

            const document = resourceMetadata(oauth, c.req.url, c.req.header('x-forwarded-proto'));
            if (document === undefined) return c.notFound();

            // HEAD reuses the GET response's headers (Content-Type,
            // Content-Length) with the body dropped, rather than hand-building
            // them, so the two can never drift apart.
            const response = c.json(document, 200, { 'Access-Control-Allow-Origin': '*' });
            return c.req.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
        });
    }

    registerWebRoutes(app, { runtime, audit, logs, version: VERSION });

    app.all('/mcp', async (c: Context) => {
        // From the runtime, not a captured value, so rotating the token or
        // flipping the flag in the config UI takes effect on the very next
        // request.
        const snapshot = runtime.current;
        const { auth } = snapshot.config;
        const presented = presentedToken(c.req.url, c.req.header('Authorization'), auth.allow_token_in_url);
        // `resource_metadata` is how a client discovers where to
        // authenticate. Omitted entirely when no issuer is configured:
        // pointing at a 404 is worse than saying nothing.
        const metadataUrl =
            auth.oauth === undefined ? undefined : resourceMetadataUrl(c.req.url, c.req.header('x-forwarded-proto'));
        // `exactOptionalPropertyTypes` refuses `resourceMetadataUrl: undefined`
        // on the SDK's own options types — the key must be absent, not present
        // with an undefined value.
        const metadataOpt = metadataUrl === undefined ? {} : { resourceMetadataUrl: metadataUrl };

        let authInfo: AuthInfo | undefined;

        // The static bearer token is checked first and always — it stays
        // first-class, not a legacy path superseded by OAuth. `tokenMatches`
        // is cheap and constant-time, and a JWT is never 64 bytes, so it
        // refuses one on length alone before any OAuth work runs.
        if (presented.via === 'none' || !tokenMatches(presented.token, auth.bearer_token)) {
            const verifier = snapshot.oauthVerifier;

            if (presented.via === 'none' || verifier === undefined) {
                // `via` is the whole diagnosis: 'none' is a client that sent no
                // credentials at all — which every MCP client does once, on the
                // 401-then-retry handshake this endpoint's WWW-Authenticate invites
                // — while 'header' or 'query' is a token that was presented and did
                // not match. Without it the two read identically in the log, and
                // "a client reconnected" is indistinguishable from "a stale token
                // is still trying".
                logger.warn(
                    {
                        path: '/mcp',
                        ...originOf(c),
                        via: presented.via,
                        ...(presented.via === 'none' ? { queryOffered: presented.queryOffered } : {})
                    },
                    'rejected unauthenticated MCP request'
                );
                const challenge =
                    metadataUrl === undefined ? 'Bearer realm="arr-mcp"' : `Bearer realm="arr-mcp", resource_metadata="${metadataUrl}"`;
                return c.json(
                    {
                        error: 'unauthorized',
                        ...(presented.via === 'none' && presented.queryOffered
                            ? {
                                  detail:
                                      'A token in the URL is refused until auth.allow_token_in_url is enabled — turn it on in the config UI, under MCP endpoint.'
                              }
                            : {})
                    },
                    401,
                    { 'WWW-Authenticate': challenge }
                );
            }

            try {
                authInfo = await verifyBearerToken(c.req.header('Authorization'), { verifier, ...metadataOpt });
            } catch (err) {
                if (err instanceof JwksUnavailable) {
                    // Not a 401: the presented token may be perfectly good and
                    // we cannot say. A 401 sends whoever is debugging after
                    // their own credential instead of the outage.
                    logger.error({ path: '/mcp', ...originOf(c), err }, 'could not fetch the issuer key set');
                    return c.json(
                        {
                            error: 'temporarily_unavailable',
                            detail: "The issuer's key set could not be fetched, so this token could not be checked. This is not a problem with your credential."
                        },
                        503
                    );
                }
                logger.warn({ path: '/mcp', ...originOf(c), via: presented.via }, 'rejected an access token');
                return bearerAuthChallengeResponse(err, metadataOpt);
            }

            // A token granted nothing here is told so, rather than quietly
            // handed the library. `requiredScopes` cannot express this: the
            // SDK requires every listed scope, and these are a union of three.
            if (auth.oauth !== undefined && tiersFor(auth.oauth, authInfo.scopes) === undefined) {
                logger.warn({ path: '/mcp', ...originOf(c), clientId: authInfo.clientId === NO_CLIENT_ID ? 'unknown' : authInfo.clientId }, 'rejected a token with no arr-mcp scope');
                return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope'), metadataOpt);
            }
        }

        // A client that never asked for a stream gets one JSON object with a
        // Content-Length rather than an SSE frame in a chunked body — and, more
        // to the point, is not refused with a 406 for saying so. See
        // `plainJson.ts`: both halves of that were how #103 started.
        // Both media types, always — the transport demands both and refuses a
        // request naming only one, which caught a client asking for JSON *and*
        // a client asking for a stream. What the caller actually wanted is
        // decided on the way out, not by whether it guessed the header.
        const streaming = acceptsStream(c.req.raw);
        // `?? undefined` because a body-less request is marked with null rather
        // than left unset — that is what makes the adapter's own parser stand
        // down. The transport must still see "no body", or a GET would be
        // answered as a malformed request instead of as the wrong method.
        const response = await handler.fetch(acceptingBoth(c.req.raw), {
            ...(authInfo === undefined ? {} : { authInfo }),
            parsedBody: c.get('parsedBody') ?? undefined
        });

        return streaming ? response : asPlainJson(response);
    });

    return app;
}
