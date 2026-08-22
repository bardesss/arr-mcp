/**
 * Multiple instances of one service, against a live stack. Maintainer-run,
 * never CI — `integration.ts` only ever exercises the single-instance shape.
 *
 *     ARR_MCP_CONFIG_DIR=./config node scripts/multi-instance-check.ts
 *
 * It configures the real Radarr and Sonarr twice, as `hd` and `4k`. Doubling
 * one service is what makes the library total checkable: the same ids merge, so
 * a fan-out that double-counted shows up as a changed total.
 *
 * Reads only — the write tools it calls are dry runs or refusals.
 */
import { loadConfig } from '../src/config/load.ts';
import { buildApp } from '../src/app.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hostsOf, redactHosts } from './lib/redact.ts';
import { callTool, type ToolCallResult } from './lib/rpc.ts';


const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? './config';
const { config: real } = await loadConfig(CONFIG_DIR, { persist: false });
const hosts = hostsOf(real);

/** The same service twice, under two names. */
function doubled(config: Config): Config {
    const services = { ...config.services } as Record<string, unknown>;
    for (const type of ['radarr', 'sonarr'] as const) {
        const block = services[type];
        if (block === undefined || Array.isArray(block)) continue;
        services[type] = [
            { ...(block as object), name: 'hd' },
            { ...(block as object), name: '4k' }
        ];
    }
    return ConfigSchema.parse({ ...config, services });
}

const appFor = (config: Config) =>
    buildApp({
        runtime: Runtime.fromConfig(config, WriteAudit.ephemeral(), { configDir: CONFIG_DIR }),
        audit: WriteAudit.ephemeral(),
        logs: LogStore.ephemeral()
    });


let passes = 0;
let failures = 0;

const pass = (label: string, detail = '') => {
    console.log(`PASS ${label}${detail === '' ? '' : ` — ${redactHosts(detail, hosts)}`}`);
    passes += 1;
};
const fail = (label: string, detail: string) => {
    console.error(`FAIL ${label} — ${redactHosts(detail, hosts)}`);
    failures += 1;
};

// --- the two apps ---------------------------------------------------------

const single = appFor(real);
const multiConfig = doubled(real);
const multi = appFor(multiConfig);
const token = real.auth.bearer_token;

const arrTypes = (['radarr', 'sonarr'] as const).filter(t => Array.isArray(multiConfig.services[t]));
if (arrTypes.length === 0) {
    console.error('This config has no single-block radarr or sonarr to double. Nothing to check.');
    process.exit(1);
}
console.log(`Doubling: ${arrTypes.map(t => `${t}/hd + ${t}/4k`).join(', ')}\n`);

const run = async (label: string, tool: string, args: Record<string, unknown>): Promise<ToolCallResult | undefined> => {
    const started = performance.now();
    try {
        const result = await callTool(multi, token, tool, args);
        const ms = Math.round(performance.now() - started);
        const text = result.content?.[0]?.text ?? '';
        if (result.isError === true) {
            fail(label, `(${ms}ms) ${text}`);
            return undefined;
        }
        pass(label, `(${ms}ms) ${text.slice(0, 200)}`);
        return result;
    } catch (err) {
        fail(label, (err as Error).message);
        return undefined;
    }
};

const expectRefusal = async (label: string, tool: string, args: Record<string, unknown>, expected: RegExp) => {
    try {
        const result = await callTool(multi, token, tool, args);
        const text = result.content?.[0]?.text ?? '';
        if (result.isError === true && expected.test(text)) return pass(label, text.slice(0, 220));
        fail(label, result.isError === true ? `wrong refusal: ${text}` : `expected a refusal, got: ${text}`);
    } catch (err) {
        fail(label, (err as Error).message);
    }
};

// --- 1. every instance is its own adapter, everywhere ---------------------

const health = await run('stack_health sees both instances', 'stack_health', { detail: 'full' });
const healthIds = ((health?.structuredContent as { services?: { service?: string }[] } | undefined)?.services ?? []).map(
    s => s.service
);
for (const type of arrTypes) {
    const want = [`${type}/hd`, `${type}/4k`];
    if (want.every(id => healthIds.includes(id))) pass(`stack_health lists ${want.join(' and ')}`);
    else fail(`stack_health lists ${want.join(' and ')}`, `got: ${healthIds.join(', ')}`);
}

// --- 2. reads fan out across instances ------------------------------------

const singleLibrary = await callTool(single, token, 'get_library', { limit: 1 });
const multiLibrary = await run('get_library fans out', 'get_library', { limit: 1 });

type Envelope = { total?: number; counts?: Record<string, number>; degraded?: string[] };
const one = singleLibrary.structuredContent as Envelope | undefined;
const two = multiLibrary?.structuredContent as Envelope | undefined;

// The point of this script. Reported as a failure rather than skipped when a
// total is missing: passing silently over the one assertion that matters is
// how renaming `total` would turn the whole run into a green no-op.
if (one?.total === undefined || two?.total === undefined) {
    fail(
        'library total is unchanged by doubling',
        `no total in the envelope — single: ${JSON.stringify(one?.total)}, doubled: ${JSON.stringify(two?.total)}`
    );
} else if (one.total === two.total) {
    pass('library total is unchanged by doubling', `${two.total} items either way`);
} else {
    fail('library total is unchanged by doubling', `single ${one.total} vs doubled ${two.total} — duplicates did not merge`);
}
console.log(`     counts single: ${JSON.stringify(one?.counts ?? {})}`);
console.log(`     counts doubled: ${JSON.stringify(two?.counts ?? {})}`);
for (const type of arrTypes) {
    const keys = Object.keys(two?.counts ?? {});
    const want = [`${type}/hd`, `${type}/4k`];
    if (want.every(k => keys.includes(k))) pass(`get_library counts both ${type} instances separately`);
    else fail(`get_library counts both ${type} instances separately`, `counts keys: ${keys.join(', ')}`);
}
if ((two?.degraded ?? []).length > 0) console.log(`     degraded: ${(two?.degraded ?? []).join(', ')}`);

await run('get_queue fans out', 'get_queue', { detail: 'full' });
await run('get_calendar fans out', 'get_calendar', { detail: 'full', days_back: 7, days_ahead: 7 });
await run('search_media over the doubled library', 'search_media', { query: 'the', source: 'library', limit: 5 });
await run('get_media_details over the doubled library', 'get_media_details', { query: 'the' });
await run('diagnose over the doubled library', 'diagnose', { query: 'the' });

// --- 3. writes refuse to guess which instance -----------------------------

const searchHits =
    ((await callTool(multi, token, 'search_media', { query: 'the', source: 'library', limit: 20 }))
        .structuredContent as { items?: { service?: string; id?: unknown }[] } | undefined)?.items ?? [];

for (const type of arrTypes) {
    const hit = searchHits.find(h => h.service === type || h.service === `${type}/hd` || h.service === `${type}/4k`);
    if (hit?.id === undefined) {
        console.log(`SKIP ${type} write cases — no library hit to take an id from.`);
        continue;
    }
    const id = String(hit.id);

    await expectRefusal(
        `trigger_search refuses to guess between two ${type}s`,
        'trigger_search',
        { service: type, id, dry_run: true },
        /instances configured|does not say which/
    );

    await expectRefusal(
        `trigger_search names the configured ${type} instances when given a bad one`,
        'trigger_search',
        { service: type, instance: 'nope', id, dry_run: true },
        /no instance named/
    );

    await run(`trigger_search dry run against ${type}/hd`, 'trigger_search', {
        service: type,
        instance: 'hd',
        id,
        dry_run: true
    });
}

await expectRefusal(
    'add_media refuses to guess between two radarrs',
    'add_media',
    { service: 'radarr', external_id: '603', dry_run: true },
    /instances configured|does not say which/
);

// --- 4. what search_media reports as `service` ----------------------------
//
// Reported, not asserted: a hit labelled `radarr` rather than `radarr/hd` is an
// id no write could use without a second guess.
const serviceLabels = [...new Set(searchHits.map(h => h.service))];
console.log(`\n     search_media reported service labels: ${serviceLabels.join(', ')}`);

// --- 5. the config UI renders a card per instance -------------------------

const { hashPassword } = await import('../src/core/session.ts');
const password = 'multi-instance-check-not-persisted';
const uiApp = appFor({ ...multiConfig, auth: { ...multiConfig.auth, password_hash: hashPassword(password) } });

const signIn = await uiApp.request('http://localhost:6060/ui/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: multiConfig.auth.username, password }).toString()
});
const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

const uiBody = async (path: string) =>
    (await uiApp.request(`http://localhost:6060${path}`, { headers: { cookie }, redirect: 'manual' })).text();

const configPage = await uiBody('/ui/config');
for (const type of arrTypes) {
    const want = [`${type}/hd`, `${type}/4k`];
    if (want.every(id => configPage.includes(id))) pass(`config UI renders a card for ${want.join(' and ')}`);
    else fail(`config UI renders a card for ${want.join(' and ')}`, 'one or both cards are missing');
}

const dashboard = await uiBody('/ui');
for (const type of arrTypes) {
    const want = [`${type}/hd`, `${type}/4k`];
    if (want.every(id => dashboard.includes(id))) pass(`dashboard shows both ${type} instances`);
    else fail(`dashboard shows both ${type} instances`, 'one or both are missing from the dashboard');
}

console.log(`\n${passes}/${passes + failures} checks passed.`);
process.exitCode = failures > 0 ? 1 : 0;
