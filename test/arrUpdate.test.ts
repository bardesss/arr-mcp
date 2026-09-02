import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Radarr and Sonarr replace the whole resource on PUT, so the thing worth
 * testing here is that an update carries everything it did not change.
 */
const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const MOVIE = {
    id: 15,
    title: 'Heat',
    year: 1995,
    monitored: true,
    qualityProfileId: 4,
    path: '/movies/Heat (1995)',
    rootFolderPath: '/movies',
    tags: [1],
    minimumAvailability: 'released'
};

function stack(resource: 'movie' | 'series', current: Record<string, unknown> = MOVIE) {
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

        if (url.pathname === `/api/v3/${resource}/15`) {
            return jsonResponse(method === 'PUT' ? { ...current, ...(JSON.parse(String(init?.body)) as object) } : current);
        }
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

describe('updating something already in the library', () => {
    it('changes only what was asked and carries the rest back', async () => {
        const s = stack('movie');
        await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', { qualityProfileId: 7, moveFiles: false });

        const put = s.sent.find(x => x.method === 'PUT');
        expect(put?.body).toMatchObject({
            id: 15,
            title: 'Heat',
            monitored: true,
            qualityProfileId: 7,
            tags: [1],
            path: '/movies/Heat (1995)'
        });
    });

    it('asks the service to move the files when the root folder changes', async () => {
        const s = stack('movie');
        await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', {
            rootFolderPath: '/movies-4k',
            moveFiles: true
        });

        const put = s.sent.find(x => x.method === 'PUT');
        expect(put?.search).toContain('moveFiles=true');
        expect(put?.body?.rootFolderPath).toBe('/movies-4k');
    });

    it('never sends moveFiles=true without a new root folder', async () => {
        const s = stack('movie');
        await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', { monitored: false, moveFiles: true });
        expect(s.sent.find(x => x.method === 'PUT')?.search).toContain('moveFiles=false');
    });

    it('reads the current state without writing anything', async () => {
        const s = stack('movie');
        const state = await new RadarrAdapter(keyed(7878), s.impl).readForUpdate('15');

        expect(state).toMatchObject({ monitored: true, qualityProfileId: 4, tagIds: [1] });
        expect(state.title).toContain('Heat');
        expect(s.sent.some(x => x.method === 'PUT')).toBe(false);
    });

    it('refuses a non-integer id before issuing anything', async () => {
        const s = stack('movie');
        await expect(
            new RadarrAdapter(keyed(7878), s.impl).updateMedia('tt0113277', { moveFiles: false })
        ).rejects.toThrow(/not a radarr movie id/i);
        expect(s.sent).toHaveLength(0);
    });

    it('does the same for a Sonarr series', async () => {
        const s = stack('series', { id: 15, title: 'Taboo', monitored: true, seriesType: 'standard', tags: [] });
        await new SonarrAdapter(keyed(8989), s.impl).updateMedia('15', { seriesType: 'anime', moveFiles: false });

        expect(s.sent.find(x => x.method === 'PUT')?.body).toMatchObject({ title: 'Taboo', seriesType: 'anime' });
    });

    it('fences the title and path it reports back', async () => {
        const s = stack('movie');
        const state = await new RadarrAdapter(keyed(7878), s.impl).readForUpdate('15');
        expect(state.title).toMatch(/untrusted/);
        expect(state.path).toMatch(/untrusted/);
    });
});
