import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { fenceText } from '../src/core/fence.ts';
import { LogStore } from '../src/core/logs.ts';
import { PlayHistory } from '../src/core/playHistory.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';

describe('the Plays tab on the Logs page', () => {
    const PASSWORD = 'test-password-1234';
    let dir: string;
    let plays: PlayHistory;
    let audit: WriteAudit;
    let logs: LogStore;
    let cookie: string;
    let app: ReturnType<typeof buildApp>;

    const get = async (path: string) => (await app.request(`http://localhost:6060${path}`, { headers: { cookie } })).text();
    const post = (path: string, form: Record<string, string>) =>
        app.request(`http://localhost:6060${path}`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString()
        });
    const csrfOf = (html: string): string => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'arr-mcp-plays-'));
        plays = PlayHistory.ephemeral();
        audit = WriteAudit.ephemeral();
        logs = LogStore.ephemeral();
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  username: admin\n  password_hash: ${await hashPassword(PASSWORD)}\n  allowed_hosts: []\nservices:\n  jellyfin:\n    url: http://jellyfin.test:8096\n    api_key: ${'a'.repeat(32)}\n`,
            'utf8'
        );
        const { config } = await loadConfig(dir);
        app = buildApp({ runtime: Runtime.fromConfig(config, audit, { configDir: dir }), audit, logs, plays });
        const res = await app.request('http://localhost:6060/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: PASSWORD }).toString()
        });
        cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    });

    afterEach(async () => {
        plays.close();
        audit.close();
        logs.close();
        await rm(dir, { recursive: true, force: true });
    });

    it('is a tab on every Logs page', async () => {
        expect(await get('/ui/logs')).toContain('href="/ui/logs?stream=plays"');
    });

    it('says nothing is stored yet, and that the media server has not synced', async () => {
        const html = await get('/ui/logs?stream=plays');
        expect(html).toContain('Nothing stored yet');
        expect(html).toContain('jellyfin: not synced yet');
        expect(html).not.toContain('Clear stored plays');
    });

    it('shows counts, the sync time and the newest plays, unfenced and escaped', async () => {
        plays.record('jellyfin', { id: 'u1' }, [
            {
                entry: {
                    service: 'jellyfin',
                    kind: 'watched',
                    itemId: 'a',
                    title: fenceText('<b>Alpha</b>', { service: 'jellyfin', field: 'Name' }),
                    user: 'Sam',
                    removedFromLibrary: true,
                    lastPlayed: '2026-01-01T10:00:00.000Z'
                },
                kind: 'movie'
            }
        ]);
        plays.markSynced('jellyfin', '2026-01-02T10:00:00.000Z');

        const html = await get('/ui/logs?stream=plays');
        expect(html).toContain('last synced');
        expect(html).toContain('&lt;b&gt;Alpha&lt;/b&gt;');
        expect(html).not.toContain('untrusted');
        expect(html).toContain('removed from library');
        expect(html).toContain('Clear stored plays');
    });

    it('asks before clearing, then clears', async () => {
        plays.record('jellyfin', { id: 'u1' }, [{ entry: { service: 'jellyfin', kind: 'watched', itemId: 'a', title: 'Alpha', user: 'Sam' }, kind: 'movie' }]);
        const csrf = csrfOf(await get('/ui/logs?stream=plays'));

        const asked = await (await post('/ui/logs/plays/clear', { csrf })).text();
        expect(asked).toContain('Yes, clear 1 plays');
        expect(plays.summary()).toHaveLength(1);

        const done = await (await post('/ui/logs/plays/clear', { csrf, confirm: 'yes' })).text();
        expect(done).toContain('Cleared.');
        expect(plays.summary()).toEqual([]);
    });

    it('refuses a clear with a stale form', async () => {
        plays.record('jellyfin', { id: 'u1' }, [{ entry: { service: 'jellyfin', kind: 'watched', itemId: 'a', title: 'Alpha', user: 'Sam' }, kind: 'movie' }]);
        const res = await post('/ui/logs/plays/clear', { csrf: 'wrong', confirm: 'yes' });
        expect(res.status).toBe(403);
        expect(plays.summary()).toHaveLength(1);
    });
});
