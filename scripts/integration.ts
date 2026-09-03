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
import { buildApp } from '../src/app.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { TOOL_NAMES } from '../src/tools/register.ts';
import { hostsOf, redactHosts, secretsOf } from './lib/redact.ts';
import { callTool as rpcCallTool, type ToolCallResult } from './lib/rpc.ts';

type ToolName = (typeof TOOL_NAMES)[number];
type Case = { tool: ToolName; args: Record<string, unknown> };

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
    { tool: 'get_history', args: { detail: 'full', limit: 20 } },
    { tool: 'get_wanted', args: { scope: 'missing', detail: 'full', limit: 20 } },
    { tool: 'get_wanted', args: { scope: 'upgradable', limit: 20 } },
    // The brief's case used `days: 14`, a field this schema does not have —
    // get_calendar takes `days_back` and `days_ahead` separately. Using the
    // brief's field name would silently no-op back to the defaults (7/14)
    // rather than fail, which is exactly the kind of thing this script exists
    // to catch, so it is fixed here rather than reproduced.
    { tool: 'get_calendar', args: { detail: 'full', days_back: 14, days_ahead: 14 } },
    { tool: 'get_playback', args: { detail: 'full' } },
    { tool: 'get_blocklist', args: { detail: 'full', limit: 20 } },
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
// `persist: false` — a smoke run reads the user's config; it must never write
// to the file holding their credentials.
const { config } = await loadConfig(CONFIG_DIR, { persist: false });

// Ephemeral on purpose: this script is a maintainer smoke run, and its dry-run
// probes are not events the user's own audit trail — or log ring buffer —
// should be cluttered with.
const app = buildApp({
    runtime: Runtime.fromConfig(config, WriteAudit.ephemeral(), { configDir: CONFIG_DIR }),
    audit: WriteAudit.ephemeral(),
    logs: LogStore.ephemeral()
});
const hosts = hostsOf(config);

/**
 * Tools the dynamic section below drives rather than the static CASES table,
 * because their arguments have to come from an earlier call's result. Listed
 * here so the coverage check counts them — without this, adding a tool that
 * needs a real id would either fail the check forever or, worse, be given a
 * made-up id just to satisfy it.
 */
const DYNAMIC_TOOLS: ToolName[] = [
    'trigger_search',
    // Needs a guid and an indexer id that only a live get_releases can
    // produce — inventing one would capture a 404, not a mapping.
    'grab_release',
    // Needs, respectively: a real TMDB id, a configured download client, a
    // real Jellyfin item id, and a real blocklist row. All dry runs.
    'request_media',
    'pause_downloads',
    'set_watched',
    'remove_blocklist_item',
    // Needs a real service+id the same way trigger_search does. Driven off
    // the same searchableHit, but kept to one call: this one polls every
    // configured indexer synchronously (up to the tool's own 120s budget),
    // so it is the slowest thing this script runs — one conservative case at
    // a small limit is enough to prove the mapping, not a stress test.
    'get_releases',
    'remove_queue_item',
    'delete_media',
    'respond_to_request',
    'delete_request',
    'add_media',
    // Needs a real service+id, like the writes above, and is driven off the
    // same searchableHit. Dry run: a real call would move files.
    'update_media',
    // Sonarr-only, and both need a real series id — the same reason as the
    // five above. Driven as dry runs off the first Sonarr search hit.
    'set_monitoring',
    'delete_episode_files',
    // Dry runs off a scannable service and a real get_subtitles gap.
    'trigger_scan',
    'trigger_subtitle_search',
    'clean_queue'
];

const missing = TOOL_NAMES.filter(
    name => !CASES.some(c => c.tool === name) && !DYNAMIC_TOOLS.includes(name)
);
if (missing.length > 0) {
    // Counting tools is not calling them — the check RELEASING.md added after
    // 0.3.0, made mechanical.
    console.error(`No case covers: ${missing.join(', ')}`);
    process.exitCode = 1;
}


/**
 * One `tools/call` JSON-RPC request, in-process through Hono — no listening
 * port. Throws on any transport- or protocol-level failure (a non-2xx HTTP
 * status, an unparsable body, or a JSON-RPC `error`); a tool-level failure is
 * not one of these — it comes back as a normal 200 with `isError: true`,
 * which the caller inspects.
 */
/** Bound to this run's app and token, so call sites read as before. */
const callTool = (name: string, args: Record<string, unknown>): Promise<ToolCallResult> =>
    rpcCallTool(app, config.auth.bearer_token, name, args);

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

/**
 * Runs a case whose *correct* outcome is a refusal, and passes only when the
 * refusal is the expected one.
 *
 * Some behaviour is only worth confirming as a failure — a tool that declines
 * to guess between nine quality profiles is working, and asserting that with
 * `run` would paint a green stack red. Asserting on the message, not merely on
 * "it errored", is what keeps this from passing for the wrong reason: an
 * unreachable service also errors.
 */
async function expectError(
    tool: string,
    args: Record<string, unknown>,
    expected: RegExp,
    note: string
): Promise<void> {
    const label = `${tool} ${JSON.stringify(args)} — ${note}`;
    const started = performance.now();

    try {
        const result = await callTool(tool, args);
        const ms = Math.round(performance.now() - started);
        const text = redactHosts(result.content?.[0]?.text ?? '', hosts);

        if (result.isError === true && expected.test(text)) {
            console.log(`PASS ${label} (${ms}ms) — refused as expected: ${text}`);
            passes += 1;
            return;
        }
        console.error(
            `FAIL ${label} (${ms}ms) — ${result.isError === true ? `wrong refusal: ${text}` : `expected a refusal, got: ${text}`}`
        );
        failures += 1;
    } catch (err) {
        const ms = Math.round(performance.now() - started);
        console.error(`FAIL ${label} (${ms}ms) — ${redactHosts((err as Error).message, hosts)}`);
        failures += 1;
    }
}

/**
 * Runs a case whose whole point is that the result must not be empty —
 * `run` alone would pass just as happily against `total: 0` as against a
 * real result, which is exactly how the scoped-get_history defect (a bare
 * array from Radarr's per-item history endpoint silently read as zero
 * records) survived the unit suite: every fixture asserted on the request
 * URL, never on what came back. This is that missing assertion, made live.
 */
async function expectNonEmpty(tool: string, args: Record<string, unknown>, note: string): Promise<void> {
    const label = `${tool} ${JSON.stringify(args)} — ${note}`;
    const started = performance.now();

    try {
        const result = await callTool(tool, args);
        const ms = Math.round(performance.now() - started);
        const text = redactHosts(result.content?.[0]?.text ?? '', hosts);

        if (result.isError === true) {
            console.error(`FAIL ${label} (${ms}ms) — ${text}`);
            failures += 1;
            return;
        }
        const total = (result.structuredContent as { total?: number } | undefined)?.total;
        if (typeof total === 'number' && total > 0) {
            console.log(`PASS ${label} (${ms}ms) — ${text}`);
            passes += 1;
            return;
        }
        console.error(`FAIL ${label} (${ms}ms) — expected total > 0, got: ${text}`);
        failures += 1;
    } catch (err) {
        const ms = Math.round(performance.now() - started);
        console.error(`FAIL ${label} (${ms}ms) — ${redactHosts((err as Error).message, hosts)}`);
        failures += 1;
    }
}

let libraryResult: ToolCallResult | undefined;
let searchResult: ToolCallResult | undefined;
let queueResult: ToolCallResult | undefined;
let requestsResult: ToolCallResult | undefined;
let subtitlesResult: ToolCallResult | undefined;
let playbackResult: ToolCallResult | undefined;
let releasesResult: ToolCallResult | undefined;
let blocklistResult: ToolCallResult | undefined;

for (const { tool, args } of CASES) {
    const result = await run(tool, args);
    if (tool === 'get_library' && args.detail === 'standard') libraryResult = result;
    if (tool === 'search_media') searchResult = result;
    if (tool === 'get_queue') queueResult = result;
    if (tool === 'get_requests') requestsResult = result;
    if (tool === 'get_subtitles') subtitlesResult = result;
    if (tool === 'get_playback') playbackResult = result;
    if (tool === 'get_blocklist') blocklistResult = result;
}

/**
 * diagnose's verdict and remedy are the product this phase built, and a
 * single generic query does not exercise the chain the way a maintainer
 * actually would: a title that resolves, one that plainly does not, an
 * explicit service+id (the form get_media_details hands back for a join that
 * looks wrong), and — when the library actually has one — an item present on
 * one side and not the other, which is the case diagnose exists to explain.
 */
type LibraryItemLike = { title?: unknown; presence?: unknown; kind?: unknown; ids?: { tmdb?: number } };
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

const searchHits = ((searchResult?.structuredContent as { items?: unknown[] } | undefined)?.items ??
    []) as SearchHitLike[];
const searchHit = searchHits[0];

/**
 * `diagnose` accepts a service+id from any of the eight, so it takes items[0]
 * above. `trigger_search` reaches only Radarr and Sonarr, and the first library
 * hit is routinely a Jellyfin one — taking items[0] for both made the run fail
 * on a tool that was behaving correctly, which is a script bug that would
 * otherwise recur on every stack whose search happens to rank Jellyfin first.
 */
const searchableHit = searchHits.find(h => h.service === 'radarr' || h.service === 'sonarr');

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

/**
 * The one write tool, exercised **only as a dry run**. That is the whole reason
 * a dry run is not permission-gated: this covers the real path — resolve the
 * id, read the item back from the live service, describe the effect, report the
 * permission verdict — against a maintainer's actual stack without needing
 * write permission enabled and without touching anything.
 *
 * A live confirm/apply case is deliberately absent. It would queue a real
 * search on a real Radarr on every run, and the failure mode of getting that
 * wrong is a stack grabbing releases nobody asked for.
 */
if (typeof searchableHit?.service === 'string' && searchableHit.id !== undefined) {
    await run(
        'trigger_search',
        { service: searchableHit.service, id: String(searchableHit.id), dry_run: true },
        'dry run only — never applied from this script'
    );
} else {
    console.log('SKIP trigger_search — search_media returned no Radarr or Sonarr hit to take a service+id from.');
}

/**
 * get_releases against the same service+id — read-only (READ_ONLY annotated,
 * no dry_run to gate), but the one call in this whole script that reaches
 * out to real indexers rather than just Radarr/Sonarr/Jellyfin themselves.
 * `limit: 5` keeps the response small; it does not make the search faster,
 * since Radarr/Sonarr poll every indexer before this tool ever sees a
 * result.
 */
if (typeof searchableHit?.service === 'string' && searchableHit.id !== undefined) {
    releasesResult = await run(
        'get_releases',
        { service: searchableHit.service, id: String(searchableHit.id), limit: 5, detail: 'full' },
        'slow — polls every configured indexer'
    );
} else {
    console.log('SKIP get_releases — search_media returned no Radarr or Sonarr hit to take a service+id from.');
}

/**
 * grab_release, dry run, against a candidate the call above actually
 * produced. `detail: "full"` up there is what makes this possible at all —
 * `guid` and `indexerId` are trimmed below it, and they are the entire
 * identity of a release.
 *
 * Never applied: a grab starts a real download.
 */
const candidate = (releasesResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | { service?: unknown; guid?: unknown; indexerId?: unknown }
    | undefined;

if (
    typeof searchableHit?.service === 'string' &&
    typeof candidate?.guid === 'string' &&
    typeof candidate.indexerId === 'number'
) {
    await run(
        'grab_release',
        {
            service: searchableHit.service,
            id: String(searchableHit.id),
            guid: candidate.guid,
            indexer_id: candidate.indexerId,
            dry_run: true
        },
        'DRY RUN ONLY — never applied from this script; slow, the preview re-runs the search'
    );
} else {
    console.log('SKIP grab_release — get_releases returned no candidate carrying a guid and an indexer id.');
}

/**
 * get_history, scoped to the same service+id — the exact path a live call
 * would have caught the Critical this phase shipped with: the CASES entry
 * above only ever calls get_history unscoped, which hits `/api/v3/history`
 * and was never broken. The defect was in the *scoped* read, which hit
 * `/api/v3/history/movie|series` — an endpoint that answers a bare array,
 * not the envelope the (now-removed) code expected, so a scoped call always
 * came back empty regardless of whether the item actually had history.
 *
 * `searchableHit` is not guaranteed to have history — it is search_media's
 * first Radarr/Sonarr hit, and a freshly-added title could genuinely have
 * none yet — so this can occasionally false-fail on an otherwise-healthy
 * stack. It is still worth more than the unscoped case above, which cannot
 * fail this way at all, so `expectNonEmpty` is used deliberately rather than
 * `run`: an assertion that would also pass against `total: 0` is exactly
 * the gap that let this defect ship.
 */
if (typeof searchableHit?.service === 'string' && searchableHit.id !== undefined) {
    await expectNonEmpty(
        'get_history',
        { service: searchableHit.service, id: String(searchableHit.id), detail: 'full', limit: 20 },
        'scoped — the exact path the Critical was in; searchableHit is usually, not guaranteed, non-empty'
    );
} else {
    console.log('SKIP scoped get_history — search_media returned no Radarr or Sonarr hit to take a service+id from.');
}

/**
 * The destructive pair, **dry run only, without exception**.
 *
 * These two are the reason `dry_run` exists as a terminal form rather than as
 * the first half of the handshake. A live case here would delete a maintainer's
 * film or wipe a partial download on every run, and no amount of care in a
 * script makes that an acceptable default. The dry run still exercises
 * everything worth exercising against a real service: the id resolves, the item
 * is read back, the effect is described from real data (including the real size
 * on disk), and the permission verdict is reported.
 *
 * If you want to test the apply path, do it by hand against something you are
 * willing to lose.
 */
if (typeof searchableHit?.service === 'string' && searchableHit.id !== undefined) {
    await run(
        'delete_media',
        { service: searchableHit.service, id: String(searchableHit.id), delete_files: true, dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    console.log('SKIP delete_media — search_media returned no Radarr or Sonarr hit to take a service+id from.');
}

/**
 * The Sonarr pair, dry run only, for the same reasons — and one more.
 *
 * `set_monitoring` is the whole-series form deliberately: a season number
 * taken from thin air is a season the series may not have, which the tool now
 * refuses, and a red line for a correct refusal is a script bug rather than a
 * finding. `delete_episode_files` has no whole-series form at all, so it takes
 * season 1 — the season essentially every series has; a series without files
 * there answers `noop`, which is a pass, not a failure.
 *
 * Both exercise what only a live stack proves: the id resolves, the series and
 * its episodes are read back, the preview describes real state — including
 * whether anything is still monitored, which is the warning the two-primitive
 * design leans on — and the permission verdict is reported. Neither writes.
 */
const sonarrHit = searchHits.find(h => h.service === 'sonarr');

if (sonarrHit?.id !== undefined) {
    await run(
        'set_monitoring',
        { service: 'sonarr', id: String(sonarrHit.id), monitored: false, dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
    await run(
        'delete_episode_files',
        { service: 'sonarr', id: String(sonarrHit.id), season: 1, dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    console.log('SKIP set_monitoring and delete_episode_files — search_media returned no Sonarr hit.');
}

const queueItem = (queueResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | { service?: unknown; id?: unknown }
    | undefined;

if (typeof queueItem?.service === 'string' && queueItem.id !== undefined) {
    await run(
        'remove_queue_item',
        { service: queueItem.service, id: String(queueItem.id), blocklist: true, dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    // Routine, not a failure: a healthy stack with nothing downloading has an
    // empty queue most of the time.
    console.log('SKIP remove_queue_item — the queue is empty, so there is no real item to preview against.');
}

/**
 * The Seerr pair, dry run only for the same reason as the two above —
 * approving a request really does start a download, and deleting one really
 * does destroy the record.
 */
const request = (requestsResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | { id?: unknown }
    | undefined;

if (request?.id !== undefined) {
    await run(
        'respond_to_request',
        { id: String(request.id), verdict: 'approve', dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
    await run(
        'delete_request',
        { id: String(request.id), dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    console.log('SKIP respond_to_request and delete_request — get_requests returned nothing to preview against.');
}

/**
 * add_media, dry run only — it would otherwise add a film to a maintainer's
 * Radarr and start downloading it on every run.
 *
 * No quality profile is named on purpose, so this exercises the refusal path:
 * a real stack has nine profiles, and the tool declining to guess between them
 * — while listing them — is the behaviour most worth confirming against live
 * data. `expectError` is what makes that a pass rather than a red line.
 *
 * The id is chosen at run time, because a film already in the library answers
 * the already-present no-op long before it reaches the profile refusal. A
 * hardcoded 603 went red the day The Matrix was added.
 */
const ADD_CANDIDATES = ['603', '13', '155', '27205', '680', '278', '238'];

/** Decides on the already-present no-op, never on the refusal — that is the
 *  assertion, and it must not select its own input. */
const alreadyHeld = async (externalId: string): Promise<boolean> => {
    try {
        const result = await callTool('add_media', { service: 'radarr', external_id: externalId, dry_run: true });
        return /already in/.test(result.content?.[0]?.text ?? '');
    } catch {
        return false; // Let expectError report it through the normal path.
    }
};

let addCandidate: string | undefined;
for (const candidate of ADD_CANDIDATES) {
    if (!(await alreadyHeld(candidate))) {
        addCandidate = candidate;
        break;
    }
}

if (addCandidate === undefined) {
    console.log(
        `SKIP add_media — radarr already holds every candidate (${ADD_CANDIDATES.join(', ')}), so the refuse-to-guess path cannot be reached.`
    );
} else {
    await expectError(
        'add_media',
        { service: 'radarr', external_id: addCandidate, dry_run: true },
        /several quality profiles|Name one/,
        'DRY RUN ONLY — expects the refuse-to-guess path, with the profiles listed'
    );
}

/**
 * update_media, dry run only — a real call can move files on disk. Two cases:
 * a monitoring change (which is either a change or an honest no-op) and the
 * refuse-to-guess path a bare profile name takes on a multi-profile instance.
 */
if (typeof searchableHit?.service === 'string' && searchableHit.id !== undefined) {
    await run(
        'update_media',
        { service: searchableHit.service, id: String(searchableHit.id), monitored: true, dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
    await expectError(
        'update_media',
        { service: searchableHit.service, id: String(searchableHit.id), dry_run: true },
        /Nothing to change/i,
        'refuses a call that names no field'
    );
} else {
    console.log('SKIP update_media — search_media returned no *arr hit to preview against.');
}

/**
 * trigger_scan and trigger_subtitle_search, dry run only — a real scan costs a
 * maintainer disk I/O on every run, and a real subtitle search hits providers.
 */
const scannable = ['jellyfin', 'radarr', 'sonarr'].find(id => id in (config.services ?? {}));

if (scannable === undefined) {
    console.log('SKIP trigger_scan — no service with a library to scan is configured.');
} else {
    await run('trigger_scan', { service: scannable, dry_run: true }, 'DRY RUN ONLY — never applied from this script');
}

if (typeof searchableHit?.service === 'string' && searchableHit.id !== undefined) {
    await run(
        'trigger_scan',
        { service: searchableHit.service, id: String(searchableHit.id), dry_run: true },
        'DRY RUN ONLY — the per-item refresh'
    );
    await run(
        'trigger_scan',
        { service: searchableHit.service, id: String(searchableHit.id), action: 'rename', dry_run: true },
        'DRY RUN ONLY — the per-item rename'
    );
}

/**
 * The manual import, previewed against whatever the queue actually holds.
 * Skipped rather than invented when nothing is downloading: a made-up
 * download id captures a refusal, not the mapping.
 */
const queueRow = (queueResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | { service?: unknown; downloadId?: unknown }
    | undefined;

if (typeof queueRow?.service === 'string' && typeof queueRow.downloadId === 'string') {
    await run(
        'trigger_scan',
        {
            service: queueRow.service.split('/')[0],
            action: 'import',
            download_id: queueRow.downloadId,
            dry_run: true
        },
        'DRY RUN ONLY — the manual import path'
    );
} else {
    console.log('SKIP trigger_scan import — nothing in the queue carries a downloadId to preview against.');
}

const gap = (subtitlesResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | { kind?: unknown; id?: unknown; missing?: { code2?: unknown; forced?: unknown; hearingImpaired?: unknown }[] }
    | undefined;
const want = gap?.missing?.[0];

if (typeof gap?.kind === 'string' && gap.id !== undefined && typeof want?.code2 === 'string') {
    await run(
        'trigger_subtitle_search',
        {
            service: 'bazarr',
            kind: gap.kind,
            id: String(gap.id),
            language: want.code2,
            forced: want.forced === true,
            hearing_impaired: want.hearingImpaired === true,
            dry_run: true
        },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    console.log('SKIP trigger_subtitle_search — get_subtitles reported no gap to preview against.');
}

// Dry run without exception: this one really does delete downloaded data.
await run('clean_queue', { service: 'radarr', dry_run: true }, 'DRY RUN ONLY — never applied from this script');

/**
 * The four remaining writes, all dry runs, each driven off something a
 * read above actually returned rather than an invented id.
 */
const blocklistRow = (blocklistResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | { service?: unknown; id?: unknown }
    | undefined;

if (typeof blocklistRow?.service === 'string' && blocklistRow.id !== undefined) {
    await run(
        'remove_blocklist_item',
        { service: blocklistRow.service, id: String(blocklistRow.id), dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    // Routine: a stack that has never had a failed grab has an empty blocklist.
    console.log('SKIP remove_blocklist_item — the blocklist is empty, so there is no real entry to preview against.');
}

/**
 * set_watched needs a **Jellyfin** item id, which is exactly the constraint
 * the tool exists to enforce — so it is driven off get_playback's `itemId`,
 * the place its own description sends a caller.
 */
const playing = (playbackResult?.structuredContent as { items?: unknown[] } | undefined)?.items?.[0] as
    | { itemId?: unknown }
    | undefined;

// Falls back to a Jellyfin search hit, whose `id` is the same item id — a
// stack with nothing currently playing is the normal case, and skipping the
// tool every time on a healthy stack is coverage that never runs.
const jellyfinHit = ((searchResult?.structuredContent as { items?: unknown[] } | undefined)?.items ?? []).find(
    (h): h is { service: string; id: string } =>
        (h as SearchHitLike).service === 'jellyfin' && typeof (h as SearchHitLike).id === 'string'
);
const watchableId = typeof playing?.itemId === 'string' ? playing.itemId : jellyfinHit?.id;

if (watchableId !== undefined) {
    await run(
        'set_watched',
        { item_id: watchableId, watched: true, dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
    // The refusal that is the whole reason this tool validates ids: a Radarr
    // id here has to name where a real one comes from, not 404.
    await expectError(
        'set_watched',
        { item_id: '12', watched: true, dry_run: true },
        /get_playback/,
        'a Radarr-shaped id is refused, naming where a Jellyfin one comes from'
    );
} else {
    console.log('SKIP set_watched — neither get_playback nor search_media returned a Jellyfin item id.');
}

/**
 * request_media against something already in the library: a dry run either
 * previews a real request or reports the no-op, and both prove the mapping.
 */
const withTmdb = libraryItems.find(i => typeof i.ids?.tmdb === 'number');
if (withTmdb?.ids?.tmdb !== undefined) {
    await run(
        'request_media',
        { media_type: withTmdb.kind === 'series' ? 'tv' : 'movie', media_id: withTmdb.ids.tmdb, dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    console.log('SKIP request_media — no library item carried a TMDB id.');
}

/**
 * pause_downloads names one client, so this picks the first configured one
 * rather than assuming any particular stack has SABnzbd.
 */
const client = (['sabnzbd', 'transmission', 'qbittorrent'] as const).find(
    id => config.services?.[id] !== undefined
);
if (client !== undefined) {
    await run(
        'pause_downloads',
        { service: client, action: 'pause', dry_run: true },
        'DRY RUN ONLY — never applied from this script'
    );
} else {
    console.log('SKIP pause_downloads — no download client is configured.');
}

/**
 * The config UI, against the same live stack.
 *
 * The tool cases above prove the adapters; nothing in them touches `/ui`, so
 * before this a UI regression reached a release with a green script — the
 * shape of failure that put seven defects into 0.3.0. These are read-only:
 * they sign in, render every page against real services, and never save, so
 * running this cannot change a maintainer's configuration.
 */
async function checkUi(): Promise<void> {
    console.log('\n--- config UI ---');

    // The password is only knowable on the run that generated it, so this
    // signs in against a hash it sets itself rather than asking for one.
    //
    // Built here rather than halfway down because the anonymous cases need it
    // too: whether /ui offers a sign-in or a setup form depends on the config
    // carrying a password_hash. Run against `app`, those two reported the
    // maintainer's claim state instead of the login flow.
    const password = 'integration-only-not-persisted';
    const { hashPassword } = await import('../src/core/session.ts');
    const uiConfig = { ...config, auth: { ...config.auth, password_hash: await hashPassword(password) } };
    const uiRuntime = Runtime.fromConfig(uiConfig, WriteAudit.ephemeral(), { configDir: CONFIG_DIR });
    const uiApp = buildApp({ runtime: uiRuntime, audit: WriteAudit.ephemeral(), logs: LogStore.ephemeral() });

    let cookie = '';

    const fetchUi = async (path: string, init: RequestInit = {}): Promise<Response> => {
        const res = await uiApp.request(`http://localhost:6060${path}`, {
            redirect: 'manual',
            ...init,
            headers: { ...(init.headers ?? {}), ...(cookie === '' ? {} : { cookie }) }
        });
        const set = res.headers.get('set-cookie');
        if (set !== null) cookie = set.split(';')[0] ?? '';
        return res;
    };

    const check = async (label: string, run: () => Promise<boolean>): Promise<void> => {
        const started = performance.now();
        try {
            const ok = await run();
            const ms = Math.round(performance.now() - started);
            if (ok) {
                console.log(`PASS ui ${label} (${ms}ms)`);
                passes += 1;
            } else {
                console.error(`FAIL ui ${label} (${ms}ms)`);
                failures += 1;
            }
        } catch (err) {
            console.error(`FAIL ui ${label} — ${redactHosts((err as Error).message, hosts)}`);
            failures += 1;
        }
    };

    await check('redirects an anonymous visitor to the login page', async () => {
        const res = await fetchUi('/ui');
        return res.status === 302 && res.headers.get('location') === '/ui/login';
    });

    await check('renders the login page', async () => {
        const res = await fetchUi('/ui/login');
        return res.status === 200 && (await res.text()).includes('Sign in');
    });

    // The other half of that branch, and what the two above reported by accident.
    const { password_hash: _unset, ...unclaimedAuth } = uiConfig.auth;
    const unclaimedApp = buildApp({
        runtime: Runtime.fromConfig(
            { ...config, auth: unclaimedAuth },
            WriteAudit.ephemeral(),
            { configDir: CONFIG_DIR }
        ),
        audit: WriteAudit.ephemeral(),
        logs: LogStore.ephemeral()
    });

    await check('sends an unclaimed instance to the setup form instead', async () => {
        const res = await unclaimedApp.request('http://localhost:6060/ui', { redirect: 'manual' });
        return res.status === 302 && res.headers.get('location') === '/ui/setup';
    });

    cookie = '';
    const signIn = await uiApp.request('http://localhost:6060/ui/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: uiConfig.auth.username, password }).toString()
    });
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const authed = async (path: string): Promise<Response> =>
        uiApp.request(`http://localhost:6060${path}`, { headers: { cookie }, redirect: 'manual' });

    await check('signs in', async () => signIn.status === 302 && cookie.startsWith('arr_mcp_session='));

    // The one that needs a live stack: every service tested for real.
    await check('dashboard renders live diagnoses for every service', async () => {
        const res = await authed('/ui');
        const body = await res.text();
        return res.status === 200 && config.services !== undefined
            ? Object.keys(config.services).every(id => body.includes(id))
            : false;
    });

    for (const [label, path] of [
        ['configuration page renders', '/ui/config'],
        ['logs page renders', '/ui/logs?stream=all'],
        ['problems stream renders', '/ui/logs?stream=problems'],
        ['by-service stream renders', '/ui/logs?stream=service'],
        ['write audit renders', '/ui/audit']
    ] as const) {
        await check(label, async () => (await authed(path)).status === 200);
    }

    await check('no API key is ever rendered into the configuration form', async () => {
        const body = await (await authed('/ui/config')).text();
        // Through `secretsOf` so named instances are covered: the flat cast
        // here contributed no keys for them, and one flat service was enough
        // to satisfy the `length > 0` guard and report green.
        const keys = secretsOf(config);
        return keys.length > 0 && keys.every(k => !body.includes(k));
    });
}

await checkUi();

console.log(`\n${passes}/${passes + failures} calls succeeded.`);
if (missing.length > 0) {
    // Repeated here, not just at the top: a maintainer skimming only the last
    // line — the one that matters most — must not be able to miss this even
    // though the exit code (already set above) reflects it either way.
    console.error(`No case covers: ${missing.join(', ')} — exit code reflects this even though every call above passed.`);
}
process.exitCode = failures > 0 ? 1 : process.exitCode;
