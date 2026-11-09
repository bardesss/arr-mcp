import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Radarr and Sonarr are updated through their editor endpoints, which set only
 * the fields they are sent, so the thing worth testing is that an update
 * names exactly what changed and nothing else.
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

        // Not recorded: the specs give the editor PUT a bare 200 with no schema, and the
        // code discards the body and reads the item back, so its shape is never read.
        if (url.pathname === `/api/v3/${resource}/editor` && method === 'PUT') return jsonResponse([]);
        if (url.pathname === `/api/v3/${resource}/15` && method === 'GET') return jsonResponse(current);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

describe('updating something already in the library', () => {
    it('sends only what changed, through the editor', async () => {
        const s = stack('movie');
        await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', { qualityProfileId: 7, moveFiles: false });
        const put = s.sent.find(x => x.method === 'PUT');
        expect(put?.path).toBe('/api/v3/movie/editor');
        expect(put?.body).toEqual({ movieIds: [15], qualityProfileId: 7, moveFiles: false });
    });

    it('moves to the new root folder without naming the old path', async () => {
        const s = stack('movie');
        await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', { rootFolderPath: '/movies-4k', moveFiles: true });
        const put = s.sent.find(x => x.method === 'PUT');
        expect(put?.body).toEqual({ movieIds: [15], rootFolderPath: '/movies-4k', moveFiles: true });
        expect(put?.body).not.toHaveProperty('path');
    });

    it('replaces the tag set', async () => {
        const s = stack('movie');
        await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', { tagIds: [2], moveFiles: false });
        expect(s.sent.find(x => x.method === 'PUT')?.body).toEqual({
            movieIds: [15],
            tags: [2],
            applyTags: 'replace',
            moveFiles: false
        });
    });

    it('never sends moveFiles: true without a new root folder', async () => {
        const s = stack('movie');
        await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', { monitored: false, moveFiles: true });
        expect(s.sent.find(x => x.method === 'PUT')?.body?.moveFiles).toBe(false);
    });

    it('reports the state read back after the write', async () => {
        const s = stack('movie');
        const state = await new RadarrAdapter(keyed(7878), s.impl).updateMedia('15', { monitored: false, moveFiles: false });
        expect(state.title).toContain('Heat');
        expect(s.sent[s.sent.length - 1]).toMatchObject({ method: 'GET', path: '/api/v3/movie/15' });
        expect(s.sent.findIndex(x => x.method === 'PUT')).toBeLessThan(s.sent.length - 1);
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

    it('uses seriesIds on Sonarr', async () => {
        const s = stack('series', { id: 15, title: 'Taboo', monitored: true, seriesType: 'standard', tags: [] });
        await new SonarrAdapter(keyed(8989), s.impl).updateMedia('15', { seriesType: 'anime', moveFiles: false });

        expect(s.sent.find(x => x.method === 'PUT')?.body).toEqual({
            seriesIds: [15],
            seriesType: 'anime',
            moveFiles: false
        });
    });

    it('fences the title and path it reports back', async () => {
        const s = stack('movie');
        const state = await new RadarrAdapter(keyed(7878), s.impl).readForUpdate('15');
        expect(state.title).toMatch(/untrusted/);
        expect(state.path).toMatch(/untrusted/);
    });
});
