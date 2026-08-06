import { describe, expect, it } from 'vitest';
import { ConfirmTokens, CONFIRM_TTL_MS, type WriteIntent } from '../src/core/confirm.ts';

const intent = (over: Partial<WriteIntent> = {}): WriteIntent => ({
    tool: 'delete_media',
    service: 'radarr',
    tier: 'destructive',
    operation: 'delete_movie',
    target: '5',
    args: { deleteFiles: true },
    ...over
});

/** A clock the test drives, so expiry is asserted rather than waited for. */
const stoppedClock = (start = 1_700_000_000_000) => {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('confirmation tokens', () => {
    it('accepts a token for the operation it was issued for', () => {
        const tokens = new ConfirmTokens();
        const token = tokens.issue(intent());
        expect(tokens.verifyAndConsume(token, intent()).ok).toBe(true);
    });

    // The property that makes the handshake worth having: previewing something
    // harmless must not yield a token that authorises something else.
    it('refuses a token issued for a different target', () => {
        const tokens = new ConfirmTokens();
        const token = tokens.issue(intent({ target: '5' }));

        const result = tokens.verifyAndConsume(token, intent({ target: '9' }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure).toBe('mismatch');
    });

    it('refuses a token when an effect-bearing argument changed', () => {
        const tokens = new ConfirmTokens();
        const token = tokens.issue(intent({ args: { deleteFiles: false } }));

        const result = tokens.verifyAndConsume(token, intent({ args: { deleteFiles: true } }));
        expect(result.ok).toBe(false);
    });

    it('refuses a token issued for a different tool or operation', () => {
        const tokens = new ConfirmTokens();
        const token = tokens.issue(intent());

        expect(tokens.verifyAndConsume(token, intent({ tool: 'other_tool' })).ok).toBe(false);
        expect(tokens.verifyAndConsume(token, intent({ operation: 'unmonitor_movie' })).ok).toBe(false);
    });

    // Key order is an accident of how the object was built; failing on it would
    // be maddening to diagnose and would train callers to distrust the handshake.
    it('does not care about argument key order', () => {
        const tokens = new ConfirmTokens();
        const token = tokens.issue(intent({ args: { a: 1, b: 2 } }));
        expect(tokens.verifyAndConsume(token, intent({ args: { b: 2, a: 1 } })).ok).toBe(true);
    });

    it('is single-use, so one preview cannot be applied twice', () => {
        const tokens = new ConfirmTokens();
        const token = tokens.issue(intent());

        expect(tokens.verifyAndConsume(token, intent()).ok).toBe(true);
        const second = tokens.verifyAndConsume(token, intent());
        expect(second.ok).toBe(false);
        if (second.ok) return;
        expect(second.failure).toBe('used');
    });

    it('expires', () => {
        const clock = stoppedClock();
        const tokens = new ConfirmTokens({ clock: clock.now });
        const token = tokens.issue(intent());

        clock.advance(CONFIRM_TTL_MS + 1);
        const result = tokens.verifyAndConsume(token, intent());
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure).toBe('expired');
    });

    // Reported as expired rather than mismatched, so the remedy tells the caller
    // to re-preview rather than to go hunting for an argument that differs.
    it('reports an expired token as expired even when the operation still matches', () => {
        const clock = stoppedClock();
        const tokens = new ConfirmTokens({ clock: clock.now });
        const token = tokens.issue(intent());

        clock.advance(CONFIRM_TTL_MS * 2);
        const result = tokens.verifyAndConsume(token, intent());
        if (result.ok) throw new Error('expected a rejection');
        expect(result.failure).toBe('expired');
    });

    // An NTP step backwards must not make a token valid forever.
    it('refuses a token that claims to be from the future', () => {
        const clock = stoppedClock();
        const tokens = new ConfirmTokens({ clock: clock.now });
        const token = tokens.issue(intent());

        clock.advance(-60_000);
        const result = tokens.verifyAndConsume(token, intent());
        expect(result.ok).toBe(false);
    });

    it('rejects a forged token rather than trusting its timestamp', () => {
        const tokens = new ConfirmTokens();
        const forged = `v1.${Date.now().toString(36)}.not-a-real-signature`;

        const result = tokens.verifyAndConsume(forged, intent());
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure).toBe('mismatch');
    });

    it('rejects malformed tokens', () => {
        const tokens = new ConfirmTokens();
        for (const bad of ['', 'nonsense', 'v2.abc.def', 'v1.abc']) {
            const result = tokens.verifyAndConsume(bad, intent());
            expect(result.ok, bad).toBe(false);
        }
    });

    // Two servers, or one server restarted, must not honour each other's tokens.
    it('does not honour a token from a different instance', () => {
        const a = new ConfirmTokens();
        const b = new ConfirmTokens();
        expect(b.verifyAndConsume(a.issue(intent()), intent()).ok).toBe(false);
    });

    it('every rejection carries a remedy saying what to do next', () => {
        const tokens = new ConfirmTokens();
        const result = tokens.verifyAndConsume('nonsense', intent());
        if (result.ok) throw new Error('expected a rejection');
        expect(result.remedy.length).toBeGreaterThan(20);
    });
});
