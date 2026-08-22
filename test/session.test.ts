import { describe, expect, it } from 'vitest';
import {
    clearedSessionCookie,
    generateBearerToken,
    generatePassword,
    hashPassword,
    readCookie,
    sessionCookie,
    SESSION_COOKIE,
    Sessions,
    verifyPassword
} from '../src/core/session.ts';

describe('password storage', () => {
    it('accepts the right password', () => {
        const stored = hashPassword('correct horse battery staple');
        expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    });

    it('rejects the wrong one', () => {
        const stored = hashPassword('correct horse');
        expect(verifyPassword('wrong horse', stored)).toBe(false);
    });

    // The password must not be recoverable from config.yaml, only replaceable.
    it('never stores the password itself', () => {
        const stored = hashPassword('hunter2');
        expect(stored).not.toContain('hunter2');
        expect(stored.startsWith('scrypt$')).toBe(true);
    });

    it('salts, so the same password hashes differently every time', () => {
        expect(hashPassword('same')).not.toBe(hashPassword('same'));
    });

    it('rejects a malformed or truncated stored value rather than throwing', () => {
        for (const bad of ['', 'nonsense', 'scrypt$', 'scrypt$aa', 'bcrypt$aa$bb', 'scrypt$aa$bb']) {
            expect(verifyPassword('x', bad), bad).toBe(false);
        }
    });
});

describe('generated credentials', () => {
    it('generates a bearer token of the length the schema requires', () => {
        expect(generateBearerToken()).toMatch(/^[0-9a-f]{64}$/);
    });

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

    // A restart should log everyone out — the credentials may have changed.
    it('does not honour a token from a different instance', () => {
        expect(new Sessions().verify(new Sessions().issue()).valid).toBe(false);
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
