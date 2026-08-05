import { describe, expect, it } from 'vitest';
import { gather } from '../src/core/gather.ts';

const boom = async (): Promise<never[]> => {
    throw new Error('down');
};

describe('gather', () => {
    it('concatenates results from every source', async () => {
        const out = await gather([
            { id: 'radarr', fetch: async () => [1, 2] },
            { id: 'sonarr', fetch: async () => [3] }
        ]);
        expect(out.items).toEqual([1, 2, 3]);
        expect(out.degraded).toEqual([]);
    });

    it('returns what it gathered plus a degraded entry when one source fails', async () => {
        const out = await gather([
            { id: 'radarr', fetch: async () => [1, 2] },
            { id: 'sabnzbd', fetch: boom }
        ]);
        expect(out.items).toEqual([1, 2]);
        expect(out.degraded).toEqual(['sabnzbd']);
    });

    it('returns an empty result rather than throwing when every source fails', async () => {
        const out = await gather([
            { id: 'radarr', fetch: boom },
            { id: 'sonarr', fetch: boom }
        ]);
        expect(out.items).toEqual([]);
        expect(out.degraded).toEqual(['radarr', 'sonarr']);
    });

    it('preserves source order regardless of which resolves first', async () => {
        const slow = async () => {
            await new Promise(r => setTimeout(r, 20));
            return ['slow'];
        };
        const out = await gather([
            { id: 'radarr', fetch: slow },
            { id: 'sonarr', fetch: async () => ['fast'] }
        ]);
        expect(out.items).toEqual(['slow', 'fast']);
    });

    it('runs sources concurrently rather than in sequence', async () => {
        const delayed = async () => {
            await new Promise(r => setTimeout(r, 40));
            return [1];
        };
        const started = Date.now();
        await gather([
            { id: 'radarr', fetch: delayed },
            { id: 'sonarr', fetch: delayed },
            { id: 'sabnzbd', fetch: delayed }
        ]);
        expect(Date.now() - started).toBeLessThan(110);
    });

    it('reports degraded services in a stable, sorted order', async () => {
        const out = await gather([
            { id: 'sonarr', fetch: boom },
            { id: 'radarr', fetch: boom }
        ]);
        expect(out.degraded).toEqual(['radarr', 'sonarr']);
    });

    it('handles an empty source list', async () => {
        expect(await gather([])).toEqual({ items: [], degraded: [], counts: {} });
    });

    it('reports how many items each source contributed', async () => {
        const out = await gather([
            { id: 'radarr', fetch: async () => [1, 2] },
            { id: 'transmission', fetch: async () => [3] }
        ]);
        expect(out.counts).toEqual({ radarr: 2, transmission: 1 });
    });

    it('records zero for a source that returned nothing, and omits one that failed', async () => {
        const out = await gather([
            { id: 'radarr', fetch: async () => [] },
            { id: 'sonarr', fetch: boom }
        ]);
        // radarr: 0 means "asked, nothing there". sonarr absent from counts and
        // present in degraded means "could not ask". A model must be able to
        // tell those apart.
        expect(out.counts).toEqual({ radarr: 0 });
        expect(out.degraded).toEqual(['sonarr']);
    });

    it('counts what a source contributed even when the caller later truncates', async () => {
        const out = await gather([
            { id: 'radarr', fetch: async () => Array.from({ length: 60 }, (_, i) => i) },
            { id: 'transmission', fetch: async () => [999] }
        ]);
        // The tool will applyLimit(items, 50) and drop the transmission row.
        // counts is what stops that reading as "nothing in Transmission".
        expect(out.counts).toEqual({ radarr: 60, transmission: 1 });
    });
});
