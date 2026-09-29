import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LEVELS, LogStore } from '../src/core/logs.ts';
import { hashToken } from '../src/core/mcpTokens.ts';
import { Runtime } from '../src/core/runtime.ts';

const KEY = `amk_${'1'.repeat(64)}`;
const MCP = `amcp_${'2'.repeat(64)}`;
const RADARR_KEY = 'radarr-secret-key-0000';
const TX_PASSWORD = 'tx-secret-password';

let dir: string;
let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let logs: LogStore;
let audit: WriteAudit;

const seed = async (opts: { keyed?: boolean } = {}) => {
    dir = await mkdtemp(join(tmpdir(), 'arr-mcp-api-'));
    await writeFile(
        join(dir, 'config.yaml'),
        [
            'auth:',
            '  username: admin',
            '  allowed_hosts: []',
            '  tokens:',
            `    - { name: phone, tier: read, hash: '${hashToken(MCP)}' }`,
            ...(opts.keyed === false ? [] : [`  management_key: { hash: '${hashToken(KEY)}', created: '2026-09-29' }`]),
            'services:',
            '  radarr:',
            `    - { name: hd, url: 'http://user:pw@radarr:7878', api_key: '${RADARR_KEY}' }`,
            `  transmission: { url: 'http://transmission:9091', username: tx, password: '${TX_PASSWORD}' }`,
            ''
        ].join('\n'),
        'utf8'
    );
    const { config } = await loadConfig(dir);
    audit = WriteAudit.ephemeral();
    logs = LogStore.ephemeral();
    runtime = Runtime.fromConfig(config, audit, { configDir: dir });
    app = buildApp({ runtime, audit, logs });
};

beforeEach(async () => {
    await seed();
});

afterEach(() => {
    vi.restoreAllMocks();
    logs.close();
    audit.close();
});

const api = (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const { key = KEY, ...rest } = init;
    return app.request(`http://localhost:6060/api/v1${path}`, {
        ...rest,
        headers: { ...(rest.headers ?? {}), ...(key === null ? {} : { 'x-api-key': key }) }
    });
};

const mcp = (token: string) =>
    app.request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });

describe('the gate', () => {
    it('answers 404 with a pointer when no key is configured', async () => {
        await seed({ keyed: false });
        const res = await api('/system/status');
        expect(res.status).toBe(404);
        expect(((await res.json()) as { message: string }).message).toContain('Generate a key on the config page');
    });

    it('answers 401 without a key or with a wrong one', async () => {
        expect((await api('/system/status', { key: null })).status).toBe(401);
        expect((await api('/system/status', { key: `amk_${'9'.repeat(64)}` })).status).toBe(401);
    });

    it('ignores a key in the query string', async () => {
        expect((await api(`/system/status?apikey=${KEY}`, { key: null })).status).toBe(401);
    });

    it('keeps the management key and MCP tokens apart', async () => {
        expect((await api('/system/status', { key: MCP })).status).toBe(401);
        expect((await mcp(KEY)).status).toBe(401);
        expect((await mcp(MCP)).status).toBe(200);
    });

    it('answers an unknown endpoint with 404 JSON', async () => {
        const res = await api('/nope');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ message: 'No such endpoint.' });
    });

    it('marks every answer no-store', async () => {
        expect((await api('/nope')).headers.get('cache-control')).toBe('no-store');
    });
});

const line = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ level: LEVELS.info, time: 1_786_000_000_000, app: 'arr-mcp', msg: 'hello', ...over });

describe('GET /system/status', () => {
    it('names the app, version and MCP URL', async () => {
        const body = (await (await api('/system/status')).json()) as Record<string, unknown>;
        expect(body.appName).toBe('arr-mcp');
        expect(typeof body.version).toBe('string');
        expect(body.mcpUrl).toBe('http://localhost:6060/mcp');
    });
});

describe('GET /health', () => {
    it('reports one entry per app, down ones included', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const res = await api('/health');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { app: string; type: string; ok: boolean; latencyMs: number; error?: { kind: string } }[];
        expect(body.map(h => h.app)).toEqual(['radarr/hd', 'transmission']);
        expect(body[0]).toMatchObject({ type: 'radarr', ok: false });
        expect(typeof body[0]?.latencyMs).toBe('number');
        expect(body[0]?.error?.kind).toBeDefined();
    });
});

describe('GET /log', () => {
    beforeEach(() => {
        logs.write(line({ msg: 'first' }));
        logs.write(line({ level: LEVELS.warn, service: 'radarr/hd', msg: 'slow', port: 7878 }));
        logs.write(line({ level: LEVELS.error, msg: 'broke' }));
    });

    it('returns records newest first with flattened fields', async () => {
        const { records } = (await (await api('/log')).json()) as {
            records: { id: number; level: string; app: string | null; message: string; fields: Record<string, string> }[];
        };
        expect(records.map(r => r.message)).toEqual(['broke', 'slow', 'first']);
        expect(records[1]).toMatchObject({ level: 'warn', app: 'radarr/hd', fields: { port: '7878' } });
    });

    it('filters by minimum level, app and cursor', async () => {
        const read = async (q: string) =>
            ((await (await api(`/log?${q}`)).json()) as { records: { id: number; message: string }[] }).records;
        expect((await read('level=warn')).map(r => r.message)).toEqual(['broke', 'slow']);
        expect((await read('app=radarr/hd')).map(r => r.message)).toEqual(['slow']);
        const all = await read('');
        const oldest = all[all.length - 1]?.id as number;
        expect((await read(`afterId=${oldest}`)).map(r => r.message)).toEqual(['broke', 'slow']);
        expect(await read('limit=1')).toHaveLength(1);
    });

    it('refuses a bad level, cursor or limit', async () => {
        for (const q of ['level=loud', 'afterId=-1', 'afterId=x', 'limit=0', 'limit=301']) {
            expect((await api(`/log?${q}`)).status, q).toBe(400);
        }
    });
});
