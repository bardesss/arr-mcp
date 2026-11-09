/**
 * Failure backoff for the config UI sign-in.
 *
 * Keyed by the socket peer, which cannot be forged, so one noisy client does
 * not lock out the rest. A request that says it was forwarded shares a single
 * bucket instead: behind a proxy the address in `x-forwarded-for` is
 * unverifiable, and rotating it would otherwise reset an attacker's counter or
 * let them lock the operator out by forging theirs. That shared bucket is the
 * old global behaviour.
 */

/** Failures allowed before any delay. Generous: a mistyped password twice over
 *  is ordinary, and the delay is not what stops a serious attacker anyway. */
export const FREE_ATTEMPTS = 5;

const BASE_DELAY_MS = 1_000;

/** Caps how long any one block lasts. A persistent attacker renews it
 *  indefinitely, so this buys recovery once they stop, not a lockout ceiling. */
const MAX_DELAY_MS = 5 * 60_000;

const GLOBAL_KEY = 'global';

/** Bounds memory against a flood of distinct peers; the oldest entry goes. */
const MAX_KEYS = 1024;

interface Entry {
    failures: number;
    blockedUntil: number;
}

export class LoginThrottle {
    readonly #entries = new Map<string, Entry>();
    readonly #now: () => number;

    // Called rather than captured, so a test that installs a fake clock after
    // the app is built still reaches this default.
    constructor(now: () => number = () => Date.now()) {
        this.#now = now;
    }

    /** Milliseconds still to wait, or 0 when an attempt is allowed. */
    blockedFor(key: string = GLOBAL_KEY): number {
        return Math.max(0, (this.#entries.get(key)?.blockedUntil ?? 0) - this.#now());
    }

    /** Returns whether this call just entered (or re-entered) a block, so a
     *  caller can log once per block rather than once per attempt. */
    recordFailure(key: string = GLOBAL_KEY): boolean {
        let entry = this.#entries.get(key);
        if (entry === undefined) {
            if (this.#entries.size >= MAX_KEYS) {
                const oldest = this.#entries.keys().next().value;
                if (oldest !== undefined) this.#entries.delete(oldest);
            }
            entry = { failures: 0, blockedUntil: 0 };
            this.#entries.set(key, entry);
        }

        entry.failures++;
        if (entry.failures < FREE_ATTEMPTS) return false;

        const over = entry.failures - FREE_ATTEMPTS;
        const delay = Math.min(BASE_DELAY_MS * 2 ** over, MAX_DELAY_MS);
        entry.blockedUntil = this.#now() + delay;
        return true;
    }

    recordSuccess(key: string = GLOBAL_KEY): void {
        this.#entries.delete(key);
    }
}
