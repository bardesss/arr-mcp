/**
 * Failure backoff for the config UI sign-in.
 *
 * Global rather than per-IP on purpose. `x-forwarded-for` is the only address
 * available and nothing validates it, so per-IP keying would let an attacker
 * reset their own counter by rotating a header — and let them lock the
 * operator out by forging the operator's address.
 */

/** Failures allowed before any delay. Generous: a mistyped password twice over
 *  is ordinary, and the delay is not what stops a serious attacker anyway. */
export const FREE_ATTEMPTS = 5;

const BASE_DELAY_MS = 1_000;

/** The ceiling matters more than the growth: a permanent lockout of the only
 *  account is a worse outcome than a slow attacker. */
const MAX_DELAY_MS = 5 * 60_000;

export class LoginThrottle {
    #failures = 0;
    #blockedUntil = 0;
    readonly #now: () => number;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /** Milliseconds still to wait, or 0 when an attempt is allowed. */
    blockedFor(): number {
        return Math.max(0, this.#blockedUntil - this.#now());
    }

    recordFailure(): void {
        this.#failures++;
        if (this.#failures < FREE_ATTEMPTS) return;

        const over = this.#failures - FREE_ATTEMPTS;
        const delay = Math.min(BASE_DELAY_MS * 2 ** over, MAX_DELAY_MS);
        this.#blockedUntil = this.#now() + delay;
    }

    recordSuccess(): void {
        this.#failures = 0;
        this.#blockedUntil = 0;
    }
}
