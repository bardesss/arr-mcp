/**
 * Calls every tool against a live stack and reports pass or fail per tool.
 * Maintainer-run, never CI — it needs real services and a real config.
 *
 * This is not busywork. Fixtures prove the mapping and nothing else: the
 * defects that reached 0.3.0 were a null field crashing a tool outright, a
 * query parameter that has to be asked for, and an endpoint that answers 400.
 * All three were invisible to the unit suite and obvious within seconds here.
 *
 *     ARR_MCP_CONFIG_DIR=./config npm run integration
 *
 * Calls go through `buildApp` (`src/app.ts`) — the same `McpServer` and the
 * same `tools/call` JSON-RPC dispatch a real MCP client hits — driven
 * in-process via Hono's `app.request()`, exactly as `test/app.test.ts`
 * already does. No listening port, but no hand-rolled reimplementation of
 * the SDK's own argument parsing/defaulting and error-to-`isError` wrapping
 * either: an earlier version of this script called each tool's handler
 * directly against a stub `registerTool`, which meant every one of those
 * behaviours had to be reproduced by hand to get a truthful result — and one
 * (schema defaults) was missed on the first pass. Going through the real
 * dispatch removes that whole class of drift.
 *
 * Credential handling: this script reads a live config with real API keys
 * and sends the real bearer token as `Authorization` on every call. It never
 * prints a header, a key, or a token. It does print each tool's own summary
 * line, which normally contains only titles, ids and counts — except that a
 * live connectivity failure's message deliberately embeds the failing
 * service's *host* (`classifyFetchError` in `src/core/errors.ts`, by
 * design — a model diagnosing a dead connection needs to know where it
 * failed). That is fine for the tool's real caller, but not for this
 * script's stricter promise never to print a service URL, so every printed
 * line — pass or fail — is passed through `redactHosts` first.
 */
import { loadConfig } from '../src/config/load.ts';
import { buildAdapters } from '../src/services/registry.ts';
import { buildApp } from '../src/app.ts';
import { TOOL_NAMES } from '../src/tools/register.ts';
import { hostsOf, redactHosts } from './lib/redact.ts';

type ToolName = (typeof TOOL_NAMES)[number];
type Case = { tool: ToolName; args: Record<string, unknown> };
type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };

/**
 * Arguments chosen to exercise the path a user actually takes, not the
 * cheapest one. `detail: 'full'` on at least one call per tool, because that
 * is the level whose extra fields are the ones adapters get wrong.
 *
 * get_library gets several calls — its documented filters (§5: presence,
 * min_rating, kind) each take a different code path through the join, and a
 * fixture-only test would never exercise more than one of them for real. The
 * metacritic/rottenTomatoes pair is a standing regression case: those two
 * sources arrive on a 0-100 scale while `min_rating` is documented 0-10, and
 * before that was fixed they matched every rated film regardless of score.
 */
const CASES: Case[] = [
    { tool: 'stack_health', args: { detail: 'full' } },
    { tool: 'get_indexers', args: { detail: 'full' } },
    { tool: 'get_subtitles', args: { detail: 'full', limit: 100 } },
    { tool: 'get_queue', args: { detail: 'full' } },
    // The brief's case used `days: 14`, a field this schema does not have —
    // get_calendar takes `days_back` and `days_ahead` separately. Using the
    // brief's field name would silently no-op back to the defaults (7/14)
    // rather than fail, which is exactly the kind of thing this script exists
    // to catch, so it is fixed here rather than reproduced.
    { tool: 'get_calendar', args: { detail: 'full', days_back: 14, days_ahead: 14 } },
    { tool: 'get_playback', args: { detail: 'full' } },
    { tool: 'get_requests', args: { detail: 'full' } },
    { tool: 'get_library', args: { detail: 'standard', limit: 10 } },
    { tool: 'get_library', args: { presence: 'arr_only', limit: 10 } },
    { tool: 'get_library', args: { min_rating: 8, limit: 5 } },
    { tool: 'get_library', args: { kind: 'movie', limit: 5 } },
    { tool: 'get_library', args: { min_rating: 8, rating_source: 'metacritic', limit: 5 } },
    { tool: 'get_library', args: { min_rating: 8, rating_source: 'rottenTomatoes', limit: 5 } },
    { tool: 'get_media_details', args: { query: 'the' } },
    { tool: 'search_media', args: { query: 'the', source: 'library', detail: 'full', limit: 10 } },
    { tool: 'lookup_media', args: { query: 'matrix' } },
    { tool: 'discover_media', args: { media_type: 'movie', detail: 'full' } },
    { tool: 'diagnose', args: { query: 'the' } }
];

// Same env var src/index.ts uses, so this reads the config the container
// does — but a different default. src/index.ts defaults to `/config`, which
// is right for the container, where the volume is always mounted there; it
// is wrong for a maintainer running this from a checkout, where `/config`
// resolves outside the repo entirely (on Windows, to a different drive
// root). `./config` matches capture-fixtures.ts's own local-checkout
// default, under its own env var, for the same reason.
const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? './config';
const { config } = await loadConfig(CONFIG_DIR);

const adapters = buildAdapters(config);
const app = buildApp({ config, adapters });
const hosts = hostsOf(config);

const missing = TOOL_NAMES.filter(name => !CASES.some(c => c.tool === name));
if (missing.length > 0) {
    // Counting tools is not calling them — the check RELEASING.md added after
    // 0.3.0, made mechanical.
    console.error(`No case covers: ${missing.join(', ')}`);
    process.exitCode = 1;
}

let nextId = 1;

/**
 * One `tools/call` JSON-RPC request, in-process through Hono — no listening
 * port. Throws on any transport- or protocol-level failure (a non-2xx HTTP
 * status, an unparsable body, or a JSON-RPC `error`); a tool-level failure is
 * not one of these — it comes back as a normal 200 with `isError: true`,
 * which the caller inspects.
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const res = await app.request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${config.auth.bearer_token}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`transport error: HTTP ${res.status}`);

    // The SDK may frame the body as SSE rather than plain JSON; the payload
    // is always the one top-level JSON object in it. Same approach
    // test/app.test.ts's rpcPayload() uses.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('transport error: no JSON-RPC payload in the response body');

    const payload = JSON.parse(text.slice(start, end + 1)) as { result?: ToolCallResult; error?: { message?: string } };
    if (payload.error !== undefined) throw new Error(`protocol error: ${payload.error.message ?? 'unnamed'}`);
    if (payload.result === undefined) throw new Error('protocol error: no result in the response');
    return payload.result;
}

let passes = 0;
let failures = 0;

/** Runs one case, printing PASS/FAIL with latency and the tool's own summary line. */
async function run(tool: string, args: Record<string, unknown>, note?: string): Promise<ToolCallResult | undefined> {
    const label = `${tool} ${JSON.stringify(args)}${note === undefined ? '' : ` — ${note}`}`;
    const started = performance.now();

    try {
        const result = await callTool(tool, args);
        const ms = Math.round(performance.now() - started);
        const text = redactHosts(result.content?.[0]?.text ?? '', hosts);

        if (result.isError === true) {
            console.error(`FAIL ${label} (${ms}ms) — ${text}`);
            failures += 1;
            return undefined;
        }
        console.log(`PASS ${label} (${ms}ms) — ${text}`);
        passes += 1;
        return result;
    } catch (err) {
        // Latency here is exactly as diagnostic as on a pass: it tells apart a
        // fast validation error from a multi-second timeout. Hosts get
        // redacted here too — this is where classifyFetchError's Timeout/
        // Unreachable message (which embeds one by design) would otherwise
        // reach the terminal unfiltered.
        const ms = Math.round(performance.now() - started);
        console.error(`FAIL ${label} (${ms}ms) — ${redactHosts((err as Error).message, hosts)}`);
        failures += 1;
        return undefined;
    }
}

let libraryResult: ToolCallResult | undefined;
let searchResult: ToolCallResult | undefined;

for (const { tool, args } of CASES) {
    const result = await run(tool, args);
    if (tool === 'get_library' && args.detail === 'standard') libraryResult = result;
    if (tool === 'search_media') searchResult = result;
}

/**
 * diagnose's verdict and remedy are the product this phase built, and a
 * single generic query does not exercise the chain the way a maintainer
 * actually would: a title that resolves, one that plainly does not, an
 * explicit service+id (the form get_media_details hands back for a join that
 * looks wrong), and — when the library actually has one — an item present on
 * one side and not the other, which is the case diagnose exists to explain.
 */
type LibraryItemLike = { title?: unknown; presence?: unknown };
type SearchHitLike = { service?: unknown; id?: unknown };

const libraryItems = ((libraryResult?.structuredContent as { items?: unknown[] } | undefined)?.items ??
    []) as LibraryItemLike[];
// Prefers an item present on both sides, so the "exists" case is a genuinely
// different scenario from the "broken" one below rather than coincidentally
// landing on the same item — get_library's own ordering put a presence:
// arr_only item first often enough that picking items[0] unconditionally
// tested the same title twice.
const completeItem = libraryItems.find(i => i.presence === 'both') ?? libraryItems[0];
const existingTitle = typeof completeItem?.title === 'string' ? completeItem.title : undefined;
const brokenItem = libraryItems.find(i => i.presence === 'arr_only' || i.presence === 'jellyfin_only');
const brokenTitle = typeof brokenItem?.title === 'string' ? brokenItem.title : undefined;

const searchHit = (searchResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | SearchHitLike
    | undefined;

if (existingTitle !== undefined) {
    await run('diagnose', { query: existingTitle }, 'a title that exists');
}
await run('diagnose', { query: 'zzz-not-a-real-title-9f3k2q' }, 'a title that does not exist');

if (typeof searchHit?.service === 'string' && searchHit.id !== undefined) {
    await run('diagnose', { service: searchHit.service, id: String(searchHit.id) }, 'explicit service+id');
} else {
    console.log('SKIP diagnose explicit service+id — search_media returned no library hit to take one from.');
}

if (brokenTitle !== undefined) {
    await run('diagnose', { query: brokenTitle }, 'presence disagrees between services — genuinely broken');
} else {
    console.log('SKIP diagnose "genuinely broken" case — no arr_only/jellyfin_only item in the sampled library.');
}

console.log(`\n${passes}/${passes + failures} calls succeeded.`);
if (missing.length > 0) {
    // Repeated here, not just at the top: a maintainer skimming only the last
    // line — the one that matters most — must not be able to miss this even
    // though the exit code (already set above) reflects it either way.
    console.error(`No case covers: ${missing.join(', ')} — exit code reflects this even though every call above passed.`);
}
process.exitCode = failures > 0 ? 1 : process.exitCode;
