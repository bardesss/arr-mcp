import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clearedSessionCookie,
    generatePassword,
    hashPassword,
    readCookie,
    sessionCookie,
    SESSION_COOKIE,
    Sessions,
    SESSIONS_FILENAME,
    verifyPassword
} from '../src/core/session.ts';

describe('password storage', () => {
    it('accepts the password it hashed', async () => {
        const stored = await hashPassword('correct horse battery staple');
        expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    });

    it('rejects a wrong password', async () => {
        const stored = await hashPassword('correct horse');
        expect(await verifyPassword('wrong horse', stored)).toBe(false);
    });

    // The password must not be recoverable from config.yaml, only replaceable.
    it('never stores the password itself', async () => {
        const stored = await hashPassword('hunter2');
        expect(stored).not.toContain('hunter2');
        expect(stored.startsWith('scrypt$')).toBe(true);
    });

    it('salts, so the same password hashes differently every time', async () => {
        expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
    });

    it('rejects a malformed or truncated stored value rather than throwing', async () => {
        for (const bad of ['', 'nonsense', 'scrypt$', 'scrypt$aa', 'bcrypt$aa$bb', 'scrypt$aa$bb']) {
            expect(await verifyPassword('x', bad), bad).toBe(false);
        }
    });

    it('does not block the event loop while hashing', async () => {
        let ticked = false;
        // A macrotask scheduled before the hash starts. With scryptSync it
        // could not run until hashing finished; with async scrypt it does.
        setTimeout(() => {
            ticked = true;
        }, 0);
        await hashPassword('some password');
        expect(ticked).toBe(true);
    });
});

describe('generated credentials', () => {
    // It is read off a terminal and retyped into a browser.
    it('generates a password with no visually ambiguous characters', () => {
        for (let i = 0; i < 25; i += 1) {
            expect(generatePassword()).not.toMatch(/[l1O0]/);
        }
    });

    it('generates a different password every time', () => {
        expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
    });
});

const stoppedClock = (start = 1_700_000_000_000) => {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('sessions', () => {
    it('accepts a token it issued', () => {
        const sessions = new Sessions();
        expect(sessions.verify(sessions.issue()).valid).toBe(true);
    });

    it('expires', () => {
        const clock = stoppedClock();
        const sessions = new Sessions({ now: clock.now, ttlMs: 1000 });
        const token = sessions.issue();

        clock.advance(1001);
        const result = sessions.verify(token);
        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.reason).toBe('expired');
    });

    // Editing the expiry must invalidate the token, not extend it.
    it('refuses a token whose expiry has been edited', () => {
        const sessions = new Sessions();
        const [, nonce, signature] = sessions.issue().split('.');
        // Same nonce and signature, an expiry pushed far into the future.
        const forged = `${(Date.now() + 999_999_999).toString(36)}.${nonce}.${signature}`;

        const result = sessions.verify(forged);
        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.reason).toBe('bad-signature');
    });

    it('refuses malformed tokens', () => {
        const sessions = new Sessions();
        for (const bad of [undefined, '', 'nonsense', 'a.b', 'a.b.c.d']) {
            expect(sessions.verify(bad).valid, String(bad)).toBe(false);
        }
    });

    // Without a nonce the token is a pure function of its expiry, so every
    // sign-in inside the same millisecond produced the same string.
    it('issues a distinct token every time, even within one millisecond', () => {
        const clock = stoppedClock();
        const sessions = new Sessions({ now: clock.now });
        const issued = new Set(Array.from({ length: 50 }, () => sessions.issue()));
        expect(issued.size).toBe(50);
    });

    // Without a shared key file, two instances have nothing in common.
    it('does not honour a token from a different instance', () => {
        expect(new Sessions().verify(new Sessions().issue()).valid).toBe(false);
    });
});

describe('renewing a session', () => {
    const HOUR = 60 * 60 * 1000;
    const setup = () => {
        const clock = stoppedClock();
        return { clock, sessions: new Sessions({ now: clock.now, ttlMs: 10 * HOUR, renewAfterMs: HOUR }) };
    };

    it('leaves a recently renewed cookie alone, so most pages set nothing', () => {
        const { clock, sessions } = setup();
        const token = sessions.issue();
        clock.advance(HOUR - 1);
        expect(sessions.renew(token)).toBeUndefined();
    });

    it('keeps someone signed in for as long as they keep coming back', () => {
        const { clock, sessions } = setup();
        let token = sessions.issue();
        for (let visit = 0; visit < 5; visit++) {
            clock.advance(9 * HOUR);
            const renewed = sessions.renew(token);
            expect(renewed).toBeDefined();
            token = renewed ?? '';
            expect(sessions.verify(token).valid).toBe(true);
        }
    });

    it('still ends a session nobody came back to', () => {
        const { clock, sessions } = setup();
        const token = sessions.issue();
        clock.advance(10 * HOUR);
        expect(sessions.renew(token)).toBeUndefined();
        expect(sessions.verify(token).valid).toBe(false);
    });

    it('never renews what it would not accept', () => {
        const { sessions } = setup();
        const stranger = new Sessions().issue();
        for (const bad of [undefined, '', 'nonsense', stranger]) expect(sessions.renew(bad)).toBeUndefined();
    });

    // A page's forms hold the CSRF token from when it loaded, and another tab can
    // renew the cookie before they are submitted.
    it('keeps a form loaded before the renewal working, and still refuses another session', () => {
        const { clock, sessions } = setup();
        const token = sessions.issue();
        const csrf = sessions.csrfFor(token);
        clock.advance(2 * HOUR);
        const renewed = sessions.renew(token) ?? '';
        expect(renewed).not.toBe(token);
        expect(sessions.csrfValid(renewed, csrf)).toBe(true);
        expect(sessions.csrfValid(sessions.issue(), csrf)).toBe(false);
    });

    it('signing out ends every copy of the session, renewed or not', () => {
        const { clock, sessions } = setup();
        const token = sessions.issue();
        clock.advance(2 * HOUR);
        const renewed = sessions.renew(token) ?? '';
        sessions.revoke(token);
        expect(sessions.verify(renewed).valid).toBe(false);
        expect(sessions.renew(renewed)).toBeUndefined();
    });

    // Revoking the older copy must not forget the nonce when that copy would have
    // expired, while the renewed one has hours left.
    it('stays signed out after the older copy would have expired', () => {
        const { clock, sessions } = setup();
        const token = sessions.issue();
        clock.advance(5 * HOUR);
        const renewed = sessions.renew(token) ?? '';
        sessions.revoke(token);
        clock.advance(6 * HOUR);
        sessions.revoke(sessions.issue()); // sweeps
        expect(sessions.verify(renewed).valid).toBe(false);
    });
});

describe('sessions across restarts', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'arr-mcp-sessions-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const restart = () => {
        const sessions = Sessions.open(dir);
        sessions.bindCredentials('hash-a');
        return sessions;
    };

    it('honours a session after a restart', () => {
        const token = restart().issue();
        expect(restart().verify(token).valid).toBe(true);
    });

    it('does not bring a signed-out session back after a restart', () => {
        const first = restart();
        const token = first.issue();
        first.revoke(token);
        expect(restart().verify(token).valid).toBe(false);
    });

    it('does not bring back sessions ended by a key rotation', () => {
        const first = restart();
        const token = first.issue();
        first.rotateKey();
        const after = first.issue();
        const second = restart();
        expect(second.verify(token).valid).toBe(false);
        expect(second.verify(after).valid).toBe(true);
    });

    // The reason restarts used to end sessions: a hand-edited password must still.
    it('ends sessions when the password hash changed while it was down', () => {
        const token = restart().issue();
        const sessions = Sessions.open(dir);
        sessions.bindCredentials('hash-b');
        expect(sessions.verify(token).valid).toBe(false);
    });

    it('ends sessions when the password hash changes on a reload', () => {
        const sessions = restart();
        const token = sessions.issue();
        sessions.bindCredentials('hash-a');
        expect(sessions.verify(token).valid).toBe(true);
        sessions.bindCredentials('hash-b');
        expect(sessions.verify(token).valid).toBe(false);
    });

    it('keeps the key out of reach of other users', async () => {
        restart();
        const { mode } = await stat(join(dir, SESSIONS_FILENAME));
        // POSIX only: Windows reports its own idea of a mode.
        if (process.platform !== 'win32') expect(mode & 0o077).toBe(0);
    });

    it('starts fresh from an unreadable file rather than failing to start', async () => {
        await writeFile(join(dir, SESSIONS_FILENAME), 'not json', 'utf8');
        const sessions = restart();
        expect(sessions.verify(sessions.issue()).valid).toBe(true);
        expect(restart().verify(sessions.issue()).valid).toBe(true);
    });

    it('still works when the file cannot be written, for this process only', () => {
        const sessions = Sessions.open(join(dir, 'missing', 'folder'));
        const token = sessions.issue();
        expect(sessions.verify(token).valid).toBe(true);
        sessions.revoke(token);
        expect(sessions.verify(token).valid).toBe(false);
    });
});

describe('csrf tokens', () => {
    it('accepts the token issued for that session', () => {
        const sessions = new Sessions();
        const session = sessions.issue();
        expect(sessions.csrfValid(session, sessions.csrfFor(session))).toBe(true);
    });

    // The point: a form stolen from one session cannot be replayed in another.
    it('refuses a token issued for a different session', () => {
        const sessions = new Sessions();
        const a = sessions.issue();
        const b = sessions.issue();
        expect(sessions.csrfValid(a, sessions.csrfFor(b))).toBe(false);
    });

    it('refuses a missing token', () => {
        const sessions = new Sessions();
        expect(sessions.csrfValid(sessions.issue(), undefined)).toBe(false);
        expect(sessions.csrfValid(undefined, 'anything')).toBe(false);
    });
});

describe('cookies', () => {
    it('reads one cookie out of several', () => {
        expect(readCookie('a=1; arr_mcp_session=xyz; b=2', SESSION_COOKIE)).toBe('xyz');
    });

    it('returns undefined when absent or when there is no header', () => {
        expect(readCookie('a=1', SESSION_COOKIE)).toBeUndefined();
        expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    });

    it('does not match a cookie whose name merely ends with the one asked for', () => {
        expect(readCookie('not_arr_mcp_session=xyz', SESSION_COOKIE)).toBeUndefined();
    });

    it('sets HttpOnly and SameSite, and deliberately not Secure', () => {
        const cookie = sessionCookie('tok', 3600);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Strict');
        // Secure would never be stored over the plain http this is served on
        // across a LAN, locking every user out.
        expect(cookie).not.toContain('Secure');
    });

    it('clears by expiring immediately', () => {
        expect(clearedSessionCookie()).toContain('Max-Age=0');
    });
});

describe('readCookie with a malformed value', () => {
    // decodeURIComponent throws on a bad escape, and sessionOf is called
    // outside any try block with no onError handler registered.
    it('treats a malformed percent-encoding as absent rather than throwing', () => {
        expect(() => readCookie('arr_mcp_session=%E0%A4', 'arr_mcp_session')).not.toThrow();
        expect(readCookie('arr_mcp_session=%E0%A4', 'arr_mcp_session')).toBeUndefined();
    });

    it('still decodes a well-formed encoded value', () => {
        expect(readCookie('k=a%20b', 'k')).toBe('a b');
    });
});

describe('ending sessions', () => {
    it('rotating the key invalidates an outstanding session', () => {
        const sessions = new Sessions();
        const token = sessions.issue();
        expect(sessions.verify(token).valid).toBe(true);

        sessions.rotateKey();
        expect(sessions.verify(token).valid).toBe(false);
    });

    it('issues usable sessions again after a rotation', () => {
        const sessions = new Sessions();
        sessions.rotateKey();
        expect(sessions.verify(sessions.issue()).valid).toBe(true);
    });

    it('a revoked session stops verifying', () => {
        const sessions = new Sessions();
        const token = sessions.issue();
        sessions.revoke(token);
        expect(sessions.verify(token).valid).toBe(false);
    });

    it('revoking one session leaves another working', () => {
        const sessions = new Sessions();
        const mine = sessions.issue();
        const theirs = sessions.issue();
        sessions.revoke(mine);
        expect(sessions.verify(theirs).valid).toBe(true);
    });

    // A forged string must not be able to grow the revocation set.
    it('ignores a token it never issued', () => {
        const sessions = new Sessions();
        expect(() => sessions.revoke('not.a.token')).not.toThrow();
        expect(() => sessions.revoke(undefined)).not.toThrow();
    });
});
