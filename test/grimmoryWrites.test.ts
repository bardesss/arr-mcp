import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyServiceConfig } from '../src/config/schema.ts';
import { resetGrimmoryLockouts } from '../src/core/auth.ts';
import { GrimmoryAdapter, MAX_BOOKDROP_PAGES } from '../src/services/grimmory.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { registerTriggerScan } from '../src/tools/triggerScan.ts';
import { registerDeleteMedia } from '../src/tools/deleteMedia.ts';
import { registerRemoveQueueItem } from '../src/tools/removeQueueItem.ts';
import { registerSetWatched } from '../src/tools/setWatched.ts';
import { registerFixMetadata } from '../src/tools/fixMetadata.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { fixture, grimmoryConfig, grimmoryServer, json, sse, writeTool, type Reply } from './helpers/grimmory.ts';

beforeEach(resetGrimmoryLockouts);

const LIBRARIES = [
    { id: 1, name: 'Fiction', watch: false, paths: [] },
    { id: 2, name: 'Comics', watch: true, paths: [] }
];

function scanTool(routes: Record<string, Reply | Reply[]> = {}, perms?: { safe_write?: boolean; destructive?: boolean }) {
    const server = grimmoryServer({ 'GET /api/v1/libraries': json(LIBRARIES), ...routes });
    const adapter = new GrimmoryAdapter(grimmoryConfig(perms), server.fetch);
    const call = writeTool((s, context) => registerTriggerScan(s, context, [adapter]), perms);
    const puts = () => server.sent.filter(s => s.method === 'PUT').map(s => s.path);
    return { call, server, puts };
}

const REFRESH_1 = { 'PUT /api/v1/libraries/1/refresh': json({}) };

describe('trigger_scan on grimmory', () => {
    it('previews every library and skips a watched one, sending nothing', async () => {
        const { call, server } = scanTool();
        const { structuredContent } = await call({ service: 'grimmory' });
        expect(structuredContent.confirm_token).toBeDefined();
        const effects = structuredContent.effects.join('\n');
        expect(effects).toContain('Comics');
        expect(effects).toContain('watcher');
        expect(server.sent.some(s => s.method === 'PUT')).toBe(false);
    });

    it('fences every library label in a preview', async () => {
        const { call } = scanTool();
        const { structuredContent } = await call({ service: 'grimmory' });
        expect(structuredContent.effects.join()).toContain('<<untrusted:grimmory.library_name>>');
    });

    it('confirm refreshes each unwatched library once', async () => {
        const { call, puts } = scanTool(REFRESH_1);
        const preview = await call({ service: 'grimmory' });
        const done = await call({ service: 'grimmory', confirm: preview.structuredContent.confirm_token });
        expect(done.structuredContent.applied).toBe(true);
        expect(puts()).toEqual(['/api/v1/libraries/1/refresh']);
        expect(done.structuredContent.result).toContain('rescanning 1 library');
    });

    it('scans one library by name, case-insensitively, or by id', async () => {
        const { call } = scanTool();
        for (const library of ['fiction', '1']) {
            const { structuredContent } = await call({ service: 'grimmory', library });
            expect(structuredContent.target).toBe('grimmory:library/1');
        }
    });

    it('a watched library alone is a no-op naming the watcher', async () => {
        const { call, server } = scanTool();
        const { structuredContent } = await call({ service: 'grimmory', library: 'Comics' });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toMatch(/watcher already picks/);
        expect(server.sent.some(s => s.method === 'PUT')).toBe(false);
    });

    it('refuses a library name two libraries share, listing both', async () => {
        const { call } = scanTool({
            'GET /api/v1/libraries': json([
                { id: 1, name: 'Fiction', watch: false },
                { id: 2, name: 'fiction', watch: false }
            ])
        });
        const error = await call({ service: 'grimmory', library: 'FICTION' }).catch((e: unknown) => e as Error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('matches 2 libraries');
        expect((error as Error).message).toMatch(/id 1\)[\s\S]*id 2\)/);
    });

    it('refuses a name that is also another library\'s id, listing both', async () => {
        const { call } = scanTool({
            'GET /api/v1/libraries': json([
                { id: 1, name: '2', watch: false },
                { id: 2, name: 'Comics', watch: false }
            ])
        });
        const error = await call({ service: 'grimmory', library: '2' }).catch((e: unknown) => e as Error);
        expect((error as Error).message).toContain('matches 2 libraries');
        expect((error as Error).message).toMatch(/id 1\)[\s\S]*id 2\)/);
    });

    it('takes a library whose name is its own id', async () => {
        const { call } = scanTool({ 'GET /api/v1/libraries': json([{ id: 7, name: '7', watch: false }]) });
        const { structuredContent } = await call({ service: 'grimmory', library: '7' });
        expect(structuredContent.target).toBe('grimmory:library/7');
    });

    it('refuses an unknown library and lists the names', async () => {
        const { call } = scanTool();
        const error = await call({ service: 'grimmory', library: 'Poetry' }).catch((e: unknown) => e as Error);
        expect((error as Error).message).toContain('no library "Poetry"');
        expect((error as Error).message).toContain('Fiction');
        expect((error as Error).message).toContain('Comics');
    });

    it('action bookdrop rescans the Bookdrop', async () => {
        const { call, server } = scanTool({ 'POST /api/v1/bookdrop/rescan': json({}) });
        const preview = await call({ service: 'grimmory', action: 'bookdrop' });
        expect(preview.structuredContent.target).toBe('grimmory:bookdrop');
        expect(server.sent.some(s => s.path === '/api/v1/bookdrop/rescan')).toBe(false);
        await call({ service: 'grimmory', action: 'bookdrop', confirm: preview.structuredContent.confirm_token });
        expect(server.sent.filter(s => s.method === 'POST' && s.path === '/api/v1/bookdrop/rescan')).toHaveLength(1);
    });

    it('refuses library together with bookdrop', async () => {
        const { call } = scanTool();
        await expect(call({ service: 'grimmory', action: 'bookdrop', library: 'Fiction' })).rejects.toThrow(/not a library/);
    });

    it('refuses id, rename, import, remap and postprocess on grimmory', async () => {
        const { call } = scanTool();
        await expect(call({ service: 'grimmory', id: '5' })).rejects.toThrow(/id. is a book/);
        for (const action of ['rename', 'import', 'remap', 'postprocess']) {
            await expect(call({ service: 'grimmory', action })).rejects.toThrow(/cannot/);
        }
    });

    it('refuses library and bookdrop on other services', async () => {
        const radarr = new RadarrAdapter(
            { url: 'http://192.0.2.10:7878', api_key: 'k', timeout_ms: 10_000, permissions: { safe_write: true, destructive: false } } as AnyServiceConfig as never,
            (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch
        );
        const call = writeTool((s, context) => registerTriggerScan(s, context, [radarr]));
        await expect(call({ service: 'radarr', library: 'Fiction' })).rejects.toThrow(/grimmory/);
        await expect(call({ service: 'radarr', action: 'bookdrop' })).rejects.toThrow(/grimmory/);
    });

    it('names canManageLibrary on a 403 and the library on a 404', async () => {
        const forbidden = scanTool({ 'PUT /api/v1/libraries/1/refresh': json({}, 403) });
        const token = (await forbidden.call({ service: 'grimmory' })).structuredContent.confirm_token;
        const denied = await forbidden.call({ service: 'grimmory', confirm: token }).catch((e: unknown) => e);
        expect(denied).toMatchObject({ kind: 'AuthFailed', detail: 'this Grimmory account may not rescan a library' });
        expect((denied as { remedy: string }).remedy).toContain('canManageLibrary');

        const gone = scanTool({ 'PUT /api/v1/libraries/1/refresh': json({}, 404) });
        const goneToken = (await gone.call({ service: 'grimmory' })).structuredContent.confirm_token;
        const missing = await gone.call({ service: 'grimmory', confirm: goneToken }).catch((e: unknown) => e);
        expect(missing).toMatchObject({ kind: 'NotFound' });
        expect((missing as { detail: string }).detail).toContain('library 1');
    });

    it('names canAccessBookdrop on a 403 from the Bookdrop rescan', async () => {
        const { call } = scanTool({ 'POST /api/v1/bookdrop/rescan': json({}, 403) });
        const token = (await call({ service: 'grimmory', action: 'bookdrop' })).structuredContent.confirm_token;
        const denied = await call({ service: 'grimmory', action: 'bookdrop', confirm: token }).catch((e: unknown) => e);
        expect(denied).toMatchObject({ kind: 'AuthFailed', detail: 'this Grimmory account may not rescan the Bookdrop' });
        expect((denied as { remedy: string }).remedy).toContain('canAccessBookdrop');
    });

    it('is refused without safe_write', async () => {
        const { call, puts } = scanTool(REFRESH_1, {});
        const error = await call({ service: 'grimmory', confirm: 'any-token' }).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'PermissionDenied' });
        expect(puts()).toEqual([]);
    });
});

const DESTRUCTIVE = { safe_write: true, destructive: true };

function deleteTool(routes: Record<string, Reply | Reply[]> = {}, perms: { safe_write?: boolean; destructive?: boolean } = DESTRUCTIVE) {
    const server = grimmoryServer({
        'GET /api/v1/books/58': json(fixture('book')),
        'DELETE /api/v1/books': json(fixture('mock-books-delete')),
        ...routes
    });
    const adapter = new GrimmoryAdapter(grimmoryConfig(perms), server.fetch);
    const call = writeTool((s, context) => registerDeleteMedia(s, context, [adapter]), perms);
    const deletes = () => server.sent.filter(s => s.method === 'DELETE');
    return { call, server, deletes };
}

const confirmed = async (call: ReturnType<typeof deleteTool>['call'], args: Record<string, unknown>) => {
    const preview = await call(args);
    return call({ ...args, confirm: preview.structuredContent.confirm_token });
};

const BOOK = { service: 'grimmory', id: '58', delete_files: true };

describe('delete_media on grimmory', () => {
    it('refuses a book delete that keeps the files', async () => {
        const { call, server } = deleteTool();
        const error = (await call({ service: 'grimmory', id: '58' }).catch((e: unknown) => e)) as Error;
        expect(error.message).toMatch(/no keep-files option/);
        expect(error.message).toContain('delete_files: true');
        expect(server.sent.filter(s => s.path.startsWith('/api/v1/books')).map(s => s.method)).toEqual([]);
    });

    it('refuses an import exclusion on a book', async () => {
        const { call, deletes } = deleteTool();
        await expect(call({ ...BOOK, add_import_exclusion: true })).rejects.toThrow(/import exclusion/);
        expect(deletes()).toEqual([]);
    });

    it('previews that the files are deleted from disk, with the size and fenced title', async () => {
        const { call, deletes } = deleteTool();
        const { structuredContent } = await call(BOOK);
        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.summary).toMatch(/deleting .* from disk/);
        expect(structuredContent.summary).toContain('<<untrusted:grimmory.title>>');
        expect(structuredContent.effects.join('\n')).toMatch(/cannot be undone/);
        expect(structuredContent.effects.join('\n')).toContain('2 MB');
        expect(structuredContent.effects.join('\n')).toContain('EPUB');
        expect(structuredContent.target).toBe('grimmory:58');
        expect(deletes()).toEqual([]);
    });

    it('confirm sends ids=58 once', async () => {
        const { call, deletes } = deleteTool();
        const done = await confirmed(call, BOOK);
        expect(done.structuredContent.applied).toBe(true);
        expect(deletes().map(d => [d.path, d.query])).toEqual([['/api/v1/books', 'ids=58']]);
        expect(done.structuredContent.result).toEqual({ deleted: 'grimmory:58', filesLeft: false });
    });

    it('names a book whose files Grimmory could not delete', async () => {
        const { call } = deleteTool({ 'DELETE /api/v1/books': json({ deleted: [58], failedFileDeletions: [58] }) });
        const done = await confirmed(call, BOOK);
        const text = done.content[0]!.text;
        expect(text).toContain('<<untrusted:grimmory.title>>');
        expect(text).toMatch(/could not delete its files from disk; they are still in the library folder/);
        expect(done.structuredContent.result).toEqual({ deleted: 'grimmory:58', filesLeft: true });
    });

    it('fails when Grimmory did not delete the book', async () => {
        const { call } = deleteTool({ 'DELETE /api/v1/books': json({ deleted: [], failedFileDeletions: [] }) });
        const error = await confirmed(call, BOOK).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'UpstreamError' });
    });

    it('names canDeleteBook on a 403 and the book on a 404', async () => {
        const forbidden = deleteTool({ 'DELETE /api/v1/books': json({}, 403) });
        const denied = await confirmed(forbidden.call, BOOK).catch((e: unknown) => e);
        expect(denied).toMatchObject({ kind: 'AuthFailed', detail: 'this Grimmory account may not delete books' });
        expect((denied as { remedy: string }).remedy).toContain('canDeleteBook');

        const gone = deleteTool({ 'DELETE /api/v1/books': json({}, 404) });
        const missing = await confirmed(gone.call, BOOK).catch((e: unknown) => e);
        expect(missing).toMatchObject({ kind: 'NotFound' });
        expect((missing as { detail: string }).detail).toContain('book 58');

        const unread = deleteTool({ 'GET /api/v1/books/58': json({}, 404) });
        const miss = await unread.call(BOOK).catch((e: unknown) => e);
        expect(miss).toMatchObject({ kind: 'NotFound' });
        expect(unread.deletes()).toEqual([]);
    });

    it('is refused without destructive', async () => {
        const { call, deletes } = deleteTool({}, { safe_write: true });
        const error = await call({ ...BOOK, confirm: 'any-token' }).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'PermissionDenied' });
        expect(deletes()).toEqual([]);
    });

    it('takes the id as 58 or grimmory:58', async () => {
        for (const id of ['58', 'grimmory:58']) {
            const { call, deletes } = deleteTool();
            const preview = await call({ ...BOOK, id });
            expect(preview.structuredContent.target).toBe('grimmory:58');
            await call({ ...BOOK, id, confirm: preview.structuredContent.confirm_token });
            expect(deletes().map(d => d.query)).toEqual(['ids=58']);
        }
    });

    it('refuses an id that is not digits, sending nothing', async () => {
        const { call, server } = deleteTool();
        await expect(call({ ...BOOK, id: '58,59' })).rejects.toThrow(/digits/);
        expect(server.sent.some(s => s.method === 'DELETE')).toBe(false);
    });
});

const PENDING = fixture('mock-bookdrop-files-pending') as { content: unknown[] };
const pendingPage = (content: unknown[], totalPages = 1) => json({ content, page: { size: 100, number: 0, totalElements: content.length, totalPages } });
const FENCED_NAME = '<<untrusted:grimmory.file_name>>';

describe('the Bookdrop as a queue', () => {
    it('lists a pending file as a book queue row', async () => {
        const server = grimmoryServer({ 'GET /api/v1/bookdrop/files': json(PENDING) });
        const adapter = new GrimmoryAdapter(grimmoryConfig(), server.fetch);
        const rows = await adapter.getQueue();
        expect(rows).toEqual([
            { service: 'grimmory', id: '3', title: expect.stringContaining('Example Book 3.epub'), status: 'pending review', addedAt: '2026-11-01T09:00:00Z' }
        ]);
        expect(rows[0]!.title).toContain(FENCED_NAME);
        expect(adapter.queueKind).toBe('book');
        expect(server.sent.find(s => s.path === '/api/v1/bookdrop/files')!.query).toBe('status=pending&page=0&size=100');
    });

    it('pages the Bookdrop until it ends', async () => {
        const row = (id: number) => ({ ...(PENDING.content[0] as object), id });
        const server = grimmoryServer({ 'GET /api/v1/bookdrop/files': [pendingPage([row(1)], 2), pendingPage([row(2)], 2)] });
        const rows = await new GrimmoryAdapter(grimmoryConfig(), server.fetch).getQueue();
        expect(rows.map(r => r.id)).toEqual(['1', '2']);
        expect(server.sent.filter(s => s.path === '/api/v1/bookdrop/files').map(s => s.query)).toEqual([
            'status=pending&page=0&size=100',
            'status=pending&page=1&size=100'
        ]);
    });

    it('stops at MAX_BOOKDROP_PAGES', async () => {
        const server = grimmoryServer({ 'GET /api/v1/bookdrop/files': pendingPage(PENDING.content, 1_000_000) });
        const error = await new GrimmoryAdapter(grimmoryConfig(), server.fetch).getQueue().catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'UpstreamError' });
        expect(MAX_BOOKDROP_PAGES).toBe(10);
        expect(server.sent.filter(s => s.path === '/api/v1/bookdrop/files')).toHaveLength(MAX_BOOKDROP_PAGES);
    });

    it('fails by name rather than claim an empty Bookdrop on a 403', async () => {
        const server = grimmoryServer({ 'GET /api/v1/bookdrop/files': json({}, 403) });
        const denied = await new GrimmoryAdapter(grimmoryConfig(), server.fetch).getQueue().catch((e: unknown) => e);
        expect(denied).toMatchObject({ kind: 'AuthFailed', detail: 'this Grimmory account may not read the Bookdrop' });
        expect((denied as { remedy: string }).remedy).toContain('canAccessBookdrop');
    });
});

function discardTool(routes: Record<string, Reply | Reply[]> = {}, perms: { safe_write?: boolean; destructive?: boolean } = DESTRUCTIVE) {
    const server = grimmoryServer({
        'GET /api/v1/bookdrop/files': json(PENDING),
        'POST /api/v1/bookdrop/files/discard': json({}),
        ...routes
    });
    const adapter = new GrimmoryAdapter(grimmoryConfig(perms), server.fetch);
    const call = writeTool((s, context) => registerRemoveQueueItem(s, context, [adapter]), perms);
    const discards = () => server.sent.filter(s => s.path === '/api/v1/bookdrop/files/discard');
    return { call, server, discards };
}

const DISCARD = { service: 'grimmory', id: '3' };

describe('remove_queue_item on the Bookdrop', () => {
    it('previews a discard that deletes the file', async () => {
        const { call, discards } = discardTool();
        const { structuredContent } = await call(DISCARD);
        expect(structuredContent.applied).toBe(false);
        const effects = structuredContent.effects.join('\n');
        expect(effects).toMatch(/deletes the file from disk/);
        expect(effects).toMatch(/not imported/);
        expect(effects).toContain(FENCED_NAME);
        expect(discards()).toEqual([]);
    });

    it('confirm discards exactly that file', async () => {
        const { call, discards } = discardTool();
        const done = await confirmed(call, DISCARD);
        expect(done.structuredContent.applied).toBe(true);
        expect(discards().map(d => d.body)).toEqual([{ selectAll: false, selectedIds: [3], excludedIds: [] }]);
    });

    it('refuses remove_from_client false on the Bookdrop', async () => {
        const { call, discards } = discardTool();
        const error = await call({ ...DISCARD, remove_from_client: false }).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'NotFound' });
        expect((error as { remedy: string }).remedy).toContain('Leave out remove_from_client');
        expect(discards()).toEqual([]);
    });

    it('fails, sending nothing, when the file left the Bookdrop before confirm', async () => {
        const { call, discards } = discardTool({ 'GET /api/v1/bookdrop/files': [json(PENDING), pendingPage([])] });
        const preview = await call(DISCARD);
        const error = await call({ ...DISCARD, confirm: preview.structuredContent.confirm_token }).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'NotFound' });
        expect((error as { detail: string }).detail).toContain("nothing in grimmory's queue has id");
        expect(discards()).toEqual([]);
    });

    it('names canAccessBookdrop on a 403 from the discard', async () => {
        const { call } = discardTool({ 'POST /api/v1/bookdrop/files/discard': json({}, 403) });
        const denied = await confirmed(call, DISCARD).catch((e: unknown) => e);
        expect(denied).toMatchObject({ kind: 'AuthFailed', detail: 'this Grimmory account may not discard Bookdrop files' });
        expect((denied as { remedy: string }).remedy).toContain('canAccessBookdrop');
    });

    it('is refused without destructive', async () => {
        const { call, discards } = discardTool({}, { safe_write: true });
        const error = await call({ ...DISCARD, confirm: 'any-token' }).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'PermissionDenied' });
        expect(discards()).toEqual([]);
    });
});

function watchedTool(status: string | undefined, routes: Record<string, Reply | Reply[]> = {}, perms: { safe_write?: boolean; destructive?: boolean } = { safe_write: true }) {
    const base = fixture('book-read') as Record<string, unknown>;
    const { readStatus: _drop, ...rest } = base;
    const book = { ...rest, id: 58, ...(status === undefined ? {} : { readStatus: status }) };
    const server = grimmoryServer({
        'GET /api/v1/books/58': json(book),
        'POST /api/v1/books/status': json(fixture('mock-books-status')),
        ...routes
    });
    const adapter = new GrimmoryAdapter(grimmoryConfig(perms), server.fetch);
    const call = writeTool((s, context) => registerSetWatched(s, context, [adapter], undefined), perms);
    const posts = () => server.sent.filter(s => s.method === 'POST' && s.path === '/api/v1/books/status');
    return { call, server, posts };
}

describe('set_watched on grimmory', () => {
    it('marks a book read for the configured account', async () => {
        const { call, posts } = watchedTool(undefined);
        const preview = await call({ item_id: 'grimmory:58', watched: true });
        expect(preview.structuredContent.summary).toContain('<<untrusted:grimmory.title>>');
        expect(preview.structuredContent.target).toBe('grimmory:58');
        expect(preview.structuredContent.effects.join('\n')).toContain('READ');
        expect(posts()).toEqual([]);

        const done = await call({ item_id: 'grimmory:58', watched: true, confirm: preview.structuredContent.confirm_token });
        expect(done.structuredContent.applied).toBe(true);
        expect(posts().map(p => p.body)).toEqual([{ bookIds: [58], status: 'READ' }]);
    });

    it('says READ sets the finish date and UNREAD clears it', async () => {
        const { call } = watchedTool(undefined);
        const read = (await call({ item_id: 'grimmory:58', watched: true })).structuredContent.effects.join('\n');
        expect(read).toMatch(/finish date/);
        const unread = watchedTool('READ');
        const text = (await unread.call({ item_id: 'grimmory:58', watched: false })).structuredContent.effects.join('\n');
        expect(text).toMatch(/finish date/);
        expect(text).toContain('UNREAD');
    });

    it('is a no-op when already READ, or unwatched when UNREAD or UNSET', async () => {
        const already = watchedTool('READ');
        const a = await already.call({ item_id: 'grimmory:58', watched: true });
        expect(a.structuredContent.noop).toBe(true);
        for (const status of ['UNREAD', undefined]) {
            const { call } = watchedTool(status);
            const n = await call({ item_id: 'grimmory:58', watched: false });
            expect(n.structuredContent.noop).toBe(true);
        }
        expect(already.posts()).toEqual([]);
    });

    it('marks a READING book unread', async () => {
        const { call, posts } = watchedTool('READING');
        const preview = await call({ item_id: 'grimmory:58', watched: false });
        expect(preview.structuredContent.noop).not.toBe(true);
        await call({ item_id: 'grimmory:58', watched: false, confirm: preview.structuredContent.confirm_token });
        expect(posts().map(p => p.body)).toEqual([{ bookIds: [58], status: 'UNREAD' }]);
    });

    it('refuses user and season on a book', async () => {
        const { call, server } = watchedTool(undefined);
        for (const extra of [{ user: 'Someone' }, { season: 1 }]) {
            const error = (await call({ item_id: 'grimmory:58', watched: true, ...extra }).catch((e: unknown) => e)) as Error;
            expect(error.message).toMatch(/book/i);
        }
        expect(server.sent.some(s => s.path === '/api/v1/books/58')).toBe(false);
    });

    it('refuses a grimmory id with no Grimmory configured', async () => {
        const call = writeTool((s, context) => registerSetWatched(s, context, [], undefined), { safe_write: true });
        const error = (await call({ item_id: 'grimmory:58', watched: true }).catch((e: unknown) => e)) as { kind: string; detail: string };
        expect(error).toMatchObject({ kind: 'NotFound' });
        expect(error.detail).toMatch(/grimmory/i);
    });

    it('refuses grimmory: with a non-numeric id', async () => {
        const { call, server } = watchedTool(undefined);
        for (const id of ['grimmory:abc', 'grimmory:', 'grimmory:58/x']) {
            const error = (await call({ item_id: id, watched: true }).catch((e: unknown) => e)) as Error;
            expect(error.message).toMatch(/grimmory:<book id>|numeric|digits/i);
        }
        expect(server.sent.some(s => s.path.startsWith('/api/v1/books'))).toBe(false);
    });

    it('names a 404 on the book', async () => {
        const { call } = watchedTool(undefined, { 'GET /api/v1/books/58': json({}, 404) });
        const error = await call({ item_id: 'grimmory:58', watched: true }).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'NotFound' });
        expect((error as { detail: string }).detail).toContain('book 58');
    });

    it('names a 403 on the status write', async () => {
        const { call } = watchedTool(undefined, { 'POST /api/v1/books/status': json({}, 403) });
        const preview = await call({ item_id: 'grimmory:58', watched: true });
        const denied = await call({ item_id: 'grimmory:58', watched: true, confirm: preview.structuredContent.confirm_token }).catch((e: unknown) => e);
        expect(denied).toMatchObject({ kind: 'AuthFailed', detail: 'this Grimmory account may not change read status' });
    });

    it('is checked against grimmory permissions, not jellyfin', async () => {
        const { call, posts } = watchedTool(undefined);
        const preview = await call({ item_id: 'grimmory:58', watched: true });
        const done = await call({ item_id: 'grimmory:58', watched: true, confirm: preview.structuredContent.confirm_token });
        expect(done.structuredContent.applied).toBe(true);
        expect(posts()).toHaveLength(1);

        const locked = watchedTool(undefined, {}, {});
        const error = await locked.call({ item_id: 'grimmory:58', watched: true, confirm: 'any-token' }).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'PermissionDenied', service: 'grimmory' });
        expect(locked.posts()).toEqual([]);
    });

    it('a Jellyfin id still goes to Jellyfin', async () => {
        const { call, server } = watchedTool(undefined);
        const error = (await call({ item_id: '65cbd491b1ecb02fdb3d7cbaefab5353', watched: true }).catch((e: unknown) => e)) as { kind?: string; service?: string };
        expect(error).toMatchObject({ kind: 'NotFound', service: 'jellyfin' });
        expect(server.sent.some(s => s.path.startsWith('/api/v1/books'))).toBe(false);
    });
});

describe('fix_metadata on a book', () => {
    const BOOK = fixture('book-read') as { metadata: Record<string, unknown> };
    /** A Hardcover match for book-read: same title, ISBN and author, with a series and a page count it lacks. */
    const MATCH = {
        provider: 'Hardcover',
        title: 'Example Book 45',
        publisher: '',
        isbn13: '9780000000045',
        authors: ['Example Author 1'],
        seriesName: 'Example Series 1',
        seriesNumber: 1,
        pageCount: 300,
        categories: ['Example Category 9']
    };
    const bookWith = (metadata: Record<string, unknown>) => json({ ...BOOK, metadata: { ...BOOK.metadata, ...metadata } });

    function fixTool(routes: Record<string, Reply | Reply[]> = {}, perms: { safe_write?: boolean; destructive?: boolean } = { destructive: true }) {
        const server = grimmoryServer({
            'GET /api/v1/books/58': json(BOOK),
            'GET /api/v1/metadata/providers': json(fixture('metadata-providers')),
            'POST /api/v1/books/58/metadata/prospective': sse([MATCH]),
            'PUT /api/v1/books/58/metadata': json({}),
            ...routes
        });
        const adapter = new GrimmoryAdapter(grimmoryConfig(perms), server.fetch);
        const loader = { load: () => Promise.reject(new Error('the library is not read for a book')), invalidate: vi.fn() } as unknown as LibraryLoader;
        const call = writeTool((s, context) => registerFixMetadata(s, context, {}, loader, undefined, adapter), perms);
        const puts = () => server.sent.filter(s => s.method === 'PUT');
        const prospective = () => server.sent.filter(s => s.method === 'POST' && s.path === '/api/v1/books/58/metadata/prospective');
        return { call, server, puts, prospective };
    }

    it('previews the best candidate as a fenced field-by-field diff, saving nothing', async () => {
        const { call, puts } = fixTool();
        const { structuredContent } = await call({ id: 'grimmory:58' });
        expect(structuredContent.target).toBe('grimmory:58');
        expect(structuredContent.confirm_token).toBeDefined();
        expect(structuredContent.summary).toContain('Replace 3 fields of <<untrusted:grimmory.title>>Example Book 45 by Example Author 1');
        expect(structuredContent.summary).toContain("Hardcover's match");
        const effects = structuredContent.effects;
        expect(effects.filter(e => e.startsWith('seriesName:'))).toEqual([expect.stringContaining('<<untrusted:grimmory.seriesName>>Example Series 1') as unknown]);
        expect(effects.filter(e => e.startsWith('seriesNumber:'))).toHaveLength(1);
        expect(effects.filter(e => e.startsWith('pageCount:'))).toHaveLength(1);
        expect(effects.some(e => e.startsWith('categories:') || e.startsWith('publisher:'))).toBe(false);
        expect(puts()).toEqual([]);
    });

    it('never sends a locked field, and names it', async () => {
        const { call, puts } = fixTool({ 'GET /api/v1/books/58': bookWith({ seriesNameLocked: true }) });
        const preview = await call({ id: 'grimmory:58' });
        expect(preview.structuredContent.effects.some(e => e.startsWith('seriesName:'))).toBe(false);
        expect(preview.structuredContent.effects.join('\n')).toMatch(/locked in Grimmory.*seriesName/);
        await call({ id: 'grimmory:58', confirm: preview.structuredContent.confirm_token });
        const body = puts()[0]?.body as { metadata: Record<string, unknown> };
        expect(body.metadata).not.toHaveProperty('seriesName');
        expect(body.metadata).toMatchObject({ seriesNumber: 1, pageCount: 300 });
    });

    it('confirm writes exactly the previewed changes', async () => {
        const { call, puts } = fixTool();
        const preview = await call({ id: 'grimmory:58' });
        const done = await call({ id: 'grimmory:58', confirm: preview.structuredContent.confirm_token });
        expect(done.structuredContent.applied).toBe(true);
        expect(puts()).toHaveLength(1);
        expect(puts()[0]).toMatchObject({
            path: '/api/v1/books/58/metadata',
            query: 'replaceMode=REPLACE_WHEN_PROVIDED&mergeCategories=false',
            body: { metadata: { bookId: 58, seriesName: 'Example Series 1', seriesNumber: 1, pageCount: 300 } }
        });
        expect(Object.keys((puts()[0]!.body as { metadata: object }).metadata).sort()).toEqual(['bookId', 'pageCount', 'seriesName', 'seriesNumber']);
        expect(done.structuredContent.result).toEqual({ changed: ['seriesName', 'seriesNumber', 'pageCount'] });
        expect(done.content[0]!.text).toContain('seriesName, seriesNumber, pageCount');
    });

    it('a confirm whose candidates changed gets a fresh preview and writes nothing', async () => {
        const { call, puts } = fixTool({
            'POST /api/v1/books/58/metadata/prospective': [sse([MATCH]), sse([{ ...MATCH, pageCount: 412 }])]
        });
        const preview = await call({ id: 'grimmory:58' });
        const again = await call({ id: 'grimmory:58', confirm: preview.structuredContent.confirm_token });
        expect(again.structuredContent.confirm_error).toBeDefined();
        expect(again.structuredContent.applied).toBe(false);
        expect(again.structuredContent.effects.join('\n')).toContain('412');
        expect(puts()).toEqual([]);
    });

    it('no candidate is a no-op that changes nothing', async () => {
        const { call, puts } = fixTool({
            'POST /api/v1/books/58/metadata/prospective': sse([{ ...MATCH, title: 'Another Book', isbn13: '9780000000099' }])
        });
        const { structuredContent } = await call({ id: 'grimmory:58' });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(structuredContent.summary).toMatch(/nothing to apply/i);
        expect(puts()).toEqual([]);
    });

    it('a candidate that matches already is a no-op', async () => {
        const { call, puts } = fixTool({
            'POST /api/v1/books/58/metadata/prospective': sse([{ provider: 'Google', title: 'Example Book 45', isbn13: '9780000000045', language: 'en' }])
        });
        const { structuredContent } = await call({ id: 'grimmory:58' });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toMatch(/already/);
        expect(puts()).toEqual([]);
    });

    it('a fully locked book is a no-op pointing at Grimmory', async () => {
        const { call, puts, prospective } = fixTool({ 'GET /api/v1/books/58': bookWith({ allMetadataLocked: true }) });
        const { structuredContent } = await call({ id: 'grimmory:58' });
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.summary).toMatch(/locked/);
        expect(structuredContent.summary).toMatch(/in Grimmory/);
        expect(prospective()).toEqual([]);
        expect(puts()).toEqual([]);
    });

    it('isbn steers the search', async () => {
        const { call, prospective } = fixTool({
            'POST /api/v1/books/58/metadata/prospective': sse([{ ...MATCH, title: 'A Different Edition', isbn13: '9780140449136' }])
        });
        const { structuredContent } = await call({ id: 'grimmory:58', isbn: '978-0-14-044913-6' });
        expect(prospective()[0]?.body).toMatchObject({ bookId: 58, isbn: '9780140449136' });
        expect(structuredContent.effects.join('\n')).toContain('A Different Edition');
    });

    it("searches by the book's own ISBN, else its title and first author", async () => {
        const own = fixTool();
        await own.call({ id: 'grimmory:58' });
        expect(own.prospective()[0]?.body).toMatchObject({ isbn: '9780000000045' });
        expect(own.prospective()[0]?.body).not.toHaveProperty('title');

        const bare = fixTool({ 'GET /api/v1/books/58': bookWith({ isbn13: null }) });
        await bare.call({ id: 'grimmory:58' });
        expect(bare.prospective()[0]?.body).toMatchObject({ title: 'Example Book 45', author: 'Example Author 1' });
        expect(bare.prospective()[0]?.body).not.toHaveProperty('isbn');
    });

    it('refuses an isbn that is not one, sending nothing', async () => {
        const { call, server } = fixTool();
        await expect(call({ id: 'grimmory:58', isbn: '978-0-14-04' })).rejects.toThrow(/ISBN/);
        expect(server.sent.some(s => s.path.startsWith('/api/v1/books'))).toBe(false);
    });

    it('refuses isbn on a film and user on a book', async () => {
        const { call, server } = fixTool();
        await expect(call({ query: 'Alien', isbn: '9780140449136' })).rejects.toThrow(/isbn.*book/i);
        await expect(call({ id: 'grimmory:58', user: 'Sam' })).rejects.toThrow(/book/i);
        expect(server.sent.some(s => s.path.startsWith('/api/v1/books'))).toBe(false);
    });

    it('names canEditMetadata on a 403 from the prospective fetch or the write, and the book on a 404', async () => {
        const lookup = fixTool({ 'POST /api/v1/books/58/metadata/prospective': json({}, 403) });
        await expect(lookup.call({ id: 'grimmory:58' })).rejects.toMatchObject({ kind: 'AuthFailed', remedy: expect.stringContaining('canEditMetadata') as unknown });

        const write = fixTool({ 'PUT /api/v1/books/58/metadata': json({}, 403) });
        const preview = await write.call({ id: 'grimmory:58' });
        await expect(write.call({ id: 'grimmory:58', confirm: preview.structuredContent.confirm_token })).rejects.toMatchObject({
            kind: 'AuthFailed',
            remedy: expect.stringContaining('canEditMetadata') as unknown
        });

        const missing = fixTool({ 'GET /api/v1/books/58': json({}, 404) });
        await expect(missing.call({ id: 'grimmory:58' })).rejects.toMatchObject({ kind: 'NotFound', detail: expect.stringContaining('book 58') as unknown });
    });

    it('is refused without destructive on grimmory', async () => {
        const { call, puts } = fixTool({}, { safe_write: true });
        await expect(call({ id: 'grimmory:58' })).rejects.toMatchObject({ kind: 'PermissionDenied', service: 'grimmory' });
        expect(puts()).toEqual([]);
    });

    it('works with no media server configured', async () => {
        const { call, puts } = fixTool();
        const preview = await call({ id: 'grimmory:58' });
        await call({ id: 'grimmory:58', confirm: preview.structuredContent.confirm_token });
        expect(puts()).toHaveLength(1);
    });

    it('the preview says the cover and description are left alone and that Grimmory may write the change into the file', async () => {
        const { call } = fixTool();
        const effects = (await call({ id: 'grimmory:58' })).structuredContent.effects.join('\n');
        expect(effects).toContain('The cover and description are left alone.');
        expect(effects).toMatch(/write the new metadata into the book file/);
        expect(effects).toMatch(/naming pattern/);
    });

    it('refuses a grimmory id with no Grimmory configured', async () => {
        const loader = { load: () => Promise.reject(new Error('unused')), invalidate: vi.fn() } as unknown as LibraryLoader;
        const call = writeTool((s, context) => registerFixMetadata(s, context, {}, loader), { destructive: true });
        await expect(call({ id: 'grimmory:58' })).rejects.toMatchObject({ kind: 'NotFound', service: 'grimmory' });
    });
});
