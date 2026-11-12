import { createHmac, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomicSync } from './atomicFile.ts';
import { logger } from './logger.ts';
import { constantTimeEquals } from './secrets.ts';

/**
 * Password storage and browser sessions for the config UI.
 *
 * The UI is a bigger target than the MCP endpoint: it shows every service's API
 * key and can change them. So the password is never stored, only a scrypt
 * hash, and the session cookie is a signed, expiring token rather than an
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
 * `options` field is currently belt-and-braces; it stops being redundant the
 * day `SCRYPT_N` changes.
 */
const scrypt = promisify(scryptCallback) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number }
) => Promise<Buffer>;

export const SESSION_COOKIE = 'arr_mcp_session';

/** How long a session lasts since someone last opened a page. Long enough that
 *  checking in on the stack now and then never asks for the password; a forgotten
 *  browser on a shared machine is what signing out is for. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Once a cookie is this old it is renewed on the next page load. Not on every
 *  one: a Set-Cookie per page is noise for a window measured in weeks. */
const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;

/** Beside config.yaml, which already holds every API key and the password hash. */
export const SESSIONS_FILENAME = 'sessions.json';

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

export function generatePassword(length = 18): string {
    // `randomInt` draws without modulo bias: a byte taken modulo the alphabet's
    // 57 characters made the first 28 slightly likelier than the rest.
    let out = '';
    for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
    return out;
}

type SessionVerdict =
    | { valid: true }
    | { valid: false; reason: 'malformed' | 'expired' | 'bad-signature' | 'revoked' };

/**
 * Signed cookies over a server-side session table, deliberately.
 *
 * A table would have to live somewhere; memory, which loses every session on
 * the restart a config change already causes, or SQLite, which is a third
 * database for something with no audit value. A signed token needs neither,
 * and `open` keeps the key in a file, so a restart or an update does not sign
 * anyone out.
 *
 * Restarts used to end sessions because the credentials may have changed. So the
 * signing key is now derived from the password hash too (`bindCredentials`): a
 * new hash ends every session, whether it came from the config UI or a hand edit
 * to config.yaml. Ending sessions otherwise stays explicit: `rotateKey` for all
 * of them, `revoke` for one. Both are written down, or a restart would undo them.
 */
export class Sessions {
    /** What the file holds. `#key` is this, mixed with the password hash. */
    #baseKey: Buffer;
    #key: Buffer;
    #credentials: string | undefined;
    readonly #ttlMs: number;
    readonly #renewAfterMs: number;
    readonly #now: () => number;
    /** Undefined keeps everything in memory, for this process only. */
    readonly #path: string | undefined;
    /** nonce → when no token with that nonce can still be valid. */
    readonly #revoked = new Map<string, number>();

    constructor(
        opts: { ttlMs?: number; renewAfterMs?: number; now?: () => number; key?: Buffer; path?: string } = {}
    ) {
        this.#baseKey = opts.key ?? randomBytes(32);
        this.#key = this.#baseKey;
        this.#ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
        this.#renewAfterMs = opts.renewAfterMs ?? SESSION_RENEW_AFTER_MS;
        this.#now = opts.now ?? Date.now;
        this.#path = opts.path;
    }

    /**
     * Sessions that outlive a restart.
     *
     * Never throws. Losing this file costs a sign-in, which is no reason to keep
     * the server from starting: an unreadable one is replaced, and if none can be
     * written sessions last as long as the process, as they would without a file.
     */
    static open(configDir: string): Sessions {
        const path = join(configDir, SESSIONS_FILENAME);
        const stored = readStored(path);
        const sessions = new Sessions({ path, ...(stored === undefined ? {} : { key: stored.key }) });
        if (stored === undefined) {
            sessions.#persist();
            return sessions;
        }
        const now = sessions.#now();
        for (const [nonce, deadAt] of stored.revoked) {
            if (deadAt > now) sessions.#revoked.set(nonce, deadAt);
        }
        return sessions;
    }

    /**
     * Ties every session to the password hash it was issued under. Called whenever
     * the config is read, so a changed hash ends them all, and an unchanged one does
     * nothing, which is the common case on reload.
     */
    bindCredentials(passwordHash: string | undefined): void {
        if (passwordHash === this.#credentials) return;
        this.#credentials = passwordHash;
        this.#key = this.#derivedKey();
    }

    #derivedKey(): Buffer {
        if (this.#credentials === undefined) return this.#baseKey;
        return createHmac('sha256', this.#baseKey).update(`credentials\n${this.#credentials}`).digest();
    }

    /**
     * `<expiresAt base36>.<nonce>.<hmac>`; the expiry is in the clear because
     * it is signed, so editing it invalidates the token rather than extending
     * it.
     *
     * The nonce is what makes each session distinct. Without it the token is a
     * pure function of its expiry, so every sign-in within the same
     * millisecond produces the *same* token, which a test caught. That is not
     * an authentication hole on its own (any valid token grants access, and
     * there are no per-user identities here), but it makes the CSRF binding
     * below meaningless between colliding sessions, and it means signing out
     * of one browser would hand the same string to the next.
     */
    issue(): string {
        return this.#tokenFor(randomBytes(12).toString('base64url'));
    }

    /**
     * The same session with a later expiry, or undefined when the cookie should be
     * left as it is: too recent to be worth replacing, or not valid at all.
     *
     * The nonce stays, because it is the session's identity. A form already on
     * screen stays valid (`csrfFor`), and signing out ends every copy (`revoke`).
     * An older copy stays usable until its own expiry, which a stateless token
     * cannot avoid and which grants nothing the renewed one does not.
     */
    renew(token: string | undefined): string | undefined {
        if (token === undefined || !this.verify(token).valid) return undefined;
        const parts = token.split('.');
        const issuedAt = Number.parseInt(parts[0] ?? '', 36) - this.#ttlMs;
        if (this.#now() - issuedAt < this.#renewAfterMs) return undefined;
        return this.#tokenFor(parts[1] ?? '');
    }

    #tokenFor(nonce: string): string {
        const expiresAt = this.#now() + this.#ttlMs;
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
     * Changing the password also changes the hash `bindCredentials` mixes in, so
     * this is the second lock on that door, and the one that holds if the hash ever
     * stops being what changed.
     */
    rotateKey(): void {
        this.#baseKey = randomBytes(32);
        this.#key = this.#derivedKey();
        // Nonces signed with the old key can no longer verify anyway.
        this.#revoked.clear();
        this.#persist();
    }

    /**
     * Ends one session. Only a token that verifies is remembered, so a forged
     * string cannot grow the set, and only until it would have expired anyway.
     *
     * A full window from now, not this token's own expiry: this may be an older copy
     * of a session that has since been renewed, and the nonce has to outlast the
     * newest copy. Nothing can renew it from here on.
     */
    revoke(token: string | undefined): void {
        if (token === undefined || !this.verify(token).valid) return;
        const nonce = token.split('.')[1] ?? '';
        this.#revoked.set(nonce, this.#now() + this.#ttlMs);
        this.#sweep();
        this.#persist();
    }

    /** Atomic, so a crash mid-write cannot leave half a key. Failing costs only what
     *  the file was for: the next restart signs everyone out. */
    #persist(): void {
        if (this.#path === undefined) return;
        try {
            const body = { key: this.#baseKey.toString('hex'), revoked: Object.fromEntries(this.#revoked) };
            writeFileAtomicSync(this.#path, JSON.stringify(body));
        } catch (err) {
            logger.warn(
                { code: (err as NodeJS.ErrnoException).code },
                'could not save UI sessions; a restart will sign everyone out'
            );
        }
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
     *
     * Over the nonce rather than the whole token, because renewing replaces the
     * token while a page's forms still hold what they were rendered with.
     */
    csrfFor(sessionToken: string): string {
        const nonce = sessionToken.split('.')[1] ?? sessionToken;
        return createHmac('sha256', this.#key).update(`csrf\n${nonce}`).digest('base64url');
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

/** Undefined for anything missing or not ours, which `open` treats as a first run. */
function readStored(path: string): { key: Buffer; revoked: [string, number][] } | undefined {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { key?: unknown; revoked?: unknown };
        if (typeof parsed.key !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.key)) throw new Error('no usable key');
        const revoked = typeof parsed.revoked === 'object' && parsed.revoked !== null ? Object.entries(parsed.revoked) : [];
        return {
            key: Buffer.from(parsed.key, 'hex'),
            revoked: revoked.filter((row): row is [string, number] => typeof row[1] === 'number')
        };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(`${SESSIONS_FILENAME} could not be read, so everyone has to sign in again`);
        }
        return undefined;
    }
}

/** Minimal cookie parser; the UI sets one cookie and reads one cookie, and a
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
 * `Secure` is added only when the page was reached over https. Plain http on a
 * LAN is supported by design (the README tells people to use it), and a Secure
 * cookie would never be stored there, so it must stay off for that case or it
 * would lock everyone out. HttpOnly and SameSite=Strict apply either way.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure = false): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export const clearedSessionCookie = (secure = false): string =>
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
