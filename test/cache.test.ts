import { describe, expect, it, vi } from 'vitest';
import { LIBRARY_TTL_MS, TtlCache } from '../src/core/cache.ts';

/** A hand-cranked clock, so expiry is testable without waiting five minutes. */
const clock = (start = 0) => {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('TtlCache', () => {
    it('loads on a miss and returns the loaded value', async () => {
        const cache = new TtlCache();
        expect(await cache.get('k', 1000, async () => 'value')).toBe('value');
    });

    it('serves a second call from the cache without loading again', async () => {
        const cache = new TtlCache();
        const load = vi.fn(async () => 'value');

        await cache.get('k', 1000, load);
        await cache.get('k', 1000, load);

        expect(load).toHaveBeenCalledTimes(1);
    });

    it('reloads once the ttl has elapsed', async () => {
        const c = clock();
        const cache = new TtlCache(c.now);
        const load = vi.fn(async () => 'value');

        await cache.get('k', 1000, load);
        c.advance(1001);
        await cache.get('k', 1000, load);

        expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not reload one millisecond before expiry', async () => {
        const c = clock();
        const cache = new TtlCache(c.now);
        const load = vi.fn(async () => 'value');

        await cache.get('k', 1000, load);
        c.advance(999);
        await cache.get('k', 1000, load);

        expect(load).toHaveBeenCalledTimes(1);
    });

    it('keeps separate keys separate', async () => {
        const cache = new TtlCache();
        expect(await cache.get('a', 1000, async () => 'A')).toBe('A');
        expect(await cache.get('b', 1000, async () => 'B')).toBe('B');
    });

    it('shares one in-flight load between concurrent callers', async () => {
        const cache = new TtlCache();
        let calls = 0;
        const slow = async () => {
            calls += 1;
            await new Promise(r => setTimeout(r, 20));
            return 'value';
        };

        // Both start before either resolves: without single-flight this is two
        // full library fetches against the same service.
        const [a, b] = await Promise.all([cache.get('k', 1000, slow), cache.get('k', 1000, slow)]);

        expect([a, b]).toEqual(['value', 'value']);
        expect(calls).toBe(1);
    });

    it('does not cache a failed load', async () => {
        const cache = new TtlCache();
        let calls = 0;
        const flaky = async () => {
            calls += 1;
            if (calls === 1) throw new Error('service was restarting');
            return 'value';
        };

        await expect(cache.get('k', 1000, flaky)).rejects.toThrow('service was restarting');
        // A service restarting during the first call must not poison every
        // later call until arr-mcp itself restarts.
        expect(await cache.get('k', 1000, flaky)).toBe('value');
    });

    it('rejects every concurrent caller when the shared load fails', async () => {
        const cache = new TtlCache();
        const failing = async () => {
            await new Promise(r => setTimeout(r, 10));
            throw new Error('down');
        };

        const results = await Promise.allSettled([
            cache.get('k', 1000, failing),
            cache.get('k', 1000, failing)
        ]);

        expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
    });

    it('does not cache a value shouldCache declines', async () => {
        const cache = new TtlCache();
        let calls = 0;
        const load = async () => {
            calls += 1;
            return calls === 1 ? 'partial' : 'complete';
        };

        expect(await cache.get('k', 1000, load, v => v !== 'partial')).toBe('partial');
        expect(await cache.get('k', 1000, load, v => v !== 'partial')).toBe('complete');
        expect(calls).toBe(2);
    });

    it('still caches when shouldCache is omitted', async () => {
        const cache = new TtlCache();
        const load = vi.fn(async () => 'value');

        await cache.get('k', 1000, load);
        await cache.get('k', 1000, load);

        expect(load).toHaveBeenCalledTimes(1);
    });

    it('does not let a late-resolving, declined load delete a fresher entry that already replaced it', async () => {
        // The scenario LibraryLoader's first fix (invalidate()) got wrong:
        // every other test in this file awaits one load before starting the
        // next, so none of them exercise two loads for the same key in
        // flight at once. This one does — the first load outlives its own
        // ttl before resolving, a second caller starts a fresh load in the
        // gap, and only then does the first (degraded) load resolve.
        const c = clock();
        const cache = new TtlCache(c.now);

        let resolveFirst!: (v: { ok: boolean }) => void;
        const first = cache.get(
            'k',
            100,
            () => new Promise<{ ok: boolean }>(resolve => (resolveFirst = resolve)),
            v => v.ok
        );

        // The first load's ttl elapses while it is still pending.
        c.advance(101);

        // A second caller finds the entry expired and starts its own load,
        // which completes and is kept.
        const second = cache.get('k', 100, async () => ({ ok: true }), v => v.ok);
        await expect(second).resolves.toEqual({ ok: true });

        // The first load finally resolves, declined by shouldCache. It must
        // not delete the second load's entry — it is not "the" entry for
        // this key anymore, and the guard on the failure path exists for
        // exactly this reason.
        resolveFirst({ ok: false });
        await expect(first).resolves.toEqual({ ok: false });

        const load = vi.fn(async () => ({ ok: true }));
        await cache.get('k', 100, load, v => v.ok);
        expect(load).not.toHaveBeenCalled();
    });

    it('drops an entry on invalidate', async () => {
        const cache = new TtlCache();
        const load = vi.fn(async () => 'value');

        await cache.get('k', 1000, load);
        cache.invalidate('k');
        await cache.get('k', 1000, load);

        expect(load).toHaveBeenCalledTimes(2);
    });

    it('reports its size, so a leak would be visible', async () => {
        const cache = new TtlCache();
        await cache.get('a', 1000, async () => 1);
        await cache.get('b', 1000, async () => 2);

        expect(cache.size()).toBe(2);
        cache.clear();
        expect(cache.size()).toBe(0);
    });

    it('exposes the ttls the design spec names', () => {
        expect(LIBRARY_TTL_MS).toBe(300_000);
    });
});
