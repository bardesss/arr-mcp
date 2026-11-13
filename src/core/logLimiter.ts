/**
 * At most one log line per key per window, for lines an unauthenticated peer
 * can cause at will. Each one goes to stdout and to the 5000-row ring the
 * config UI reads, so without a limit a single client could push every real
 * line out of the ring and grow `docker logs` one line per request.
 *
 * The line that is let through says how many were dropped before it, so the
 * volume is still on record.
 */

/** Bounds memory against a flood of distinct peers; the oldest entry goes. */
const MAX_KEYS = 1024;

const WINDOW_MS = 60_000;

interface Entry {
    until: number;
    suppressed: number;
}

export class LogLimiter {
    readonly #entries = new Map<string, Entry>();
    readonly #windowMs: number;
    readonly #now: () => number;

    constructor(windowMs: number = WINDOW_MS, now: () => number = () => Date.now()) {
        this.#windowMs = windowMs;
        this.#now = now;
    }

    /**
     * `undefined` when this line should be dropped. Otherwise the number of
     * lines dropped for this key since the last one logged (often 0).
     */
    admit(key: string): number | undefined {
        const now = this.#now();
        const entry = this.#entries.get(key);
        if (entry !== undefined && now < entry.until) {
            entry.suppressed++;
            return undefined;
        }

        const suppressed = entry?.suppressed ?? 0;
        // Re-inserted, so the map's insertion order stays oldest-first for eviction.
        this.#entries.delete(key);
        if (this.#entries.size >= MAX_KEYS) {
            const oldest = this.#entries.keys().next().value;
            if (oldest !== undefined) this.#entries.delete(oldest);
        }
        this.#entries.set(key, { until: now + this.#windowMs, suppressed: 0 });
        return suppressed;
    }
}
