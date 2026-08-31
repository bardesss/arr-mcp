import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { WriteAudit } from './core/audit.ts';
import { logger } from './core/logger.ts';
import type { LogStore } from './core/logs.ts';
import type { Runtime } from './core/runtime.ts';
import { presentedToken, tokenMatches } from './mcp/endpointAuth.ts';
import { claimJsonBody } from './mcp/jsonBody.ts';
import { acceptingBoth, acceptsStream, asPlainJson } from './mcp/plainJson.ts';
import { registerAllPrompts } from './mcp/prompts.ts';
import { registerAllResources } from './mcp/resources.ts';
import { registerAllTools } from './tools/register.ts';
import { registerWebRoutes } from './web/routes.ts';

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
const INSTRUCTIONS = `One endpoint for a self-hosted media stack: Radarr and Sonarr manage films and series, Prowlarr the indexers, Bazarr subtitles, Jellyfin playback, Seerr requests, SABnzbd, Transmission and qBittorrent downloads.

Reading:
- \`get_library\` is the join across Radarr, Sonarr and Jellyfin — the only tool that can say a file one service believes in is missing from the other.
- \`diagnose\` answers "why can I not play this" in one call. Prefer it over assembling that answer from several reads.
- Every list is a window: \`items\`, \`total\`, \`returned\`, \`offset\`, \`truncated\`. \`total\` counts the whole list, never the window — it is the number to report when someone asks how many. \`offset + returned < total\` means there is another page; page two of 50 is \`offset: 50\`.
- \`degraded\` names services that did not answer. A short list may be an outage rather than an answer, so say which it was.

Writing:
- Writes happen in two calls. The first previews: read \`summary\` and \`effects\`, then call again passing the returned \`confirm\` token to apply it. \`applied\` says which of the two just happened. \`dry_run: true\` previews without ever issuing a token.
- Writes take a service and an id, never a title. Get the id from \`get_library\` or \`get_media_details\` first.
- A write refused for permissions names the config key that would allow it. Report that key rather than retrying.

Arguments are strict: an argument a tool does not have is refused rather than ignored, and the error lists what it does accept.`;

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
    const handler = createMcpHandler(() => {
        const snapshot = runtime.current;
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
        registerAllTools(server, snapshot.tools);
        // Registered beside the tools, never instead of them. Client support
        // for prompts and resources is uneven and arr-mcp has to work on all of
        // them, so a client that surfaces neither is exactly as capable as
        // before — `test/mcp.test.ts` asserts that rather than trusting it.
        registerAllPrompts(server);
        registerAllResources(server, snapshot.tools);
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

    /**
     * An empty list means "accept any Host", which is the right default for a
     * LAN container reached by IP — and the reason the adapter's own option
     * could not be used naively: it gates on `if (allowedHosts)`, and `[]` is
     * truthy, so an empty array installed validation with an empty allow-list
     * and rejected *every* request with 403. A container that rejects 100% of
     * traffic looks healthy until someone uses it.
     */
    app.use('*', async (c, next) => {
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

        logger.warn({ host, ip: c.req.header('x-forwarded-for') ?? 'unknown' }, 'rejected request with an unlisted Host');
        return c.text('forbidden: Host not allowed', 403);
    });

    app.get('/healthz', c => c.json({ status: 'ok', name: NAME, version: VERSION }));

    registerWebRoutes(app, { runtime, audit, logs, version: VERSION });

    app.all('/mcp', async (c: Context) => {
        // From the runtime, not a captured value, so rotating the token or
        // flipping the flag in the config UI takes effect on the very next
        // request.
        const { auth } = runtime.config;
        const presented = presentedToken(c.req.url, c.req.header('Authorization'), auth.allow_token_in_url);

        if (presented.via === 'none' || !tokenMatches(presented.token, auth.bearer_token)) {
            logger.warn(
                { path: '/mcp', ip: c.req.header('x-forwarded-for') ?? 'unknown' },
                'rejected unauthenticated MCP request'
            );
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
                { 'WWW-Authenticate': 'Bearer realm="arr-mcp"' }
            );
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
            parsedBody: c.get('parsedBody') ?? undefined
        });

        return streaming ? response : asPlainJson(response);
    });

    return app;
}
