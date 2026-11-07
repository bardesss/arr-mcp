import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import { instancesOf } from './helpers/instances.ts';
import type { AnyServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { registerGrabRelease } from '../src/tools/grabRelease.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerRemoveQueueItem } from '../src/tools/removeQueueItem.ts';
import { registerRetryDownload } from '../src/tools/retryDownload.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { anonymiseShelfmarkConfig, anonymiseShelfmarkHistory, anonymiseShelfmarkReleases, anonymiseShelfmarkSearch, anonymiseShelfmarkSnapshot, anonymiseShelfmarkStatus } from '../scripts/lib/shelfmarkCapture.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { ShelfmarkAdapter } from '../src/services/shelfmark.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/shelfmark', `${name}.json`), 'utf8'));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Answers = Record<string, () => Response>;
/** Every route answers its captured body unless `answers` overrides it. */
function server(answers: Answers = {}) {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        const answer = answers[path];
        if (answer !== undefined) return answer();
        return json(fixture(path.replace('/api/', '').replace('/', '-')));
    });
    return fetchImpl;
}

const adapter = (fetchImpl: typeof fetch, api_key?: string) =>
    new ShelfmarkAdapter(
        ConfigSchema.parse({
            auth: { bearer_token: 'a'.repeat(64) },
            services: { shelfmark: { url: 'http://shelfmark:8084', ...(api_key === undefined ? {} : { api_key }) } }
        }).services.shelfmark as never,
        fetchImpl
    );

const headersOf = (mock: ReturnType<typeof server>, path: string) => {
    const call = mock.mock.calls.find(c => new URL(String(c[0])).pathname === path) as unknown as [string, RequestInit];
    return new Headers(call[1].headers);
};

const READ_ONLY: Answers = {
    '/api/config': () => json({ error: 'This API key is read-only' }, 403),
    '/api/status': () => json({ error: 'This API key is read-only' }, 403)
};

/** The captured task, moved to another bucket. Its shape is the same for every status (`_task_to_dict`). */
function statusWith(bucket: string, changes: Record<string, unknown>) {
    const status = fixture('status') as Record<string, Record<string, Record<string, unknown>>>;
    const emptied = Object.fromEntries(Object.keys(status).map(key => [key, {}]));
    const [id, task] = Object.values(status).flatMap(tasks => Object.entries(tasks))[0] as [string, Record<string, unknown>];
    return { ...emptied, [bucket]: { [id]: { ...task, status: bucket, ...changes } } };
}

describe('connection', () => {
    it('connects with no key on a Shelfmark with no authentication, and reads the version', async () => {
        const fetchImpl = server();
        const result = await adapter(fetchImpl as typeof fetch).testConnection();
        expect(result).toMatchObject({ ok: true, version: 'v1.6.1' });
        expect(headersOf(fetchImpl, '/api/stats').has('X-Api-Key')).toBe(false);
    });

    it('sends a configured key', async () => {
        const fetchImpl = server();
        await adapter(fetchImpl as typeof fetch, 'k').testConnection();
        expect(headersOf(fetchImpl, '/api/stats').get('X-Api-Key')).toBe('k');
    });

    it('connects with a read-only key and no version', async () => {
        const result = await adapter(server(READ_ONLY) as typeof fetch, 'ro').testConnection();
        expect(result.ok).toBe(true);
        expect(result.version).toBeUndefined();
    });

    it('asks for a key when authentication is on', async () => {
        const result = await adapter(server({ '/api/stats': () => json({ error: 'Unauthorized' }, 401) }) as typeof fetch).testConnection();
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe('AuthFailed');
        expect(result.error?.remedy).toContain('SHELFMARK_API_KEY_READONLY');
    });

    it('refuses a server too old to have /api/stats', async () => {
        const result = await adapter(server({ '/api/stats': () => json({ error: 'Resource not found' }, 404) }) as typeof fetch).testConnection();
        expect(result.error?.kind).toBe('VersionUnsupported');
    });

    it('refuses a release below the floor', async () => {
        const result = await adapter(server({ '/api/config': () => json({ release_version: 'v1.4.0' }) }) as typeof fetch).testConnection();
        expect(result.error?.kind).toBe('VersionUnsupported');
    });

    it('reads N/A, a build with no release version, as no version', async () => {
        const result = await adapter(server({ '/api/config': () => json({ release_version: 'N/A' }) }) as typeof fetch).testConnection();
        expect(result.ok).toBe(true);
        expect(result.version).toBeUndefined();
    });

    it('asks an admin route once with a read-only key, because a 403 counts toward the circuit breaker', async () => {
        const fetchImpl = server(READ_ONLY);
        const shelfmark = adapter(fetchImpl as typeof fetch, 'ro');
        for (let i = 0; i < 8; i += 1) expect((await shelfmark.testConnection()).ok).toBe(true);
        expect(fetchImpl.mock.calls.filter(c => new URL(String(c[0])).pathname === '/api/config')).toHaveLength(1);
    });
});

describe('stack_health', () => {
    it('finds nothing on the captured healthy server', async () => {
        await expect(adapter(server() as typeof fetch).getFailedHealthChecks()).resolves.toEqual([]);
    });

    it('reports a stopped coordinator as a finding, not a failed read', async () => {
        const findings = await adapter(server({ '/api/health': () => json({ status: 'error', coordinator: 'stopped' }, 503) }) as typeof fetch).getFailedHealthChecks();
        expect(findings).toEqual([expect.objectContaining({ service: 'shelfmark', source: 'coordinator', type: 'error' })]);
    });

    it('reports failed downloads from the last 7 days', async () => {
        const stats = { ...(fixture('stats') as object), errors: { failed_7d: 3 } };
        const findings = await adapter(server({ '/api/stats': () => json(stats) }) as typeof fetch).getFailedHealthChecks();
        expect(findings).toEqual([expect.objectContaining({ source: 'downloads', type: 'warning', message: '3 download(s) failed in the last 7 days' })]);
    });

    it('never sends the key to the public health route', async () => {
        const fetchImpl = server();
        await adapter(fetchImpl as typeof fetch, 'ro').getFailedHealthChecks();
        expect(headersOf(fetchImpl, '/api/health').has('X-Api-Key')).toBe(false);
        expect(headersOf(fetchImpl, '/api/stats').get('X-Api-Key')).toBe('ro');
    });
});

describe('get_queue', () => {
    it('is about books, so diagnose leaves it out', () => {
        expect(adapter(server() as typeof fetch).queueKind).toBe('book');
    });

    it('leaves out a finished or cancelled book', async () => {
        for (const bucket of ['complete', 'cancelled']) {
            await expect(adapter(server({ '/api/status': () => json(statusWith(bucket, {})) }) as typeof fetch).getQueue()).resolves.toEqual([]);
        }
    });

    it('lists the captured book in progress, fenced, under a hashed id', async () => {
        const [item] = await adapter(server() as typeof fetch).getQueue();
        expect(item).toMatchObject({ service: 'shelfmark', status: 'resolving' });
        expect(item?.id).toMatch(/^[0-9a-f]{32}$/);
        expect(item?.title).toContain('Pride and Prejudice by Jane Austen');
        expect(item?.errorMessage).toBeUndefined();
    });

    it('never passes on a task id, which on a Prowlarr row is the indexer URL', async () => {
        const url = 'http://indexer/api?apikey=SECRET';
        const status = { ...statusWith('queued', {}), queued: { [url]: { title: 'T', id: url } } };
        const queue = await adapter(server({ '/api/status': () => json(status) }) as typeof fetch).getQueue();
        expect(queue).toHaveLength(1);
        expect(JSON.stringify(queue)).not.toContain('SECRET');
    });

    it('says why a failed download failed, without any address it quotes', async () => {
        const message = 'No sources left after http://indexer/api?apikey=SECRET timed out';
        const [item] = await adapter(server({ '/api/status': () => json(statusWith('error', { status_message: message })) }) as typeof fetch).getQueue();
        expect(item?.status).toBe('error');
        expect(item?.errorMessage).toContain('No sources left after [url] timed out');
        expect(item?.errorMessage).not.toContain('SECRET');
    });

    it('fails rather than claims an empty queue with a read-only key, and asks only once', async () => {
        const fetchImpl = server(READ_ONLY);
        const shelfmark = adapter(fetchImpl as typeof fetch, 'ro');
        for (let i = 0; i < 2; i += 1) await expect(shelfmark.getQueue()).rejects.toMatchObject({ kind: 'AuthFailed', remedy: expect.stringContaining('SHELFMARK_API_KEY') });
        expect(fetchImpl.mock.calls.filter(c => new URL(String(c[0])).pathname === '/api/status')).toHaveLength(1);
    });
});

describe('finding a book', () => {
    const ID = 'googlebooks:5neBQgAACAAJ';
    const releasesPath = '/api/releases';

    it('finds books for discover only, with an id get_releases takes', async () => {
        const shelfmark = adapter(server() as typeof fetch);
        await expect(shelfmark.search('dutch', 'library')).resolves.toEqual([]);
        const [hit] = await shelfmark.search('dutch', 'discover');
        expect(hit).toMatchObject({ service: 'shelfmark', source: 'discover', kind: 'book', id: ID, year: 1998 });
        expect(hit?.title).toContain('The Dutch Republic by Jonathan Irvine Israel');
    });

    it('answers no books with a read-only key, and asks only once', async () => {
        const fetchImpl = server({ '/api/metadata/search': () => json({ error: 'This API key is read-only' }, 403) });
        const shelfmark = adapter(fetchImpl as typeof fetch, 'ro');
        for (let i = 0; i < 2; i += 1) await expect(shelfmark.search('dutch', 'discover')).resolves.toEqual([]);
        expect(fetchImpl.mock.calls.filter(c => new URL(String(c[0])).pathname === '/api/metadata/search')).toHaveLength(1);
    });

    it('lists releases with a guid grab_release can bind to, fenced', async () => {
        const rows = await adapter(server() as typeof fetch).findReleases({ id: ID });
        expect(rows[0]).toMatchObject({ indexerId: 0, quality: 'pdf', language: 'en', protocol: 'http', rejected: false });
        expect(rows[0]?.guid).toMatch(/^direct_download:[0-9a-f]{32}$/);
        expect(rows[0]?.title).toContain('The Dutch Republic');
        const nzb = rows.find(r => r.protocol === 'nzb');
        expect(nzb?.sizeBytes).toBe(19390485);
        expect(rows[0]?.sizeBytes).toBeGreaterThan(0);
    });

    it('never passes on a download URL, which can hold an indexer key', async () => {
        // On a live v1.6.1, a Prowlarr row's source_id is the indexer's URL too.
        const body = { releases: [{ source: 'prowlarr', source_id: 'http://indexer/api?apikey=SECRET', title: 'T', download_url: 'http://indexer/get?apikey=SECRET', info_url: 'http://indexer/SECRET', extra: { k: 'SECRET' } }] };
        const rows = await adapter(server({ [releasesPath]: () => json(body) }) as typeof fetch).findReleases({ id: ID });
        expect(JSON.stringify(rows)).not.toContain('SECRET');
    });

    it('reuses a recent listing, so a grab preview does not repeat a long search', async () => {
        const fetchImpl = server();
        const shelfmark = adapter(fetchImpl as typeof fetch);
        await shelfmark.findReleases({ id: ID });
        await shelfmark.findReleases({ id: ID });
        expect(fetchImpl.mock.calls.filter(c => new URL(String(c[0])).pathname === releasesPath)).toHaveLength(1);
    });

    it('refuses something that is not a book id, and series scopes', async () => {
        const shelfmark = adapter(server() as typeof fetch);
        await expect(shelfmark.findReleases({ id: '42' })).rejects.toMatchObject({ kind: 'NotFound' });
        await expect(shelfmark.findReleases({ id: ID, season: 1 })).rejects.toThrow(/series/);
    });

    it('refuses an album rather than searching the whole book', async () => {
        const fetchImpl = server();
        await expect(adapter(fetchImpl as typeof fetch).findReleases({ id: ID, album: '15' })).rejects.toThrow(/Lidarr artist/);
        expect(fetchImpl.mock.calls).toHaveLength(0);
    });
});

describe('grabbing a release', () => {
    const ID = 'googlebooks:5neBQgAACAAJ';
    const GUID = 'direct_download:00000000000000000000000000000000';

    it('sends back the whole row it listed', async () => {
        const fetchImpl = server({ '/api/releases/download': () => json(fixture('download')) });
        const shelfmark = adapter(fetchImpl as typeof fetch);
        const [row] = await shelfmark.findReleases({ id: ID });
        await shelfmark.grabRelease({ guid: row?.guid as string, indexerId: 0 });
        const call = fetchImpl.mock.calls.find(c => new URL(String(c[0])).pathname === '/api/releases/download') as unknown as [string, RequestInit];
        expect(call[1].method).toBe('POST');
        expect(JSON.parse(call[1].body as string)).toMatchObject({ source: 'direct_download', format: 'pdf', extra: { downloads: expect.any(Number) } });
    });

    it('refuses a release it never listed, without sending anything', async () => {
        const fetchImpl = server();
        await expect(adapter(fetchImpl as typeof fetch).grabRelease({ guid: GUID, indexerId: 0 })).rejects.toMatchObject({ kind: 'NotFound' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('says so when Shelfmark does not queue it', async () => {
        const shelfmark = adapter(server({ '/api/releases/download': () => json({ status: 'odd' }) }) as typeof fetch);
        const [row] = await shelfmark.findReleases({ id: ID });
        await expect(shelfmark.grabRelease({ guid: row?.guid as string, indexerId: 0 })).rejects.toMatchObject({ kind: 'UpstreamError' });
    });

    it('names the key a read-only key would need', async () => {
        const shelfmark = adapter(server({ '/api/releases/download': () => json({ error: 'This API key is read-only' }, 403) }) as typeof fetch, 'ro');
        const [row] = await shelfmark.findReleases({ id: ID });
        await expect(shelfmark.grabRelease({ guid: row?.guid as string, indexerId: 0 })).rejects.toMatchObject({ kind: 'AuthFailed', remedy: expect.stringContaining('SHELFMARK_API_KEY') });
    });
});

describe('the most-downloaded release by default', () => {
    const ID = 'googlebooks:5neBQgAACAAJ';
    const row = (source_id: string, downloads?: number, top = false) => ({
        source: 'direct_download',
        source_id,
        title: source_id,
        indexer: 'Direct Download',
        ...(downloads === undefined ? {} : top ? { downloads } : { extra: { downloads } })
    });
    const listing = { releases: [row('none'), row('few', 5), row('most', 900), row('middle', 40, true)] };

    function tool(answers: Answers = {}) {
        const fetchImpl = server({ '/api/releases': () => json(listing), '/api/releases/download': () => json(fixture('download')), ...answers });
        const shelfmark = adapter(fetchImpl as typeof fetch);
        let call: (args: Record<string, unknown>) => Promise<{ structuredContent: WriteToolResult }> = () => Promise.reject(new Error('not registered'));
        const fake = {
            registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: typeof call) {
                call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
            }
        };
        const config = { url: 'http://shelfmark:8084', timeout_ms: 10_000, permissions: { safe_write: true, destructive: false } };
        registerGrabRelease(
            fake as never,
            {
                permissions: permissionSourceFrom(instancesOf({ shelfmark: config as AnyServiceConfig })),
                confirm: new ConfirmTokens(),
                audit: WriteAudit.ephemeral(),
                library: { invalidate: vi.fn() } as unknown as LibraryLoader
            },
            [shelfmark]
        );
        const sent = () =>
            fetchImpl.mock.calls.filter(c => new URL(String(c[0])).pathname === '/api/releases/download').map(c => (JSON.parse((c as unknown as [string, RequestInit])[1].body as string) as { source_id: string }).source_id);
        return { call: (args: Record<string, unknown>) => call(args), sent, shelfmark };
    }

    it('reads a size from bytes or from the text a direct row gives, and leaves out what it cannot read', async () => {
        const sized = (fields: Record<string, unknown>) => ({ source: 'direct_download', source_id: JSON.stringify(fields), ...fields });
        const fetchImpl = server({ '/api/releases': () => json({ releases: [sized({ size: '42.2MB', size_bytes: null }), sized({ size: '18.5 MB', size_bytes: 19390485 }), sized({ size: '1 gb' }), sized({ size: 'unknown' })] }) });
        const rows = await adapter(fetchImpl as typeof fetch).findReleases({ id: ID });
        expect(rows.map(r => r.sizeBytes)).toEqual([44249907, 19390485, 1073741824, undefined]);
    });

    it('ranks by downloads from either place, with no count last', async () => {
        const rows = await tool().shelfmark.findReleases({ id: ID });
        expect(rows.map(r => r.downloads)).toEqual([900, 40, 5, undefined]);
        expect(rows[3]).not.toHaveProperty('downloads');
    });

    it('previews the top release when none is named, and sends nothing', async () => {
        const h = tool();
        const { structuredContent } = await h.call({ service: 'shelfmark', id: ID });
        expect(structuredContent.applied).toBe(false);
        expect(JSON.stringify(structuredContent)).toContain('most');
        expect(JSON.stringify(structuredContent)).toContain('900 downloads');
        expect(h.sent()).toEqual([]);
    });

    it('refuses an album or a season rather than taking the top release of the whole book', async () => {
        const h = tool();
        await expect(h.call({ service: 'shelfmark', id: ID, album: '15' })).rejects.toThrow(/Lidarr artist/);
        await expect(h.call({ service: 'shelfmark', id: ID, season: 1 })).rejects.toThrow(/for series/);
        expect(h.sent()).toEqual([]);
    });

    it('queues that release once the token comes back', async () => {
        const h = tool();
        const preview = await h.call({ service: 'shelfmark', id: ID });
        const applied = await h.call({ service: 'shelfmark', id: ID, confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.applied).toBe(true);
        expect(h.sent()).toEqual(['most']);
    });

    it('still takes a release that is named', async () => {
        const h = tool();
        const named = (await h.shelfmark.findReleases({ id: ID }))[2];
        const args = { service: 'shelfmark', id: ID, guid: named?.guid, indexer_id: named?.indexerId };
        const preview = await h.call(args);
        await h.call({ ...args, confirm: preview.structuredContent.confirm_token });
        expect(h.sent()).toEqual(['few']);
    });

    it('refuses when nothing is on offer', async () => {
        const h = tool({ '/api/releases': () => json({ releases: [] }) });
        await expect(h.call({ service: 'shelfmark', id: ID })).rejects.toMatchObject({ kind: 'NotFound' });
    });
});

describe('get_history', () => {
    const history = (answers: Answers = {}) => adapter(server(answers) as typeof fetch);

    it('merges captured finished rows with dismissed ones', async () => {
        const rows = await history().readHistory({});
        expect(new Set(rows.map(r => r.event))).toEqual(new Set(['imported', 'failed', 'stopped']));
        for (const row of rows) {
            expect(row.service).toBe('shelfmark');
            expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
            expect(row.title).toContain('<<');
        }
    });

    it('keeps one row for a task in both lists, with the time it ended', async () => {
        const task = { title: 'T', status_message: 'x', added_time: 1000 };
        const rows = await history({
            '/api/activity/snapshot': () => json({ status: { complete: { a: task } } }),
            '/api/activity/history': () => json([{ item_type: 'download', final_status: 'complete', terminal_at: '2026-01-02T03:04:05+00:00', source_id: 'a', snapshot: { kind: 'download', download: task } }])
        }).readHistory({});
        expect(rows).toHaveLength(1);
        expect(rows[0]?.at).toBe('2026-01-02T03:04:05.000Z');
    });

    it('leaves out live rows and requests, and uses the queued time when that is all there is', async () => {
        const rows = await history({
            '/api/activity/snapshot': () => json({ status: { downloading: { live: { title: 'L' } }, error: { b: { title: 'E', status_message: 'failed at http://indexer/api?apikey=SECRET', added_time: 1000 } } } }),
            '/api/activity/history': () => json([{ item_type: 'request', final_status: 'rejected', terminal_at: '2026-01-01', source_id: 'r', snapshot: { download: { title: 'R' } } }])
        }).readHistory({});
        expect(rows.map(r => r.event)).toEqual(['failed']);
        expect(rows[0]?.at).toBe('1970-01-01T00:16:40.000Z');
        expect(rows[0]?.reason).toContain('[url]');
        expect(JSON.stringify(rows)).not.toContain('SECRET');
    });

    it('never shows a task id that is an indexer URL', async () => {
        const url = 'http://indexer/api?apikey=SECRET';
        const rows = await history({
            '/api/activity/snapshot': () => json({ status: { error: { [url]: { title: 'E', added_time: 1000 } } } }),
            '/api/activity/history': () => json([])
        }).readHistory({});
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toContain('SECRET');
    });

    it('applies since and refuses id', async () => {
        const answers = { '/api/activity/snapshot': () => json({ status: { complete: { a: { title: 'old', added_time: 1000 }, b: { title: 'new', added_time: 2_000_000_000 } } } }), '/api/activity/history': () => json([]) };
        const rows = await history(answers).readHistory({ since: '2000-01-01' });
        expect(rows).toHaveLength(1);
        await expect(history(answers).readHistory({ id: '1' })).rejects.toMatchObject({ kind: 'NotFound' });
    });

    it('fails rather than reading as empty when the key cannot see it', async () => {
        const denied = history({ '/api/activity/snapshot': () => new Response('{}', { status: 403 }) });
        await expect(denied.readHistory({})).rejects.toMatchObject({ kind: 'AuthFailed' });
        await expect(denied.readHistory({})).rejects.toMatchObject({ kind: 'AuthFailed' });
    });
});

describe('cancelling and retrying', () => {
    const URL_TASK = 'http://indexer/api?apikey=SECRET';
    const task = (title: string, extra: Record<string, unknown> = {}) => ({ title, added_time: 1000, retry_available: true, ...extra });
    const idOf = (taskId: string) => createHash('sha256').update(taskId).digest('hex').slice(0, 32);

    function tools(answers: Answers = {}, destructive = true) {
        const fetchImpl = server({ '/api/activity/history': () => json([]), ...answers });
        const shelfmark = adapter(fetchImpl as typeof fetch);
        const calls = new Map<string, (args: Record<string, unknown>) => Promise<{ structuredContent: WriteToolResult; content: { text: string }[] }>>();
        const fake = {
            registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: (args: Record<string, unknown>) => Promise<{ structuredContent: WriteToolResult; content: { text: string }[] }>) {
                calls.set(name, args => handler(config.inputSchema.parse(args) as Record<string, unknown>));
            }
        };
        const config = { url: 'http://shelfmark:8084', timeout_ms: 10_000, permissions: { safe_write: true, destructive } };
        const context = {
            permissions: permissionSourceFrom(instancesOf({ shelfmark: config as AnyServiceConfig })),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        };
        registerRemoveQueueItem(fake as never, context, [shelfmark]);
        registerRetryDownload(fake as never, context, [shelfmark]);
        const confirmed = async (name: string, args: Record<string, unknown>) => {
            const call = calls.get(name) as NonNullable<ReturnType<typeof calls.get>>;
            const preview = await call(args);
            return { preview, applied: await call({ ...args, confirm: preview.structuredContent.confirm_token }) };
        };
        const calledPaths = (method: string) => fetchImpl.mock.calls.filter(c => (c as unknown as [string, RequestInit])[1].method === method).map(c => new URL(String(c[0])).pathname);
        return { call: (name: string, args: Record<string, unknown>) => (calls.get(name) as NonNullable<ReturnType<typeof calls.get>>)(args), confirmed, calledPaths };
    }

    describe('remove_queue_item', () => {
        const queued = { '/api/status': () => json({ queued: { [URL_TASK]: task('Q') }, error: { bad: task('F') } }) };
        const cancelled = { [`/api/download/${encodeURIComponent(URL_TASK)}/cancel`]: () => json(fixture('download-cancel')) };

        it('previews, then cancels with the real task id encoded', async () => {
            const h = tools({ ...queued, ...cancelled });
            const { preview, applied } = await h.confirmed('remove_queue_item', { service: 'shelfmark', id: idOf(URL_TASK) });
            expect(preview.structuredContent.applied).toBe(false);
            expect(JSON.stringify(preview.structuredContent)).toContain('Cancels it in shelfmark');
            expect(JSON.stringify(preview.structuredContent)).not.toContain('deletes any partial data');
            expect(applied.structuredContent.applied).toBe(true);
            expect(h.calledPaths('DELETE')).toEqual([`/api/download/${encodeURIComponent(URL_TASK)}/cancel`]);
        });

        it('needs destructive on', async () => {
            const h = tools({ ...queued, ...cancelled }, false);
            await expect(h.confirmed('remove_queue_item', { service: 'shelfmark', id: idOf(URL_TASK) })).rejects.toMatchObject({ kind: 'PermissionDenied' });
            expect(h.calledPaths('DELETE')).toEqual([]);
        });

        it('refuses a failed book, and keeping the download', async () => {
            const h = tools(queued);
            await expect(h.call('remove_queue_item', { service: 'shelfmark', id: idOf('bad') })).rejects.toThrow('already failed');
            await expect(h.call('remove_queue_item', { service: 'shelfmark', id: idOf(URL_TASK), remove_from_client: false })).rejects.toThrow('cancel a download outright');
        });

        it('keeps the indexer key out of a failed cancel', async () => {
            const h = tools({ ...queued, [`/api/download/${encodeURIComponent(URL_TASK)}/cancel`]: () => new Response('{}', { status: 500 }) });
            const failure = h.confirmed('remove_queue_item', { service: 'shelfmark', id: idOf(URL_TASK) });
            await expect(failure).rejects.toThrow('HTTP 500');
            await expect(failure).rejects.not.toThrow('SECRET');
        });

        it('says so when the book finished before the cancel landed', async () => {
            const h = tools({ ...queued, [`/api/download/${encodeURIComponent(URL_TASK)}/cancel`]: () => new Response('{}', { status: 404 }) });
            await expect(h.confirmed('remove_queue_item', { service: 'shelfmark', id: idOf(URL_TASK) })).rejects.toMatchObject({ kind: 'NotFound' });
        });
    });

    describe('retry_download', () => {
        const stopped = {
            '/api/activity/snapshot': () =>
                json({ status: { error: { [URL_TASK]: task('Failed', { status_message: 'no space' }), dead: task('Dead', { retry_available: false }) }, complete: { done: task('Done') }, downloading: { live: task('Live') } } })
        };
        const requeued = { [`/api/download/${encodeURIComponent(URL_TASK)}/retry`]: () => json(fixture('download-retry')) };

        it('previews the failure, then queues it again, with no talk of an *arr', async () => {
            const h = tools({ ...stopped, ...requeued });
            const { preview, applied } = await h.confirmed('retry_download', { service: 'shelfmark', id: idOf(URL_TASK) });
            expect(JSON.stringify(preview.structuredContent)).toContain('front of shelfmark');
            expect(JSON.stringify(preview.structuredContent)).toContain('no space');
            expect(applied.structuredContent.applied).toBe(true);
            expect(h.calledPaths('POST')).toEqual([`/api/download/${encodeURIComponent(URL_TASK)}/retry`]);
            const text = applied.content.map(c => c.text).join(' ');
            expect(text).not.toContain('import');
            expect(JSON.stringify(applied)).not.toContain('SECRET');
        });

        it('takes a cancelled row that was dismissed', async () => {
            const h = tools({
                '/api/activity/snapshot': () => json({ status: {} }),
                '/api/activity/history': () => json([{ item_type: 'download', final_status: 'cancelled', terminal_at: '2026-01-01T00:00:00Z', source_id: 'gone', snapshot: { download: task('Gone') } }]),
                '/api/download/gone/retry': () => json(fixture('download-retry'))
            });
            const { applied } = await h.confirmed('retry_download', { service: 'shelfmark', id: idOf('gone') });
            expect(applied.structuredContent.applied).toBe(true);
        });

        it.each([
            ['a row Shelfmark will not retry', 'dead', 'cannot be retried'],
            ['a finished book', 'done', 'nothing to retry'],
            ['a book still running', 'live', 'no failed or cancelled download']
        ])('refuses %s', async (_name, taskId, message) => {
            await expect(tools(stopped).call('retry_download', { service: 'shelfmark', id: idOf(taskId) })).rejects.toThrow(message);
        });

        it('refuses a password, which a book download has no use for', async () => {
            await expect(tools(stopped).call('retry_download', { service: 'shelfmark', id: idOf(URL_TASK), password: 'x' })).rejects.toThrow('no archive password');
        });

        it('fails when Shelfmark does not say it queued, and keeps the key out of a refusal', async () => {
            const silent = tools({ ...stopped, [`/api/download/${encodeURIComponent(URL_TASK)}/retry`]: () => json({ status: 'odd' }) });
            await expect(silent.confirmed('retry_download', { service: 'shelfmark', id: idOf(URL_TASK) })).rejects.toThrow('did not say');
            const refused = tools({ ...stopped, [`/api/download/${encodeURIComponent(URL_TASK)}/retry`]: () => new Response('{}', { status: 409 }) }).confirmed('retry_download', { service: 'shelfmark', id: idOf(URL_TASK) });
            await expect(refused).rejects.toThrow('409');
            await expect(refused).rejects.not.toThrow('SECRET');
        });
    });
});

describe('capture scrubbing', () => {
    it('cuts the activity list down and takes people and URLs out of it', () => {
        const url = 'http://indexer/api?apikey=SECRET';
        const row = { id: url, title: 'T', username: 'someone', user_id: 7, download_path: '/books/T.epub', preview: '/api/cover', status_message: 'at /data/x' };
        const snapshot = anonymiseShelfmarkSnapshot({ status: { complete: Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, { ...row, id: k }])), error: { [url]: row } }, requests: [{ note: 'someone' }], dismissed: [{ item_key: 'x' }] }) as { status: Record<string, Record<string, unknown>>; requests: unknown[]; dismissed: unknown[] };
        expect(Object.keys(snapshot.status.complete ?? {})).toHaveLength(3);
        expect(snapshot.requests).toEqual([]);
        expect(snapshot.dismissed).toEqual([]);
        const history = anonymiseShelfmarkHistory([{ id: `download:${url}`, item_key: `download:${url}`, source_id: url, final_status: 'error', snapshot: { kind: 'download', download: row } }]);
        for (const text of [JSON.stringify(snapshot), JSON.stringify(history)]) {
            for (const secret of ['SECRET', 'someone', '/books', '/data/x']) expect(text).not.toContain(secret);
        }
    });

    it('replaces a task id that is an indexer URL, as a key and as a field', () => {
        const url = 'http://indexer/api?apikey=SECRET';
        const scrubbed = anonymiseShelfmarkStatus({ queued: { [url]: { id: url, title: 'T' }, md5: { id: 'md5', title: 'U' } } });
        expect(JSON.stringify(scrubbed)).not.toContain('SECRET');
        expect(scrubbed).toEqual({ queued: { 'example-task-1': { id: 'example-task-1', title: 'T' }, md5: { id: 'md5', title: 'U' } } });
    });

    it('blanks URLs, extras and Prowlarr indexer names from release rows, and caps them per source', () => {
        const prowlarr = { source: 'prowlarr', source_id: 'real', indexer: 'My Private Tracker', title: 'T', download_url: 'http://x/?apikey=k', info_url: 'http://x', extra: { a: 1 } };
        const scrubbed = anonymiseShelfmarkReleases({ book: { description: 'blurb' }, sources_searched: ['prowlarr'], releases: [prowlarr, prowlarr, prowlarr, prowlarr] }) as { releases: Record<string, unknown>[]; book?: unknown };
        expect(scrubbed.book).toBeUndefined();
        expect(scrubbed.releases).toHaveLength(3);
        expect(scrubbed.releases[0]).toEqual({ source: 'prowlarr', source_id: 'example-1', indexer: 'Example Indexer 1', title: 'T', download_url: '', info_url: '', extra: {} });
        const counted = anonymiseShelfmarkReleases({ releases: [{ source: 'direct_download', extra: { downloads: 7, preview: '/api/covers/x' } }] }) as { releases: Record<string, unknown>[] };
        expect(counted.releases[0]?.extra).toEqual({ downloads: 7 });
    });

    it('keeps Direct Download named, because it is Shelfmark\'s own source', () => {
        const row = { source: 'direct_download', source_id: 'md5', indexer: 'Direct Download' };
        const scrubbed = anonymiseShelfmarkReleases({ releases: [row] }) as { releases: Record<string, unknown>[] };
        expect(scrubbed.releases[0]).toMatchObject({ source_id: 'md5', indexer: 'Direct Download' });
    });

    it('blanks a book\'s blurb and URLs from search results', () => {
        const scrubbed = anonymiseShelfmarkSearch({ books: [{ title: 'Dune', description: 'blurb', cover_url: '/api/covers/x', source_url: 'http://b', display_fields: [{}] }] });
        expect(scrubbed).toEqual({ books: [{ title: 'Dune', description: '', cover_url: '', source_url: '', display_fields: [] }] });
    });

    it('keeps only the version from /api/config, whose other fields hold hosts', () => {
        expect(anonymiseShelfmarkConfig({ release_version: 'v1.6.1', build_version: 'b', calibre_web_url: 'http://10.0.0.1:8083', audiobook_library_url: 'http://10.0.0.2' })).toEqual({ release_version: 'v1.6.1', build_version: 'b' });
    });

    it('blanks who asked and where a book landed, and keeps the title', () => {
        const scrubbed = anonymiseShelfmarkStatus({
            error: { t: { title: 'Dune', username: 'someone', user_id: 7, download_path: '/books/Dune.epub', preview: '/api/covers/x', status_message: 'Cannot write /books/Dune.epub' } },
            queued: { u: { title: 'Emma', username: null, user_id: null, download_path: null, status_message: 'Queued' } }
        });
        expect(scrubbed).toEqual({
            error: { t: { title: 'Dune', username: 'example-user', user_id: 1, download_path: '', preview: '', status_message: 'Example message' } },
            queued: { u: { title: 'Emma', username: null, user_id: null, download_path: null, status_message: 'Queued' } }
        });
    });
});
