import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password storage and browser sessions for the config UI.
 *
 * The UI is a bigger target than the MCP endpoint: it shows every service's API
 * key and can change them. So the password is never stored — only a scrypt
 * hash — and the session cookie is a signed, expiring token rather than an
 * identifier looked up in a table, which keeps the transport stateless while
 * still expiring properly.
 */

/** scrypt parameters. N=16384 is the Node default and costs ~50ms here, which
 *  is the point: it makes a stolen hash expensive to attack, and a login form
 *  is not a hot path. */
const SCRYPT_N = 16_384;
const KEY_LENGTH = 64;

/**
 * Async, not `scryptSync`: at N=16384 the sync form blocks the one thread the
 * MCP endpoint runs on, so a burst of logins stalls every tool call.
 *
 * `SCRYPT_N` equals `crypto.scrypt`'s own default cost, so the cast's
 * `options` field is currently belt-and-braces — it stops being redundant the
 * day `SCRYPT_N` changes.
 */
const scrypt = promisify(scryptCallback) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number }
) => Promise<Buffer>;

export const SESSION_COOKIE = 'arr_mcp_session';

/** Long enough not to interrupt a config edit; short enough that a forgotten
 *  browser on a shared machine stops mattering the same day. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Defensive bound on the revoked-nonce set, which is otherwise TTL-swept. */
const MAX_REVOKED = 1024;

/** `scrypt$<saltHex>$<hashHex>`, so the format names its own algorithm and a
 *  future change can be detected rather than guessed. */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N });
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || saltHex === undefined || hashHex === undefined) return false;

    let expected: Buffer;
    try {
        expected = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }
    if (expected.length !== KEY_LENGTH) return false;

    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH, { N: SCRYPT_N });
    return timingSafeEqual(actual, expected);
}

/** A readable password someone can retype from a terminal without misreading
 *  it. No `l`, `1`, `O` or `0`; length carries the entropy instead (~93 bits). */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 32 random bytes as hex — the 64 characters `ConfigSchema` requires, and the
 *  same shape `loadConfig` generates on first run. */
export const generateBearerToken = (): string => randomBytes(32).toString('hex');

export function generatePassword(length = 18): string {
    const bytes = randomBytes(length);
    let out = '';
    for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
    return out;
}

export type SessionVerdict =
    | { valid: true }
    | { valid: false; reason: 'malformed' | 'expired' | 'bad-signature' | 'revoked' };

/**
 * Signed cookies over a server-side session table, deliberately.
 *
 * A table would have to live somewhere — memory, which loses every session on
 * the restart a config change already causes, or SQLite, which is a third
 * database for something with no audit value. A signed token needs neither,
 * and the key being per-process means a restart invalidates outstanding
 * sessions.
 *
 * A restart is not the only way credentials change, though: the config UI
 * changes them through `reload()`, and `runtime.sessions` deliberately
 * survives that. So ending sessions is explicit — `rotateKey` for all of them,
 * `revoke` for one — rather than a side effect of the process lifecycle.
 */
export class Sessions {
    #key: Buffer;
    readonly #ttlMs: number;
    readonly #now: () => number;
    /** nonce → the moment that token would have expired anyway. */
    readonly #revoked = new Map<string, number>();

    constructor(opts: { ttlMs?: number; now?: () => number; key?: Buffer } = {}) {
        this.#key = opts.key ?? randomBytes(32);
        this.#ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
        this.#now = opts.now ?? Date.now;
    }

    /**
     * `<expiresAt base36>.<nonce>.<hmac>` — the expiry is in the clear because
     * it is signed, so editing it invalidates the token rather than extending
     * it.
     *
     * The nonce is what makes each session distinct. Without it the token is a
     * pure function of its expiry, so every sign-in within the same
     * millisecond produces the *same* token — which a test caught. That is not
     * an authentication hole on its own (any valid token grants access, and
     * there are no per-user identities here), but it makes the CSRF binding
     * below meaningless between colliding sessions, and it means signing out
     * of one browser would hand the same string to the next.
     */
    issue(): string {
        const expiresAt = this.#now() + this.#ttlMs;
        const nonce = randomBytes(12).toString('base64url');
        return `${expiresAt.toString(36)}.${nonce}.${this.#sign(expiresAt, nonce)}`;
    }

    verify(token: string | undefined): SessionVerdict {
        if (token === undefined || token === '') return { valid: false, reason: 'malformed' };

        const parts = token.split('.');
        if (parts.length !== 3) return { valid: false, reason: 'malformed' };

        const expiresAt = Number.parseInt(parts[0] ?? '', 36);
        const nonce = parts[1] ?? '';
        const signature = parts[2] ?? '';
        if (!Number.isFinite(expiresAt) || nonce === '' || signature === '') {
            return { valid: false, reason: 'malformed' };
        }

        // Signature before expiry: an unsigned guess must not learn whether a
        // given expiry is in range.
        if (!constantTimeEquals(signature, this.#sign(expiresAt, nonce))) {
            return { valid: false, reason: 'bad-signature' };
        }
        if (this.#now() >= expiresAt) return { valid: false, reason: 'expired' };
        if (this.#revoked.has(nonce)) return { valid: false, reason: 'revoked' };

        return { valid: true };
    }

    /**
     * Ends every outstanding session.
     *
     * The stateless-token design above assumes a restart follows a credential
     * change. Changing the password from the config UI reloads rather than
     * restarts, and `sessions` deliberately survives a reload, so the rotation
     * has to be explicit.
     */
    rotateKey(): void {
        this.#key = randomBytes(32);
        // Nonces signed with the old key can no longer verify anyway.
        this.#revoked.clear();
    }

    /**
     * Ends one session. Only a token that verifies is remembered, so a forged
     * string cannot grow the set, and only until it would have expired anyway.
     */
    revoke(token: string | undefined): void {
        if (token === undefined || !this.verify(token).valid) return;
        const parts = token.split('.');
        const nonce = parts[1] ?? '';
        this.#revoked.set(nonce, Number.parseInt(parts[0] ?? '', 36));
        this.#sweep();
    }

    #sweep(): void {
        const now = this.#now();
        for (const [nonce, deadAt] of this.#revoked) {
            if (deadAt <= now) this.#revoked.delete(nonce);
        }
        while (this.#revoked.size > MAX_REVOKED) {
            const oldest = this.#revoked.keys().next().value;
            if (oldest === undefined) break;
            this.#revoked.delete(oldest);
        }
    }

    /**
     * A CSRF token bound to the session cookie, so a form stolen from one
     * session cannot be replayed in another. SameSite=Strict already blocks
     * the common case; this covers the rest, and costs one hidden input.
     */
    csrfFor(sessionToken: string): string {
        return createHmac('sha256', this.#key).update(`csrf\n${sessionToken}`).digest('base64url');
    }

    csrfValid(sessionToken: string | undefined, presented: string | undefined): boolean {
        if (sessionToken === undefined || presented === undefined) return false;
        return constantTimeEquals(presented, this.csrfFor(sessionToken));
    }

    #sign(expiresAt: number, nonce: string): string {
        // Newline separated so a nonce cannot be shifted into the expiry to
        // forge a different pair with the same signature.
        return createHmac('sha256', this.#key).update(`${expiresAt}\n${nonce}`).digest('base64url');
    }
}

/** Tolerates unequal lengths without leaking them by timing. */
export function constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
        timingSafeEqual(right, right);
        return false;
    }
    return timingSafeEqual(left, right);
}

/** Minimal cookie parser — the UI sets one cookie and reads one cookie, and a
 *  dependency for that would be a dependency to audit. */
export function readCookie(header: string | undefined, name: string): string | undefined {
    if (header === undefined) return undefined;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        if (part.slice(0, index).trim() === name) {
            try {
                return decodeURIComponent(part.slice(index + 1).trim());
            } catch {
                // A cookie we cannot decode is one we did not issue. Throwing
                // here reached the route guard, which has no handler above it.
                return undefined;
            }
        }
    }
    return undefined;
}

/**
 * `Secure` is deliberately absent: this is reached over plain http:// on a LAN
 * by design (the README tells people to use http on the LAN), and a Secure
 * cookie would simply never be stored, locking everyone out. HttpOnly and
 * SameSite=Strict are what actually matter here.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export const clearedSessionCookie = (): string =>
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
