/**
 * A TTL map, **not an LRU**.
 *
 * Eviction solves unbounded key growth, and the key space here is about a dozen
 * entries — one library per service, one health per service. An LRU would be
 * machinery for a problem this project cannot have, and every line of it would
 * be untested by any scenario a user can reach.
 */
export type Clock = () => number;

/**
 * Library reads, ~5 minutes.
 *
 * There was a `HEALTH_TTL_MS = 30_000` beside this for a health cache that was
 * never built — nothing constructed a second `TtlCache`, and `mcp/resources.ts`
 * declares its own `HEALTH_TTL_MS = 0` meaning the opposite. One name, two
 * values, neither caching anything.
 */
export const LIBRARY_TTL_MS = 300_000;

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
     * `ttlFor`, when given, runs on the resolved value and decides how long to
     * keep it: `false` not at all, or a shorter window than `ttlMs` — a
     * degraded library snapshot is worth twenty seconds, not five minutes, and
     * worth more than nothing, which is what refusing to cache it meant while
     * a service was down.
     *
     * It is not a second `invalidate()` call from the caller's side on purpose:
     * a bare `invalidate()` after the fact cannot tell "my load lost a race to
     * a fresher, complete one" from "nothing raced me," and would delete the
     * good entry in the first case. Deciding here, under the same identity
     * check the failure path below uses, means only this exact load's entry is
     * ever touched.
     */
    async get<T>(
        key: string,
        ttlMs: number,
        load: () => Promise<T>,
        ttlFor?: (value: T) => number | false
    ): Promise<T> {
        const existing = this.#entries.get(key);
        if (existing !== undefined && existing.expiresAt > this.#now()) {
            return existing.value as Promise<T>;
        }

        const value = load();
        this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });

        try {
            const resolved = await value;
            if (ttlFor !== undefined) {
                const decided = ttlFor(resolved);
                // Guarded on identity for the same reason as the failure path
                // below: a later successful load may already have replaced
                // this entry, and touching that would be a second bug.
                if (this.#entries.get(key)?.value === value) {
                    if (decided === false) this.#entries.delete(key);
                    // From now, not from the start: the caller is saying how
                    // long *this value* stays good, and the load's own duration
                    // is not part of that.
                    else this.#entries.set(key, { value, expiresAt: this.#now() + decided });
                }
            }
            return resolved;
        } catch (err) {
            // Never cache a failure. A service restarting during the first call
            // would otherwise poison every later call until arr-mcp restarts —
            // the same lesson the identity directory taught earlier.
            //
            // Guarded on identity: a later successful load may already have
            // replaced this entry, and dropping that would be a second bug.
            if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
            throw err;
        }
    }

    /**
     * The seam for write-invalidation. Still nothing in production code
     * calls it (only `test/cache.test.ts` exercises it
     * directly): `LibraryLoader` needed "do not cache a degraded load," but
     * implemented it via `get`'s `ttlFor` predicate instead of a
     * follow-up call here, specifically to reuse the identity check that
     * guards against deleting a fresher entry out from under a concurrent
     * caller — a plain `invalidate()` call has no way to make that check.
     * Write-invalidation ended up going through `LibraryLoader.invalidate`,
     * which clears the whole cache, so nothing in production calls this.
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
