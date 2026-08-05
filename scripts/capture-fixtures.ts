/**
 * Captures real API responses into test/fixtures/ so CI needs no live media
 * stack (design spec §17). Run by the maintainer, never in CI.
 *
 *   npm run capture                        # reads ./config/config.yaml
 *   ARR_MCP_CAPTURE_CONFIG=/path npm run capture
 *
 * Credentials are read from the config file and never printed. Redaction is
 * secrets-only by decision (Phase 2 design §7): real titles, usernames, LAN
 * addresses and mount paths are published.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.ts';
import type { Config, ServiceId } from '../src/config/schema.ts';
import { apiKeyHeader, embyToken, queryParamKey, transmissionRpc, type AuthStrategy } from '../src/core/auth.ts';
import { ServiceHttp } from '../src/core/http.ts';

const REDACTED = '__REDACTED__';

const SECRET_KEY = /^(api_?key|apikey|token|access_?token|auth_?token|password|passwd|secret|nzb_?key)$/i;

type Endpoint = { name: string; path: string; body?: unknown };

/**
 * What each adapter needs to see. Extend this when an adapter starts reading a
 * new endpoint — a fixture that does not exist cannot be tested against.
 */
const ENDPOINTS: Record<ServiceId, Endpoint[]> = {
    radarr: [
        { name: 'system-status', path: '/api/v3/system/status' },
        { name: 'diskspace', path: '/api/v3/diskspace' },
        { name: 'health', path: '/api/v3/health' },
        { name: 'system-task', path: '/api/v3/system/task' }
    ],
    sonarr: [
        { name: 'system-status', path: '/api/v3/system/status' },
        { name: 'diskspace', path: '/api/v3/diskspace' },
        { name: 'health', path: '/api/v3/health' },
        { name: 'system-task', path: '/api/v3/system/task' }
    ],
    prowlarr: [
        { name: 'system-status', path: '/api/v1/system/status' },
        { name: 'health', path: '/api/v1/health' },
        { name: 'diskspace', path: '/api/v1/diskspace' },
        { name: 'indexer', path: '/api/v1/indexer' },
        { name: 'indexerstatus', path: '/api/v1/indexerstatus' }
    ],
    bazarr: [
        { name: 'system-status', path: '/api/system/status' },
        { name: 'system-health', path: '/api/system/health' }
    ],
    jellyfin: [
        { name: 'system-info', path: '/System/Info' },
        { name: 'users', path: '/Users' },
        { name: 'scheduled-tasks', path: '/ScheduledTasks' }
    ],
    seerr: [
        { name: 'status', path: '/api/v1/status' },
        { name: 'user', path: '/api/v1/user' },
        { name: 'settings-about', path: '/api/v1/settings/about' }
    ],
    sabnzbd: [
        { name: 'version', path: '/api?mode=version&output=json' },
        { name: 'queue', path: '/api?mode=queue&output=json' },
        { name: 'server-stats', path: '/api?mode=server_stats&output=json' }
    ],
    transmission: [{ name: 'session-get', path: '/transmission/rpc', body: { method: 'session-get' } }]
};

function strategyFor(id: ServiceId, service: NonNullable<Config['services'][ServiceId]>): AuthStrategy {
    if (id === 'transmission') {
        const t = service as { username?: string; password?: string };
        return transmissionRpc({
            ...(t.username === undefined ? {} : { username: t.username }),
            ...(t.password === undefined ? {} : { password: t.password })
        });
    }
    const key = (service as { api_key: string }).api_key;
    if (id === 'jellyfin') return embyToken(key);
    if (id === 'sabnzbd') return queryParamKey('apikey', key);
    if (id === 'bazarr') return apiKeyHeader('X-API-KEY', key);
    return apiKeyHeader('X-Api-Key', key);
}

/** Every configured credential, so the post-write scan can look for them exactly. */
function secretsOf(config: Config): string[] {
    const out: string[] = [];
    for (const service of Object.values(config.services)) {
        if (service === undefined) continue;
        const s = service as { api_key?: string; password?: string };
        if (s.api_key) out.push(s.api_key);
        if (s.password) out.push(s.password);
    }
    return out;
}

function redact(node: unknown, secrets: string[]): unknown {
    if (typeof node === 'string') {
        return secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), node);
    }
    if (Array.isArray(node)) return node.map(v => redact(v, secrets));
    if (node !== null && typeof node === 'object') {
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [
                key,
                SECRET_KEY.test(key) && value !== null && value !== '' ? REDACTED : redact(value, secrets)
            ])
        );
    }
    return node;
}

const configDir = process.env.ARR_MCP_CAPTURE_CONFIG ?? './config';
const { config } = await loadConfig(configDir);
const secrets = secretsOf(config);

if (secrets.length === 0) {
    console.error(`No credentials found in ${configDir}/config.yaml — nothing to capture.`);
    process.exit(1);
}

let captured = 0;
let skipped = 0;

for (const [id, service] of Object.entries(config.services) as [ServiceId, Config['services'][ServiceId]][]) {
    if (service === undefined) continue;

    const http = new ServiceHttp(id, service, strategyFor(id, service));
    const dir = join('test', 'fixtures', id);
    await mkdir(dir, { recursive: true });

    for (const endpoint of ENDPOINTS[id]) {
        try {
            const raw =
                endpoint.body === undefined
                    ? await http.get<unknown>(endpoint.path)
                    : await http.post<unknown>(endpoint.path, endpoint.body);

            const serialised = JSON.stringify(redact(raw, secrets), null, 2);

            // The gate. If any configured credential survived redaction, refuse
            // to write rather than trusting a reviewer to spot it in a diff.
            const leaked = secrets.find(s => serialised.includes(s));
            if (leaked !== undefined) {
                console.error(`REFUSING TO WRITE ${id}/${endpoint.name}: a configured credential survived redaction`);
                process.exit(1);
            }

            await writeFile(join(dir, `${endpoint.name}.json`), `${serialised}\n`);
            console.log(`captured ${id}/${endpoint.name}`);
            captured += 1;
        } catch (err) {
            // A missing endpoint is information, not a failure: it tells us the
            // service does not have that capability. Record and continue.
            console.warn(`skipped  ${id}/${endpoint.name}: ${(err as Error).message}`);
            skipped += 1;
        }
    }
}

console.log(`\n${captured} captured, ${skipped} skipped.`);
console.log('Review `git diff test/fixtures/` before committing — redaction is secrets-only by design.');
