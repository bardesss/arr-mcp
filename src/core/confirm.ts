import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServiceId } from '../config/schema.ts';
import type { Clock } from './cache.ts';
import type { WriteTier } from './permissions.ts';

/**
 * Design spec §10's per-call confirmation, built to survive the stateless
 * transport of §5.
 *
 * A write tool called without `confirm` performs nothing and hands back a
 * preview plus a token. Calling again with that token performs the write. The
 * point is not to stop a determined model — it holds the token and can always
 * call twice — it is that the *first* call is the one that cannot mutate
 * anything, so a mis-parsed instruction ("delete the Alien films") surfaces as
 * a preview a human sees before it becomes a deletion.
 *
 * Two properties do the work:
 *
 *   1. The token is an HMAC over the exact operation, so a token issued for
 *      "delete movie 5" cannot be replayed as "delete movie 9". Without this
 *      binding a model could preview something harmless and then confirm
 *      something else, which is strictly worse than no confirmation because it
 *      looks like protection.
 *   2. It is single-use, so "add movie" cannot be confirmed twice into a
 *      duplicate.
 *
 * The signing key is fresh per process and never written down: a restart
 * invalidating outstanding tokens is correct, not a limitation. The alternative
 * — deriving it from the bearer token — would tie confirmation lifetime to
 * credential rotation, which are unrelated concerns.
 */

/** Long enough for a model to read a preview and decide; short enough that a
 *  token found in an old transcript is dead. */
export const CONFIRM_TTL_MS = 300_000;

/** Defensive bound on the consumed-token set, which is otherwise TTL-swept. */
const MAX_CONSUMED = 10_000;

/**
 * Everything a token commits to. Any field that changes the effect of the
 * write belongs here — that is what makes "the token matches this call" mean
 * "this is the call you previewed".
 */
export type WriteIntent = {
    tool: string;
    service: ServiceId;
    tier: WriteTier;
    /** The adapter-level verb, e.g. `delete_movie`. Distinct from `tool` because
     *  one tool may reach more than one operation. */
    operation: string;
    /** The resolved target — an id, not the phrase the user typed. Binding to a
     *  title would let the same token hit a different film after a re-resolve. */
    target: string;
    /** Remaining arguments that alter the effect (e.g. `{ deleteFiles: true }`). */
    args?: Record<string, unknown>;
};

export type ConfirmFailure = 'expired' | 'mismatch' | 'used' | 'malformed';

export type ConfirmResult = { ok: true } | { ok: false; failure: ConfirmFailure; remedy: string };

const REMEDY: Record<ConfirmFailure, string> = {
    expired: `The confirmation token has expired (they last ${CONFIRM_TTL_MS / 1000}s). Call this tool again without \`confirm\` to preview the operation and get a fresh token.`,
    mismatch:
        'That confirmation token was issued for a different operation or different arguments. Call this tool again without `confirm` to preview *this* operation and use the token it returns — do not reuse a token from an earlier preview.',
    used: 'That confirmation token has already been used. Tokens are single-use so a write cannot be applied twice; call this tool again without `confirm` if you genuinely intend to repeat the operation.',
    malformed:
        'That is not a confirmation token issued by this server. Call this tool again without `confirm` to preview the operation and use the token it returns verbatim.'
};

/**
 * Stable serialisation, so `{a:1,b:2}` and `{b:2,a:1}` produce one signature.
 * Plain `JSON.stringify` preserves insertion order, which would make an
 * otherwise-identical confirm call fail purely on key order — a failure mode
 * that would be maddening to diagnose and would train callers to distrust the
 * handshake.
 */
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

const intentPayload = (intent: WriteIntent): string =>
    canonicalize({
        tool: intent.tool,
        service: intent.service,
        tier: intent.tier,
        operation: intent.operation,
        target: intent.target,
        args: intent.args ?? {}
    });

/** Timing-safe compare that tolerates unequal lengths without leaking them. */
function signatureMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
        timingSafeEqual(b, b);
        return false;
    }
    return timingSafeEqual(a, b);
}

export class ConfirmTokens {
    readonly #key: Buffer;
    readonly #now: Clock;
    readonly #ttlMs: number;
    /** token signature → the moment it stops mattering that it was used. */
    readonly #consumed = new Map<string, number>();

    constructor(opts: { clock?: Clock; ttlMs?: number; key?: Buffer } = {}) {
        this.#key = opts.key ?? randomBytes(32);
        this.#now = opts.clock ?? Date.now;
        this.#ttlMs = opts.ttlMs ?? CONFIRM_TTL_MS;
    }

    /** `v1.<issuedAt>.<signature>` — the timestamp is in the clear because it is
     *  covered by the signature, so it cannot be edited to extend a token's life. */
    issue(intent: WriteIntent): string {
        const issuedAt = this.#now();
        return `v1.${issuedAt.toString(36)}.${this.#sign(intent, issuedAt)}`;
    }

    /**
     * Verifies **and consumes**. Deliberately one operation: a separate
     * `verify` then `consume` invites a caller to verify, perform the write,
     * and forget to consume — leaving the token replayable. The consume
     * happens before the write is attempted, so a write that fails still burns
     * the token; re-previewing after a failure is the correct flow, because the
     * failure may well have changed what the preview would say.
     */
    verifyAndConsume(presented: string, intent: WriteIntent): ConfirmResult {
        this.#sweep();

        const parts = presented.split('.');
        if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, failure: 'malformed', remedy: REMEDY.malformed };

        const issuedAt = Number.parseInt(parts[1] ?? '', 36);
        const signature = parts[2] ?? '';
        if (!Number.isFinite(issuedAt) || signature === '') {
            return { ok: false, failure: 'malformed', remedy: REMEDY.malformed };
        }

        // Expiry is checked before the signature so an old token for the right
        // operation reports "expired" rather than the misleading "mismatch".
        // A clock that went backwards (NTP step) makes `age` negative, which
        // must not read as fresh-forever, so the window is bounded both ways.
        const age = this.#now() - issuedAt;
        if (age < 0 || age > this.#ttlMs) return { ok: false, failure: 'expired', remedy: REMEDY.expired };

        if (!signatureMatches(signature, this.#sign(intent, issuedAt))) {
            return { ok: false, failure: 'mismatch', remedy: REMEDY.mismatch };
        }

        // Checked after the signature: an unsigned guess must not be able to
        // probe which tokens have been spent.
        if (this.#consumed.has(signature)) return { ok: false, failure: 'used', remedy: REMEDY.used };

        this.#consumed.set(signature, issuedAt + this.#ttlMs);
        return { ok: true };
    }

    #sign(intent: WriteIntent, issuedAt: number): string {
        return createHmac('sha256', this.#key)
            .update(`${issuedAt}\n${intentPayload(intent)}`)
            .digest('base64url');
    }

    /**
     * A consumed token only needs remembering until it would expire anyway —
     * after that the expiry check rejects it regardless, so the entry is dead
     * weight. That bounds the map by (writes per TTL window) rather than by
     * uptime.
     */
    #sweep(): void {
        const now = this.#now();
        for (const [signature, deadAt] of this.#consumed) {
            if (deadAt <= now) this.#consumed.delete(signature);
        }
        // Only reachable if a caller drives more than MAX_CONSUMED writes
        // inside one TTL window; dropping the oldest is safe because the worst
        // case is that a long-spent token becomes replayable for the remainder
        // of its window, and reaching here at all means something is very wrong.
        while (this.#consumed.size > MAX_CONSUMED) {
            const oldest = this.#consumed.keys().next().value;
            if (oldest === undefined) break;
            this.#consumed.delete(oldest);
        }
    }
}
