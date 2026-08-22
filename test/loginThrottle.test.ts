import { describe, expect, it } from 'vitest';
import { FREE_ATTEMPTS, LoginThrottle } from '../src/core/loginThrottle.ts';

/** Injected clock rather than fake timers: the throttle only ever asks what
 *  time it is, so a counter is a truthful stand-in and the tests stay sync. */
const at = (start = 0) => {
    let now = start;
    return { clock: () => now, advance: (ms: number) => (now += ms) };
};

describe('LoginThrottle', () => {
    it('allows the first attempts without delay', () => {
        const { clock } = at();
        const throttle = new LoginThrottle(clock);
        for (let i = 0; i < FREE_ATTEMPTS; i++) {
            expect(throttle.blockedFor()).toBe(0);
            throttle.recordFailure();
        }
    });

    it('blocks once the free attempts are spent', () => {
        const { clock } = at();
        const throttle = new LoginThrottle(clock);
        for (let i = 0; i < FREE_ATTEMPTS; i++) throttle.recordFailure();
        expect(throttle.blockedFor()).toBeGreaterThan(0);
    });

    it('lengthens the block with each further failure', () => {
        const { clock, advance } = at();
        const throttle = new LoginThrottle(clock);
        for (let i = 0; i < FREE_ATTEMPTS; i++) throttle.recordFailure();

        const first = throttle.blockedFor();
        advance(first);
        expect(throttle.blockedFor()).toBe(0);

        throttle.recordFailure();
        expect(throttle.blockedFor()).toBeGreaterThan(first);
    });

    it('caps the block so a locked-out operator is not locked out forever', () => {
        const { clock, advance } = at();
        const throttle = new LoginThrottle(clock);
        for (let i = 0; i < 40; i++) {
            throttle.recordFailure();
            advance(throttle.blockedFor());
        }
        throttle.recordFailure();
        expect(throttle.blockedFor()).toBeLessThanOrEqual(5 * 60_000);
    });

    it('forgets the failures after a success', () => {
        const { clock, advance } = at();
        const throttle = new LoginThrottle(clock);
        for (let i = 0; i < FREE_ATTEMPTS; i++) throttle.recordFailure();
        advance(throttle.blockedFor());

        throttle.recordSuccess();
        for (let i = 0; i < FREE_ATTEMPTS; i++) {
            expect(throttle.blockedFor()).toBe(0);
            throttle.recordFailure();
        }
    });
});
