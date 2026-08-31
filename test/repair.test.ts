import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { Runtime } from '../src/core/runtime.ts';
import { Sessions } from '../src/core/session.ts';
import { repairPage, unreadableAuthPage } from '../src/web/repairPage.ts';

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

describe('repair pages', () => {
    const detail = 'services.radarr.url\n  ✖ must be an http:// or https:// URL';

    it('renders the error and the file in an editable form', () => {
        const page = repairPage({ version: '1.2.3', raw: 'auth:\n  username: admin\n', detail, csrf: 'tok' });
        expect(page).toContain('must be an http');
        expect(page).toContain('<textarea');
        expect(page).toContain('name="config"');
        expect(page).toContain('value="tok"');
    });

    it('escapes the file rather than injecting it into the document', () => {
        const page = repairPage({ version: '1.2.3', raw: 'note: </textarea><script>x()</script>', detail, csrf: 'tok' });
        expect(page).not.toContain('<script>x()</script>');
        expect(page).toContain('&lt;/textarea&gt;');
    });

    // The page is the operator's only route back in, so a nav bar of links to
    // pages that do not exist in this mode would be a lie.
    it('renders no navigation', () => {
        expect(repairPage({ version: '1.2.3', raw: '', detail, csrf: 'tok' })).not.toContain('<nav>');
    });

    it('shows the error alone when auth is unreadable, with no way to submit', () => {
        const page = unreadableAuthPage({ version: '1.2.3', detail: 'auth\n  ✖ Invalid input' });
        expect(page).toContain('Invalid input');
        expect(page).not.toContain('<textarea');
        expect(page).not.toContain('<form');
    });
});
