import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * "It is in SABnzbd and Jellyfin still cannot see it" — the download finished
 * and the *arr never took it. A library scan does not help: the file is still
 * in the client's folder.
 */
const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const CANDIDATES = [
    {
        path: '/downloads/Heat.1995.mkv',
        relativePath: 'Heat.1995.mkv',
        size: 8_000_000_000,
        movie: { id: 15, title: 'Heat' },
        quality: { quality: { id: 7, name: 'Bluray-1080p' } },
        languages: [{ id: 1, name: 'English' }],
        releaseGroup: 'GROUP',
        rejections: []
    },
    {
        path: '/downloads/sample.mkv',
        relativePath: 'sample.mkv',
        size: 2_000_000,
        rejections: [{ reason: 'Unknown movie' }]
    }
];

function stack(candidates: unknown = CANDIDATES) {
    const sent: { path: string; search: string; method: string; body: Record<string, unknown> | undefined }[] = [];

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({
            path: url.pathname,
            search: url.search,
            method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });

        if (url.pathname === '/api/v3/manualimport') return jsonResponse(candidates);
        if (url.pathname === '/api/v3/command') return jsonResponse({ id: 91, name: 'ManualImport', status: 'queued' });
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

describe('manual import candidates', () => {
    it('reports what the service matched and what it will not take', async () => {
        const rows = await new RadarrAdapter(keyed(7878), stack().impl).listImportCandidates('nzo_abc');

        expect(rows).toHaveLength(2);
        expect(rows[0]?.matchedTitle).toContain('Heat');
        expect(rows[0]?.rejections).toEqual([]);
        expect(rows[1]?.rejections.join(' ')).toContain('Unknown movie');
    });

    it('fences the rejection reason and the file name, which are upstream text', async () => {
        const rows = await new RadarrAdapter(keyed(7878), stack().impl).listImportCandidates('nzo_abc');
        expect(rows[1]?.rejections[0]).toMatch(/untrusted/);
        expect(rows[0]?.display).toMatch(/untrusted/);
    });

    it('asks by download id', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).listImportCandidates('nzo_abc');
        expect(s.sent[0]?.search).toContain('downloadId=nzo_abc');
    });
});

describe('running a manual import', () => {
    it('imports only the files the service is willing to take', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc');

        const command = s.sent.find(x => x.method === 'POST')?.body as {
            name: string;
            importMode: string;
            files: { path: string; movieId: number; quality: unknown }[];
        };
        expect(command.name).toBe('ManualImport');
        expect(command.importMode).toBe('auto');
        expect(command.files).toHaveLength(1);
        expect(command.files[0]).toMatchObject({ path: '/downloads/Heat.1995.mkv', movieId: 15 });
    });

    it('echoes the quality the service reported rather than inventing one', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc');
        const files = (s.sent.find(x => x.method === 'POST')?.body as { files: { quality: unknown }[] }).files;
        expect(files[0]?.quality).toEqual({ quality: { id: 7, name: 'Bluray-1080p' } });
    });

    it('posts the raw path, never the fenced display form', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc');
        expect(JSON.stringify(s.sent.find(x => x.method === 'POST')?.body)).not.toContain('untrusted');
    });

    it('refuses when every file is rejected, naming the reasons', async () => {
        const s = stack([CANDIDATES[1]]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_bad')).rejects.toThrow(
            /Unknown movie/
        );
        expect(s.sent.some(x => x.method === 'POST')).toBe(false);
    });

    it('refuses when the service knows nothing about that download id', async () => {
        const s = stack([]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).runManualImport('gone')).rejects.toThrow(/get_queue/);
    });

    it('sends the episode ids Sonarr placed the file in', async () => {
        const s = stack([
            {
                path: '/downloads/Taboo.S01E01.mkv',
                relativePath: 'Taboo.S01E01.mkv',
                series: { id: 7, title: 'Taboo' },
                seasonNumber: 1,
                episodes: [{ id: 101 }],
                quality: { quality: { id: 4 } },
                rejections: []
            }
        ]);
        await new SonarrAdapter(keyed(8989), s.impl).runManualImport('nzo_taboo');

        const files = (s.sent.find(x => x.method === 'POST')?.body as { files: Record<string, unknown>[] }).files;
        expect(files[0]).toMatchObject({ seriesId: 7, seasonNumber: 1, episodeIds: [101] });
    });

    /** `ManualImport` with no episode ids is accepted and imports nothing. */
    it('treats a Sonarr file matched to no episode as not importable', async () => {
        const s = stack([
            { path: '/downloads/x.mkv', series: { id: 7, title: 'Taboo' }, episodes: [], rejections: [] }
        ]);
        await expect(new SonarrAdapter(keyed(8989), s.impl).runManualImport('nzo_x')).rejects.toThrow(
            /no episode matched/
        );
    });
});
