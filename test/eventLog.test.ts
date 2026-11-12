import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { WebhookEvents } from '../src/core/webhookEvents.ts';
import { parseArrWebhook } from '../src/services/arrWebhook.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildDiagnose } from '../src/tools/diagnose/index.ts';
import { buildGetHistory, historyLine, readEventLog } from '../src/tools/getHistory.ts';
import { LibraryLoader } from '../src/tools/library.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'webhooks');
const fixture = async (service: string, event: string): Promise<unknown> =>
    JSON.parse(await readFile(join(FIXTURES, service, `${event}.json`), 'utf8'));

const stub = (id: string, extra: Record<string, unknown> = {}): ServiceAdapter =>
    ({
        id,
        type: id.split('/')[0],
        instance: id.split('/')[1],
        testConnection: async () => ({ ok: true, service: id, latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        ...extra
    }) as unknown as ServiceAdapter;

const recently = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

/** Real captured payloads, through the real parser, so these rows are what the route stores. */
async function storeCaptured(store: WebhookEvents, service: 'radarr' | 'sonarr', event: string, at: string, instance: string = service) {
    const entry = parseArrWebhook(instance, service === 'radarr' ? 'movie' : 'series', await fixture(service, event), at);
    if (entry === undefined) throw new Error(`${event} did not parse`);
    store.record(entry, 30);
}

describe('get_history over the event log', () => {
    let store: WebhookEvents;
    const adapters = [
        stub('radarr', { readHistory: async () => ({ items: [], total: 0 }) }),
        stub('sonarr', { readHistory: async () => ({ items: [], total: 0 }) }),
        stub('jellyfin')
    ];
    const read = (opts: Parameters<typeof readEventLog>[2] = { detail: 'standard', limit: 50 }, enabled = true) =>
        readEventLog(adapters, { store, enabled }, opts);

    beforeEach(() => {
        store = WebhookEvents.ephemeral();
    });
    afterEach(() => store.close());

    it('leaves get_history unchanged by default: no stored row appears', async () => {
        await storeCaptured(store, 'radarr', 'MovieDelete', recently(1));
        const result = await buildGetHistory(adapters, { detail: 'standard', limit: 50 });
        expect(result.total).toBe(0);
        expect(result.items).toEqual([]);
    });

    it('reads stored events newest first, with a count per service', async () => {
        await storeCaptured(store, 'radarr', 'Grab', recently(3));
        await storeCaptured(store, 'radarr', 'MovieDelete', recently(1));
        await storeCaptured(store, 'sonarr', 'SeriesDelete', recently(2));

        const result = read();
        expect(result.items.map(i => i.service)).toEqual(['radarr', 'sonarr', 'radarr']);
        expect(result.total).toBe(3);
        expect(result.counts).toEqual({ radarr: 2, sonarr: 1 });
        expect(result.degraded).toEqual([]);
    });

    it('honours service, id, since, event type and paging', async () => {
        await storeCaptured(store, 'radarr', 'Grab', recently(48));
        await storeCaptured(store, 'radarr', 'MovieDelete', recently(1));
        await storeCaptured(store, 'sonarr', 'SeriesDelete', recently(2));

        expect(read({ service: 'sonarr', detail: 'standard', limit: 50 }).total).toBe(1);
        expect(read({ service: 'radarr', id: '1230', eventType: 'deleted', detail: 'standard', limit: 50 }).total).toBe(1);
        expect(read({ eventType: 'deleted', detail: 'standard', limit: 50 }).total).toBe(2);
        expect(read({ since: recently(24), detail: 'standard', limit: 50 }).total).toBe(2);

        const page = read({ detail: 'standard', limit: 1, offset: 1 });
        expect(page).toMatchObject({ total: 3, returned: 1, offset: 1, truncated: true });
        expect(page.items[0]?.service).toBe('sonarr');
    });

    it('reads every instance of a service when none is named, as get_history does', async () => {
        const two = [stub('radarr/a'), stub('radarr/b'), stub('sonarr')];
        await storeCaptured(store, 'radarr', 'Grab', recently(3), 'radarr/a');
        await storeCaptured(store, 'radarr', 'MovieDelete', recently(2), 'radarr/b');
        await storeCaptured(store, 'sonarr', 'SeriesDelete', recently(1));

        const result = readEventLog(two, { store, enabled: true }, { service: 'radarr', detail: 'standard', limit: 50 });
        expect(result.items.map(i => i.service)).toEqual(['radarr/b', 'radarr/a']);
        expect(result.counts).toEqual({ 'radarr/a': 1, 'radarr/b': 1 });

        const one = readEventLog(two, { store, enabled: true }, { service: 'radarr', instance: 'b', detail: 'standard', limit: 50 });
        expect(one.items.map(i => i.service)).toEqual(['radarr/b']);
    });

    it('still asks which instance an id belongs to, because each has its own ids', () => {
        const two = [stub('radarr/a'), stub('radarr/b')];
        expect(() => readEventLog(two, { store, enabled: true }, { service: 'radarr', id: '1230', detail: 'standard', limit: 50 })).toThrow(/instance/);
    });

    it('needs a service alongside an id, because ids of different services share numbers', () => {
        expect(() => read({ id: '1230', detail: 'standard', limit: 50 })).toThrow(/service/);
    });

    it('refuses a service that never sends events, rather than answering empty', () => {
        expect(() => read({ service: 'jellyfin', detail: 'standard', limit: 50 })).toThrow(/radarr, sonarr and lidarr/i);
    });

    it('says the log is off, on an empty answer', () => {
        const result = read(undefined, false);
        expect(result.total).toBe(0);
        expect(result.note).toMatch(/off/);
    });

    it('still returns what was kept while the log is off, and says it is off', async () => {
        await storeCaptured(store, 'radarr', 'MovieDelete', recently(1));
        const result = read(undefined, false);
        expect(result.total).toBe(1);
        expect(result.note).toMatch(/off/);
    });

    it('asks the store twice for an answer with rows', async () => {
        await storeCaptured(store, 'radarr', 'Grab', recently(1));
        const reads = vi.spyOn(store, 'read');
        const counts = vi.spyOn(store, 'counts');
        read();
        expect(reads).toHaveBeenCalledTimes(1);
        expect(counts).toHaveBeenCalledTimes(1);
    });

    it('asks once more only when a filter matched nothing', async () => {
        await storeCaptured(store, 'radarr', 'Grab', recently(1));
        const counts = vi.spyOn(store, 'counts');
        const result = read({ service: 'sonarr', detail: 'standard', limit: 50 });
        expect(result.total).toBe(0);
        expect(counts).toHaveBeenCalledTimes(2);
        expect(result.note).toBeUndefined();
    });

    it('says nothing has arrived when the log is on and empty', () => {
        expect(read().note).toMatch(/connection/);
    });

    it('adds no note to an ordinary answer, or to a filter that matched nothing', async () => {
        await storeCaptured(store, 'radarr', 'MovieDelete', recently(1));
        expect(read().note).toBeUndefined();
        expect(read({ service: 'sonarr', detail: 'standard', limit: 50 }).note).toBeUndefined();
    });

    it('reports an unreadable store as degraded, not as no events', () => {
        store.close();
        const result = read();
        expect(result.degraded).toEqual(['event-log']);
        expect(result.items).toEqual([]);
        expect(result.note).toBeUndefined();
        store = WebhookEvents.ephemeral();
    });

    it('treats no store at all as off', () => {
        const result = readEventLog(adapters, undefined, { detail: 'standard', limit: 50 });
        expect(result.total).toBe(0);
        expect(result.note).toMatch(/off/);
    });

    it('keeps the delete reason and external ids at standard detail, and the spelling of an unknown event', async () => {
        await storeCaptured(store, 'radarr', 'MovieDelete', recently(2));
        store.record({ service: 'radarr', at: recently(1), event: 'unknown', rawEvent: 'Health', title: '' }, 30);

        const [health, deleted] = read().items;
        expect(health?.rawEvent).toBe('Health');
        expect(deleted?.externalIds).toEqual({ tmdb: 1182047, imdb: 'tt8368368' });
        expect(historyLine(deleted as NonNullable<typeof deleted>)).toContain('files deleted');
        expect(historyLine(health as NonNullable<typeof health>)).toContain('Health');
    });
});

describe('diagnose over the event log', () => {
    const stack = (events?: WebhookEvents) => {
        const adapters = [stub('radarr', { listLibrary: async () => [], getQueue: async () => [] })];
        return { adapters, library: new LibraryLoader(adapters, undefined), ...(events === undefined ? {} : { events }) };
    };

    it('finds a film deleted from Radarr through its stored event', async () => {
        const events = WebhookEvents.ephemeral();
        const at = recently(1);
        await storeCaptured(events, 'radarr', 'Grab', recently(5));
        await storeCaptured(events, 'radarr', 'MovieDelete', at);

        const result = await buildDiagnose(stack(events), { query: 'The Apprentice' });
        expect(result.verdict.stage).toBe('resolve');
        expect(result.verdict.summary).toContain('radarr reported deleting');
        expect(result.verdict.summary).toContain('The Apprentice');
        expect(result.verdict.summary).toContain(at.slice(0, 10));
        expect(result.verdict.summary).toContain('files deleted');
        expect(result.verdict.remedy).toContain('source: "webhooks"');
        expect(result.verdict.certain).toBe(true);
        expect(result.history?.some(h => h.rawEvent === 'MovieDelete')).toBe(true);
        events.close();
    });

    it('words a removed file differently from a removed title', async () => {
        const events = WebhookEvents.ephemeral();
        await storeCaptured(events, 'radarr', 'MovieFileDelete', recently(1));
        const result = await buildDiagnose(stack(events), { query: 'The Apprentice' });
        expect(result.verdict.summary).toContain('reported deleting the file of');
        events.close();
    });

    it('leaves out events older than 30 days', async () => {
        const events = WebhookEvents.ephemeral();
        await storeCaptured(events, 'radarr', 'MovieDelete', recently(1));
        const old = parseArrWebhook('radarr', 'movie', await fixture('radarr', 'MovieDelete'), recently(24 * 40));
        // Longer retention than the window, so only diagnose's own window can drop it.
        events.record(old as NonNullable<typeof old>, 90);
        const result = await buildDiagnose(stack(events), { query: 'The Apprentice' });
        expect(result.history).toHaveLength(1);
        events.close();
    });

    it('does not match another title', async () => {
        const events = WebhookEvents.ephemeral();
        await storeCaptured(events, 'radarr', 'MovieDelete', recently(1));
        const result = await buildDiagnose(stack(events), { query: 'Some Other Film' });
        expect(result.verdict.summary).toContain('Nothing in your stack matches');
        expect(result.history).toBeUndefined();
        events.close();
    });

    it('stays correct when the store cannot be read', async () => {
        const events = WebhookEvents.ephemeral();
        events.close();
        const result = await buildDiagnose(stack(events), { query: 'The Apprentice' });
        expect(result.verdict.certain).toBe(false);
        expect(result.degraded).toContain('event-log');
    });

    it('answers as before with no store', async () => {
        const result = await buildDiagnose(stack(), { query: 'The Apprentice' });
        expect(result.verdict.summary).toContain('Nothing in your stack matches');
        expect(result.verdict.certain).toBe(true);
    });
});

describe('the events tab on the Logs page', () => {
    const PASSWORD = 'test-password-1234';
    let dir: string;
    let events: WebhookEvents;
    let audit: WriteAudit;
    let logs: LogStore;
    let cookie: string;
    let app: ReturnType<typeof buildApp>;

    const seed = async (webhooks: string) => {
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  username: admin\n  password_hash: ${await hashPassword(PASSWORD)}\n  allowed_hosts: []\nservices:\n  radarr:\n    url: http://radarr.test:7878\n    api_key: ${'a'.repeat(32)}\n${webhooks}`,
            'utf8'
        );
        const { config } = await loadConfig(dir);
        app = buildApp({ runtime: Runtime.fromConfig(config, audit, { configDir: dir }), audit, logs, events });
        const res = await app.request('http://localhost:6060/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: PASSWORD }).toString()
        });
        cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    };
    const ON = `webhooks:\n  enabled: true\n  secret: ${'s'.repeat(40)}\n  retention_days: 14\n`;
    const page = async (path: string) =>
        (await app.request(`http://localhost:6060${path}`, { headers: { cookie } })).text();

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'arr-mcp-eventlog-'));
        events = WebhookEvents.ephemeral();
        audit = WriteAudit.ephemeral();
        logs = LogStore.ephemeral();
    });
    afterEach(async () => {
        try {
            events.close();
        } catch {
            // Closed by the test that reads a broken store.
        }
        audit.close();
        logs.close();
        await rm(dir, { recursive: true, force: true });
    });

    it('sits next to the log tabs', async () => {
        await seed(ON);
        const logPage = await page('/ui/logs');
        expect(logPage).toContain('href="/ui/logs?stream=events"');
        expect(logPage).toContain('id="log-stream"');
    });

    it('shows stored events in columns of their own, without the fences', async () => {
        await seed(ON);
        await storeCaptured(events, 'radarr', 'MovieDelete', recently(1));
        const html = await page('/ui/logs?stream=events');
        expect(html).toContain('The Apprentice');
        expect(html).not.toContain('untrusted');
        expect(html).toContain('files deleted');
        expect(html).toContain('<th>Event</th>');
        expect(html).toContain('14 days');
    });

    it('leaves out the ring-buffer note and the auto-refresh, which are about log lines', async () => {
        await seed(ON);
        const html = await page('/ui/logs?stream=events');
        expect(html).not.toContain('ring buffer');
        expect(html).not.toContain('id="follow"');
        expect(html).not.toContain('id="log-stream"');
    });

    it('escapes a hostile title', async () => {
        await seed(ON);
        events.record({ service: 'radarr', at: recently(1), event: 'grabbed', title: '<script>alert(1)</script>' }, 30);
        const html = await page('/ui/logs?stream=events');
        expect(html).not.toContain('<script>alert(1)');
    });

    it('says when the log is off and points to the config page', async () => {
        await seed('');
        const html = await page('/ui/logs?stream=events');
        expect(html).toMatch(/is off/);
        expect(html).toContain('href="/ui/config?tab=settings#webhooks"');
    });

    it('says when nothing has arrived yet', async () => {
        await seed(ON);
        expect(await page('/ui/logs?stream=events')).toContain('Nothing has arrived yet');
    });

    it('says when the store cannot be read', async () => {
        await seed(ON);
        events.close();
        expect(await page('/ui/logs?stream=events')).toContain('could not be read');
    });

    it('requires a session', async () => {
        await seed(ON);
        const res = await app.request('http://localhost:6060/ui/logs?stream=events');
        expect(res.status).toBe(302);
    });
});

describe('statement preparation', () => {
    it('prepares nothing per recorded event', async () => {
        const events = WebhookEvents.ephemeral();
        const entry = parseArrWebhook('radarr', 'movie', await fixture('radarr', 'Grab'), recently(1));
        if (entry === undefined) throw new Error('Grab did not parse');
        const prepare = vi.spyOn(Database.prototype, 'prepare');
        try {
            events.record(entry, 30);
            events.record(entry, 30);
            expect(prepare).not.toHaveBeenCalled();
        } finally {
            prepare.mockRestore();
            events.close();
        }
    });
});
