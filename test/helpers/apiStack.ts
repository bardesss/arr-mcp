import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config/load.ts';
import { WriteAudit } from '../../src/core/audit.ts';
import { LogStore } from '../../src/core/logs.ts';
import { hashToken } from '../../src/core/mcpTokens.ts';
import { Runtime } from '../../src/core/runtime.ts';

export const KEY = `amk_${'1'.repeat(64)}`;
export const MCP = `amcp_${'2'.repeat(64)}`;
export const RADARR_KEY = 'radarr-secret-key-0000';
export const TX_PASSWORD = 'tx-secret-password';

export const stack = {} as {
    dir: string;
    runtime: Runtime;
    app: ReturnType<typeof buildApp>;
    logs: LogStore;
    audit: WriteAudit;
};

let seeded = false;

export const seedApi = async (opts: { keyed?: boolean; radarrUrl?: string; extra?: string[] } = {}): Promise<void> => {
    await closeApi();
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-api-'));
    stack.dir = dir;
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
            `    - { name: hd, url: '${opts.radarrUrl ?? 'http://user:pw@radarr:7878'}', api_key: '${RADARR_KEY}' }`,
            `  transmission: { url: 'http://transmission:9091', username: tx, password: '${TX_PASSWORD}' }`,
            ...(opts.extra ?? []),
            ''
        ].join('\n'),
        'utf8'
    );
    const { config } = await loadConfig(dir);
    stack.audit = WriteAudit.ephemeral();
    stack.logs = LogStore.ephemeral();
    stack.runtime = Runtime.fromConfig(config, stack.audit, { configDir: dir });
    stack.app = buildApp({ runtime: stack.runtime, audit: stack.audit, logs: stack.logs });
    seeded = true;
};

/** Safe to call twice: seedApi calls it before replacing the stack. */
export const closeApi = async (): Promise<void> => {
    if (!seeded) return;
    seeded = false;
    // The dataset is a file in `dir`, and Windows will not remove an open one.
    stack.runtime.dataset?.close();
    stack.logs.close();
    stack.audit.close();
    await rm(stack.dir, { recursive: true, force: true });
};

export const api = (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const { key = KEY, ...rest } = init;
    return stack.app.request(`http://localhost:6060/api/v1${path}`, {
        ...rest,
        headers: { ...(rest.headers ?? {}), ...(key === null ? {} : { 'x-api-key': key }) }
    });
};

export const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
});

export const mcp = (token: string) =>
    stack.app.request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
