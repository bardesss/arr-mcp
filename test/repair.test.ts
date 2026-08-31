import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { Runtime } from '../src/core/runtime.ts';
import { Sessions } from '../src/core/session.ts';

const BEARER = 'a'.repeat(64);

const seedDir = async (text: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-repair-'));
    await writeFile(join(dir, 'config.yaml'), text, 'utf8');
    return dir;
};

describe('Runtime session injection', () => {
    it('uses the Sessions instance it is given, so a token survives a rebuild', async () => {
        const dir = await seedDir(
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices: {}\n`
        );
        const audit = WriteAudit.ephemeral();
        const sessions = new Sessions();
        const token = sessions.issue();

        const { runtime } = await Runtime.start(dir, audit, { sessions });

        expect(runtime.sessions).toBe(sessions);
        expect(runtime.sessions.verify(token).valid).toBe(true);
        audit.close();
    });

    it('still builds its own when none is given', async () => {
        const dir = await seedDir(
            `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices: {}\n`
        );
        const audit = WriteAudit.ephemeral();
        const { config } = await loadConfig(dir);
        const runtime = Runtime.fromConfig(config, audit, { configDir: dir });

        expect(runtime.sessions).toBeInstanceOf(Sessions);
        audit.close();
    });
});
