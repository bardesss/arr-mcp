import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteAudit } from '../src/core/audit.ts';
import { Runtime } from '../src/core/runtime.ts';

// The first load taken while `hold` is set reads the file, reports `read`, then waits for `hold`.
const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, read: undefined as (() => void) | undefined, calls: 0 }));

vi.mock('../src/config/load.ts', async importOriginal => {
    const real = await importOriginal<typeof import('../src/config/load.ts')>();
    return {
        ...real,
        loadConfig: async (dir: string, opts?: Parameters<typeof real.loadConfig>[1]) => {
            gate.calls += 1;
            const { hold, read } = gate;
            gate.hold = undefined;
            gate.read = undefined;
            const loaded = await real.loadConfig(dir, opts);
            read?.();
            if (hold !== undefined) await hold;
            return loaded;
        }
    };
});

const { loadConfig } = await import('../src/config/load.ts');

let audit: WriteAudit;
const dirs: string[] = [];

const seeded = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-reload-'));
    dirs.push(dir);
    await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: first\nservices: {}\n', 'utf8');
    const { config } = await loadConfig(dir);
    audit = WriteAudit.ephemeral();
    gate.calls = 0;
    return { dir, runtime: Runtime.fromConfig(config, audit, { configDir: dir }) };
};

const settle = () => new Promise(resolve => setImmediate(resolve));

afterEach(async () => {
    audit.close();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Runtime.reload', () => {
    it('runs overlapping reloads one after another, so the last one started wins', async () => {
        const { dir, runtime } = await seeded();
        let release = () => {};
        gate.hold = new Promise<void>(resolve => {
            release = resolve;
        });
        const read = new Promise<void>(resolve => {
            gate.read = resolve;
        });

        const first = runtime.reload();
        await read;
        await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: second\nservices: {}\n', 'utf8');
        const second = runtime.reload();
        for (let i = 0; i < 5; i++) await settle();
        expect(gate.calls).toBe(1);

        release();
        await Promise.all([first, second]);
        expect(runtime.config.auth.username).toBe('second');
    });

    it('does not let a failed reload block the next one', async () => {
        const { dir, runtime } = await seeded();
        await writeFile(join(dir, 'config.yaml'), 'auth: [broken\n', 'utf8');
        const failed = runtime.reload();
        await expect(failed).rejects.toThrow();
        await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: fixed\nservices: {}\n', 'utf8');
        await runtime.reload();
        expect(runtime.config.auth.username).toBe('fixed');
    });
});
