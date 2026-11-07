import { beforeEach, describe, expect, it } from 'vitest';
import type { AnyServiceConfig } from '../src/config/schema.ts';
import { resetGrimmoryLockouts } from '../src/core/auth.ts';
import { GrimmoryAdapter } from '../src/services/grimmory.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { registerTriggerScan } from '../src/tools/triggerScan.ts';
import { grimmoryConfig, grimmoryServer, json, writeTool, type Reply } from './helpers/grimmory.ts';

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
