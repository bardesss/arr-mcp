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
        // Overlap is asserted directly rather than raced against a wall clock.
        // The previous form allowed 110ms for three 40ms sources and failed
        // intermittently under full-suite load (observed at 150ms) — a red that
        // said nothing about concurrency and everything about the machine.
        //
        // Counting concurrent occupancy cannot be fooled by a slow timer: run
        // sequentially, the peak is 1 no matter how long each source takes.
        let inFlight = 0;
        let peak = 0;
        const delayed = async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 10));
            inFlight -= 1;
            return [1];
        };
        await gather([
            { id: 'radarr', fetch: delayed },
            { id: 'sonarr', fetch: delayed },
            { id: 'sabnzbd', fetch: delayed }
        ]);
        expect(peak).toBe(3);
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
