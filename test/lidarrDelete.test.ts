import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { scopeText } from '../src/mcp/toolSurface.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { hasMediaDelete } from '../src/services/types.ts';
import { registerDeleteMedia } from '../src/tools/deleteMedia.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * `delete_media` on a Lidarr artist: the whole artist, with Lidarr's own
 * `deleteFiles` and `addImportListExclusion`. The DELETE answers no body, so
 * there is nothing to record beyond what is sent.
 */

const config = (destructive: boolean): KeyedServiceConfig => ({
    url: 'http://192.0.2.10:8686',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive }
});

const ARTIST = { id: 101, artistName: 'Artist 1', monitored: true, statistics: { trackFileCount: 10, sizeOnDisk: 1_073_741_824, albumCount: 2 } };

type Sent = { method: string; path: string; search: string };

function lidarr(artist: unknown = ARTIST) {
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.search });
        if (init?.method === 'DELETE' && url.pathname === '/api/v1/artist/101') return new Response('', { status: 200 });
        if (url.pathname === '/api/v1/artist/101') {
            return new Response(JSON.stringify(artist), { headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }) as unknown as typeof fetch;
    return { adapter: new LidarrAdapter(config(true), impl), sent };
}

describe('LidarrAdapter deleting an artist', () => {
    it('claims the delete', () => {
        expect(hasMediaDelete(lidarr().adapter)).toBe(true);
    });

    // Sonarr's spelling of the exclusion: Radarr's would be dropped unbound,
    // and the artist deleted with no exclusion.
    it('deletes the whole artist with both flags spelled out', async () => {
        const { adapter, sent } = lidarr();
        await adapter.deleteMedia('101', { deleteFiles: false, addImportExclusion: false });
        await adapter.deleteMedia('101', { deleteFiles: true, addImportExclusion: true });

        expect(sent.map(s => `${s.method} ${s.path}${s.search}`)).toEqual([
            'DELETE /api/v1/artist/101?deleteFiles=false&addImportListExclusion=false',
            'DELETE /api/v1/artist/101?deleteFiles=true&addImportListExclusion=true'
        ]);
    });

    // The shared `arrItemId` check, before the DELETE and before the preview's read.
    it('refuses a zero, negative or non-integer id before any request', async () => {
        const { adapter, sent } = lidarr();
        for (const id of ['0', '-1', '1.5', 'artist-1']) {
            await expect(adapter.deleteMedia(id, { deleteFiles: true, addImportExclusion: false })).rejects.toThrow(/is not a lidarr artist id/);
            await expect(adapter.getMediaDetails(id, { includeEpisodes: false, episodeLimit: 0 })).rejects.toThrow(/is not a lidarr artist id/);
        }
        expect(sent).toHaveLength(0);
    });
});

type Call = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: WriteToolResult }>;

function deleteMedia(adapter: LidarrAdapter) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, c: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(c.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const services: Partial<Record<ServiceId, AnyServiceConfig>> = { lidarr: config(true) as AnyServiceConfig };
    registerDeleteMedia(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(services)),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        [adapter]
    );
    return (args: Record<string, unknown>) => call(args);
}

describe('delete_media on Lidarr', () => {
    // The Lidarr text is scoped, so a stack with no Lidarr is not told about it.
    it('names Lidarr in the description only when a Lidarr is configured', () => {
        let description = '';
        const server = {
            registerTool(_n: string, c: { description: string }) {
                description = c.description;
            }
        };
        registerDeleteMedia(
            server as never,
            { permissions: permissionSourceFrom(instancesOf({})), confirm: new ConfirmTokens(), audit: WriteAudit.ephemeral(), library: {} as LibraryLoader },
            []
        );
        const on = (...types: ServiceId[]) => scopeText(description, { configured: new Set(types), hideUnusable: false });
        expect(on('radarr')).not.toContain('Lidarr');
        expect(on('radarr')).toContain('Removes a film from Radarr, optionally');
        expect(on('lidarr')).toContain('Removes a whole artist from Lidarr (by artist id, never an album id), optionally');
    });

    it('previews the artist, its size and that every album goes, then deletes with the previewed flags', async () => {
        const { adapter, sent } = lidarr();
        const call = deleteMedia(adapter);
        const args = { service: 'lidarr', id: '101', delete_files: true, add_import_exclusion: true };
        const first = await call(args);

        const said = first.structuredContent.effects.join(' ');
        expect(first.structuredContent.summary).toContain('Artist 1');
        expect(said).toContain('Deletes 1.0 GB from disk');
        expect(said).toContain('Deletes every album of the artist.');
        expect(said).toContain(
            "Adds an import list exclusion, so Lidarr's import lists will not add it again until one of its albums is added, by hand or through Lidarr's API."
        );
        expect(said).not.toContain('or request');
        expect(sent.some(s => s.method === 'DELETE')).toBe(false);

        await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(sent.filter(s => s.method === 'DELETE').map(s => s.search)).toEqual(['?deleteFiles=true&addImportListExclusion=true']);
    });

    it('calls it an artist when there is no size to report', async () => {
        const { adapter } = lidarr({ ...ARTIST, statistics: { trackFileCount: 0, sizeOnDisk: 0 } });
        const { structuredContent } = await deleteMedia(adapter)({ service: 'lidarr', id: '101', delete_files: true });
        expect(structuredContent.effects.join(' ')).toContain("Deletes this artist's files from disk.");
    });

    it('leaves the files by default', async () => {
        const { structuredContent } = await deleteMedia(lidarr().adapter)({ service: 'lidarr', id: '101' });
        const said = structuredContent.effects.join(' ');
        expect(said).toContain('Leaves the files on disk');
        expect(said).not.toContain('every album');
    });
});
