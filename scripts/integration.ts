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
 * Credential handling: this script reads a live config with real API keys.
 * It never prints a value out of that config — only tool names, counts,
 * latencies, and each tool's own summary line (titles, ids and pass/fail
 * text, never a key, token or service URL).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { loadConfig } from '../src/config/load.ts';
import { buildAdapters } from '../src/services/registry.ts';
import { buildToolContext, registerAllTools, TOOL_NAMES } from '../src/tools/register.ts';

type ToolName = (typeof TOOL_NAMES)[number];
type Case = { tool: ToolName; args: Record<string, unknown> };
type ToolResult = { content?: { text?: string }[]; structuredContent?: unknown };

/**
 * Arguments chosen to exercise the path a user actually takes, not the
 * cheapest one. `detail: 'full'` on at least one call per tool, because that
 * is the level whose extra fields are the ones adapters get wrong.
 *
 * get_library gets three calls — its documented filters (§5: presence,
 * min_rating, kind) each take a different code path through the join, and a
 * fixture-only test would never exercise more than one of them for real.
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
    // A regression guard for the cross-source rating scale defect: metacritic
    // and rottenTomatoes arrive on a 0-100 scale, everything else on 0-10.
    // Before the fix these two returned every rated film — "rated at all"
    // silently read as "rated 8+".
    { tool: 'get_library', args: { min_rating: 8, rating_source: 'metacritic', limit: 5 } },
    { tool: 'get_library', args: { min_rating: 8, rating_source: 'rottenTomatoes', limit: 5 } },
    { tool: 'get_media_details', args: { query: 'the' } },
    { tool: 'search_media', args: { query: 'the', source: 'library', detail: 'full', limit: 10 } },
    { tool: 'lookup_media', args: { query: 'matrix' } },
    { tool: 'discover_media', args: { media_type: 'movie', detail: 'full' } },
    { tool: 'diagnose', args: { query: 'the' } }
];

// Same env var src/index.ts uses, so this reads the config the container
// does. The default differs from src/index.ts's `/config`, though: that
// default is right for the container, where the volume is always mounted
// there, but wrong for a maintainer running this from a checkout — `/config`
// resolves outside the repo entirely (on Windows, to a different drive root).
// `./config` is the local-checkout default the capture script already
// established under its own env var, so this follows that convention rather
// than the container one.
const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? './config';
const { config } = await loadConfig(CONFIG_DIR);

const adapters = buildAdapters(config);
const context = buildToolContext(adapters, config);

/**
 * Registering against a recording stub is what lets this call the handlers
 * directly, without an MCP client or a listening port. The real server
 * parses every call's arguments through the tool's own `inputSchema` before
 * the handler ever sees them — that is where a `detail`/`limit` default
 * (`standard`/`50`) actually gets applied. Skipping that step here would
 * make every case that omits an optional field fail silently: `applyLimit`
 * fed a genuinely undefined limit returns zero items, which is precisely the
 * false "0 of N" this script exists to tell apart from a real one. So the
 * stub captures each tool's schema alongside its handler and parses through
 * it before every call, the same as a real client would.
 */
type Registered = { schema: z.ZodTypeAny; handler: (args: Record<string, unknown>) => Promise<ToolResult> };
const handlers = new Map<string, Registered>();
const server = {
    registerTool: (
        name: string,
        meta: { inputSchema?: z.ZodTypeAny },
        handler: (a: Record<string, unknown>) => Promise<ToolResult>
    ) => {
        if (meta.inputSchema === undefined) throw new Error(`${name} registered with no inputSchema`);
        handlers.set(name, { schema: meta.inputSchema, handler });
    }
};

registerAllTools(server as unknown as McpServer, context);

const missing = TOOL_NAMES.filter(name => !CASES.some(c => c.tool === name));
if (missing.length > 0) {
    // Counting tools is not calling them — the check RELEASING.md added after
    // 0.3.0, made mechanical.
    console.error(`No case covers: ${missing.join(', ')}`);
    process.exitCode = 1;
}

let passes = 0;
let failures = 0;

/** Runs one case, printing PASS/FAIL with latency and the tool's own summary line. */
async function run(tool: string, args: Record<string, unknown>, note?: string): Promise<ToolResult | undefined> {
    const label = `${tool} ${JSON.stringify(args)}${note === undefined ? '' : ` — ${note}`}`;
    const registered = handlers.get(tool);
    if (registered === undefined) {
        console.error(`FAIL ${label} — not registered`);
        failures += 1;
        return undefined;
    }

    const started = performance.now();
    try {
        const parsed = registered.schema.parse(args) as Record<string, unknown>;
        const result = await registered.handler(parsed);
        const ms = Math.round(performance.now() - started);
        console.log(`PASS ${label} (${ms}ms) — ${result.content?.[0]?.text ?? ''}`);
        passes += 1;
        return result;
    } catch (err) {
        console.error(`FAIL ${label} — ${(err as Error).message}`);
        failures += 1;
        return undefined;
    }
}

let libraryResult: ToolResult | undefined;
let searchResult: ToolResult | undefined;

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
 * looks wrong), and — when the library actually has one — an item Present on
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
process.exitCode = failures > 0 ? 1 : process.exitCode;
