import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
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
