import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteAudit } from '../src/core/audit.ts';
import { Runtime } from '../src/core/runtime.ts';

// The first load taken while `hold` is set reads the file, reports `read`, then waits for `hold`.
const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, read: undefined as (() => void) | undefined, calls: 0, failBuild: false }));

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

vi.mock('../src/services/registry.ts', async importOriginal => {
    const real = await importOriginal<typeof import('../src/services/registry.ts')>();
    return {
        ...real,
        buildAdapters: (config: Parameters<typeof real.buildAdapters>[0]) => {
            if (gate.failBuild) throw new Error('build failed');
            return real.buildAdapters(config);
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
    gate.failBuild = false;
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

    it('keeps sessions and the old snapshot when building the new one throws', async () => {
        const { dir, runtime } = await seeded();
        const token = runtime.sessions.issue();
        await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: first\n  password_hash: scrypt$00$11\nservices: {}\n', 'utf8');
        gate.failBuild = true;
        await expect(runtime.reload()).rejects.toThrow('build failed');
        expect(runtime.sessions.verify(token)).toEqual({ valid: true });
        expect(runtime.config.auth.password_hash).toBeUndefined();
    });

    it('opens no dataset and starts no refresh when building the new snapshot throws', async () => {
        const { dir } = await seeded();
        const refresh = vi.fn(() => () => {});
        const { config } = await loadConfig(dir);
        const runtime = Runtime.fromConfig(config, audit, { configDir: dir, refresh });
        await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: first\nservices: {}\nmetadata:\n  imdb:\n    enabled: true\n', 'utf8');
        gate.failBuild = true;
        await expect(runtime.reload()).rejects.toThrow('build failed');
        expect(refresh).not.toHaveBeenCalled();
        expect(runtime.dataset).toBeUndefined();
    });
});
