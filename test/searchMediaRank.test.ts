import { describe, expect, it, vi } from 'vitest';
import { rankTitle, unfenced } from '../src/core/titleMatch.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildSearchMedia } from '../src/tools/searchMedia.ts';

// Its own file: the spies wrap the real functions, and must not reach searchTools.test.ts.
vi.mock('../src/core/titleMatch.ts', async orig => {
    const m = await orig<typeof import('../src/core/titleMatch.ts')>();
    return { ...m, rankTitle: vi.fn(m.rankTitle), unfenced: vi.fn(m.unfenced) };
});

const hits = Array.from({ length: 20 }, (_, i) => ({
    service: 'radarr',
    source: 'library',
    kind: 'movie',
    id: String(i),
    title: `Film ${(i * 7) % 20}`,
    ids: {}
}));

const adapter = {
    id: 'radarr',
    type: 'radarr',
    search: async () => hits
} as unknown as ServiceAdapter;

describe('search_media ranking', () => {
    it('ranks each hit once', async () => {
        vi.mocked(rankTitle).mockClear();
        vi.mocked(unfenced).mockClear();
        const result = await buildSearchMedia([adapter], { query: 'film', source: 'library', detail: 'minimal', limit: 50 });

        expect(rankTitle).toHaveBeenCalledTimes(20);
        expect(unfenced).toHaveBeenCalledTimes(20);
        // Equal rank, so the tie falls to the name, as the old comparator did.
        const expected = hits.map(h => h.title).sort((a, b) => a.localeCompare(b));
        expect(result.items.map(h => h.title)).toEqual(expected);
    });
});
