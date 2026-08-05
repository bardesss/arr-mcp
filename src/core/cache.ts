/**
 * Design spec §16, with one deviation recorded in the Phase 3 design §3: this
 * is a TTL map, **not an LRU**.
 *
 * Eviction solves unbounded key growth, and the key space here is about a dozen
 * entries — one library per service, one health per service. An LRU would be
 * machinery for a problem this project cannot have, and every line of it would
 * be untested by any scenario a user can reach.
 */
export type Clock = () => number;

/** §16: library reads ~5 min, health ~30 s. */
export const LIBRARY_TTL_MS = 300_000;
export const HEALTH_TTL_MS = 30_000;

type Entry<T> = { value: Promise<T>; expiresAt: number };

export class TtlCache {
    readonly #entries = new Map<string, Entry<unknown>>();
    readonly #now: Clock;

    constructor(clock: Clock = Date.now) {
        this.#now = clock;
    }

    /**
     * The stored value is the *promise*, not the resolved value. That is what
     * makes this single-flight: two concurrent callers find the same in-flight
     * promise and share one fetch rather than both hitting the service.
     *
     * `shouldCache`, when given, runs on the resolved value and can decline to
     * keep it — e.g. a library snapshot from a degraded load, not worth five
     * minutes of cache when the missing service is usually just restarting.
     * It is not a second `invalidate()` call from the caller's side on
     * purpose: a bare `invalidate()` after the fact cannot tell "my load lost
     * a race to a fresher, complete one" from "nothing raced me," and would
     * delete the good entry in the first case. Deciding here, under the same
     * identity check the failure path below uses, means only this exact
     * load's entry is ever dropped.
     */
    async get<T>(key: string, ttlMs: number, load: () => Promise<T>, shouldCache?: (value: T) => boolean): Promise<T> {
        const existing = this.#entries.get(key);
        if (existing !== undefined && existing.expiresAt > this.#now()) {
            return existing.value as Promise<T>;
        }

        const value = load();
        this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });

        try {
            const resolved = await value;
            if (shouldCache !== undefined && !shouldCache(resolved)) {
                // Guarded on identity for the same reason as the failure path
                // below: a later successful load may already have replaced
                // this entry, and dropping that would be a second bug.
                if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
            }
            return resolved;
        } catch (err) {
            // Never cache a failure. A service restarting during the first call
            // would otherwise poison every later call until arr-mcp restarts —
            // the same lesson the identity directory taught in Phase 2.
            //
            // Guarded on identity: a later successful load may already have
            // replaced this entry, and dropping that would be a second bug.
            if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
            throw err;
        }
    }

    /**
     * The seam for write-invalidation (§16). Still nothing in production code
     * calls it as of Phase 3b (only `test/cache.test.ts` exercises it
     * directly): `LibraryLoader` needed "do not cache a degraded load," but
     * implemented it via `get`'s `shouldCache` predicate instead of a
     * follow-up call here, specifically to reuse the identity check that
     * guards against deleting a fresher entry out from under a concurrent
     * caller — a plain `invalidate()` call has no way to make that check.
     * `invalidate` remains the seam for 0.5's write-invalidation.
     */
    invalidate(key: string): void {
        this.#entries.delete(key);
    }

    clear(): void {
        this.#entries.clear();
    }

    size(): number {
        return this.#entries.size;
    }
}
