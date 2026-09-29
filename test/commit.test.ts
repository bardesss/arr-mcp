import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitConfig } from '../src/config/commit.ts';
import { loadConfig } from '../src/config/load.ts';
import { ConfigDriftError, ConfigUnloadableError } from '../src/config/save.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { logger } from '../src/core/logger.ts';
import { Runtime } from '../src/core/runtime.ts';

let audit: WriteAudit;

const seeded = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-commit-'));
    await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: admin\nservices: {}\n', 'utf8');
    const { config } = await loadConfig(dir);
    audit = WriteAudit.ephemeral();
    return { dir, runtime: Runtime.fromConfig(config, audit, { configDir: dir }) };
};

afterEach(() => {
    vi.restoreAllMocks();
    audit.close();
});

describe('commitConfig', () => {
    it('saves and reloads', async () => {
        const { dir, runtime } = await seeded();
        const expected = runtime.config;
        await commitConfig(runtime, expected, { ...expected, auth: { ...expected.auth, username: 'owner' } });
        expect(runtime.config.auth.username).toBe('owner');
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('owner');
    });

    it('refuses with a ConfigDriftError when the file changed underneath, then picks the file up', async () => {
        const { dir, runtime } = await seeded();
        const expected = runtime.config;
        await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: someone-else\nservices: {}\n', 'utf8');
        await expect(
            commitConfig(runtime, expected, { ...expected, auth: { ...expected.auth, username: 'owner' } })
        ).rejects.toBeInstanceOf(ConfigDriftError);
        expect(runtime.config.auth.username).toBe('someone-else');
        expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('someone-else');
    });

    it('keeps the old config when the hand edit does not load, and still refuses', async () => {
        const { dir, runtime } = await seeded();
        const expected = runtime.config;
        const warn = vi.spyOn(logger, 'warn');
        await writeFile(join(dir, 'config.yaml'), 'auth:\n  username: [broken\nservices: 5\n', 'utf8');
        await expect(
            commitConfig(runtime, expected, { ...expected, auth: { ...expected.auth, username: 'owner' } })
        ).rejects.toBeInstanceOf(ConfigUnloadableError);
        expect(runtime.config).toBe(expected);
        expect(warn).toHaveBeenCalled();
    });
});
