import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, type BootstrapDeps } from '../src/bootstrap.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { Sessions } from '../src/core/session.ts';

const fail = vi.hoisted(() => ({ build: false }));

vi.mock('../src/app.ts', async importOriginal => {
    const real = await importOriginal<typeof import('../src/app.ts')>();
    return {
        ...real,
        buildApp: (...args: Parameters<typeof real.buildApp>) => {
            if (fail.build) throw new Error('buildApp failed');
            return real.buildApp(...args);
        }
    };
});

let dir: string;
let deps: BootstrapDeps;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arr-mcp-bootstrap-'));
    await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: admin\n  allowed_hosts: []\nservices: {}\n', 'utf8');
    deps = {
        configDir: dir,
        audit: WriteAudit.ephemeral(),
        logs: LogStore.ephemeral(),
        sessions: new Sessions(),
        version: '1.2.3',
        port: 6060
    };
});

afterEach(async () => {
    vi.restoreAllMocks();
    fail.build = false;
    deps.audit.close();
    deps.logs.close();
    await rm(dir, { recursive: true, force: true });
});

describe('bootstrap', () => {
    it('closes the runtime it started when building the app throws', async () => {
        const close = vi.spyOn(Runtime.prototype, 'close');
        fail.build = true;
        await expect(bootstrap(deps)).rejects.toThrow('buildApp failed');
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes the runtime it serves when closed', async () => {
        const close = vi.spyOn(Runtime.prototype, 'close');
        await (await bootstrap(deps)).close();
        expect(close).toHaveBeenCalledTimes(1);
    });
});
