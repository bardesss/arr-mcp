import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens, type WriteIntent } from '../src/core/confirm.ts';
import { Runtime } from '../src/core/runtime.ts';
import { closeServer, createShutdown } from '../src/shutdown.ts';

describe('createShutdown', () => {
    it('runs every step in order and exits 0, even after one throws', async () => {
        const ran: string[] = [];
        const exit = vi.fn();
        const shutdown = createShutdown(
            [
                { name: 'a', run: () => { ran.push('a'); } },
                { name: 'b', run: () => { ran.push('b'); throw new Error('boom'); } },
                { name: 'c', run: async () => { ran.push('c'); } }
            ],
            { exit, deadlineMs: 1000 }
        );
        await shutdown('SIGTERM');
        expect(ran).toEqual(['a', 'b', 'c']);
        expect(exit).toHaveBeenCalledWith(0);
    });

    it('exits 1 when a step outlasts the deadline', async () => {
        const exit = vi.fn();
        void createShutdown([{ name: 'stuck', run: () => new Promise(() => {}) }], { exit, deadlineMs: 20 })('SIGTERM');
        await new Promise(r => setTimeout(r, 80));
        expect(exit).toHaveBeenCalledWith(1);
    });

    it('runs the steps once for two signals', async () => {
        const run = vi.fn();
        const exit = vi.fn();
        const shutdown = createShutdown([{ name: 'a', run }], { exit, deadlineMs: 1000 });
        await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
        expect(run).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledTimes(1);
    });
});

describe('closeServer', () => {
    it('closes a server whose request never answers once the grace runs out', async () => {
        const server = createServer(() => {}); // never responds
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as AddressInfo).port;
        fetch(`http://127.0.0.1:${port}/`).catch(() => {});
        await new Promise(r => setTimeout(r, 50));
        const started = Date.now();
        await closeServer(server, 50);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});

describe('a closed runtime', () => {
    // The signing key is per ConfirmTokens instance. After a shutdown and a
    // fresh start, a token from the old process must read as "foreign" (issued
    // before a restart), not as a mismatch.
    it("leaves its confirm tokens foreign to a new process's", async () => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-shutdown-'));
        await writeFile(
            join(dir, 'config.yaml'),
            'auth:\n  bearer_token: ' + 'a'.repeat(64) + '\n  username: admin\n  allowed_hosts: []\nservices: {}\n',
            'utf8'
        );
        const audit = WriteAudit.ephemeral();
        try {
            const { config } = await loadConfig(dir);
            const runtime = Runtime.fromConfig(config, audit, { configDir: dir });
            const intent: WriteIntent = { tool: 'delete_media', service: 'radarr', tier: 'destructive', operation: 'delete_movie', target: '5' };
            const token = runtime.confirm.issue(intent);
            await runtime.close();

            const result = new ConfirmTokens().verifyAndConsume(token, intent);
            expect(result).toMatchObject({ ok: false, failure: 'foreign' });
        } finally {
            audit.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];
const outputs = new WeakMap<Readable, string>();

async function start(args: string[]): Promise<ChildProcessWithoutNullStreams> {
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-shutdown-'));
    dirs.push(dir);
    const child = spawn(process.execPath, ['src/index.ts', ...args], {
        cwd: ROOT,
        env: { ...process.env, ARR_MCP_CONFIG_DIR: dir, ARR_MCP_PORT: '0', LOG_LEVEL: 'info' }
    });
    children.push(child);
    for (const stream of [child.stdout, child.stderr]) {
        outputs.set(stream, '');
        stream.on('data', (chunk: Buffer) => outputs.set(stream, (outputs.get(stream) ?? '') + chunk.toString()));
    }
    return child;
}

const out = (child: ChildProcessWithoutNullStreams): string => outputs.get(child.stdout) ?? '';
const err = (child: ChildProcessWithoutNullStreams): string => outputs.get(child.stderr) ?? '';

async function waitFor(stream: Readable, text: string, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (!(outputs.get(stream) ?? '').includes(text)) {
        if (Date.now() > until) throw new Error(`timed out waiting for "${text}"; saw: ${outputs.get(stream)}`);
        await new Promise(r => setTimeout(r, 25));
    }
}

afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// Startup takes about two seconds alone, but a full parallel run on a loaded
// Windows machine has pushed it past 15 s. Neither test measures startup, so
// the banner wait is generous; only the shutdown is held to a time.
const BANNER_MS = 60_000;

describe('the server process', () => {
    it.skipIf(process.platform === 'win32')('exits 0 promptly on SIGTERM', async () => {
        const child = await start([]);
        await waitFor(child.stdout, 'arr-mcp listening', BANNER_MS);
        const sent = Date.now();
        child.kill('SIGTERM');
        const [code] = await once(child, 'exit');
        expect(code).toBe(0);
        expect(Date.now() - sent).toBeLessThan(3000);
        expect(out(child)).toContain('shut down cleanly');
    }, BANNER_MS + 15_000);

    // Runs on Windows too: closing stdin goes through the same shutdown.
    it('exits 0 promptly when a stdio client closes stdin', async () => {
        const child = await start(['--stdio']);
        await waitFor(child.stderr, 'arr-mcp serving MCP over stdio', BANNER_MS);
        child.stdin.end();
        const [code] = await once(child, 'exit');
        expect(code).toBe(0);
        expect(err(child)).toContain('shut down cleanly');
    }, BANNER_MS + 15_000);
});
