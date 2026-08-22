import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',

        // The slowest tests are slow because of what they prove — the ring
        // buffer has to overflow LOG_RING_SIZE, the VACUUM test has to write 20k
        // rows to a real file — so 1.2s and 1.5s is the floor. On a loaded
        // machine (three `vitest run` at once) everything stretches ~6x and both
        // cross vitest's 5s default, failing as if something were broken. 15s
        // still catches a hang; the reporter keeps flagging slow tests either way.
        testTimeout: 15_000,
        // Level with testTimeout, so a beforeEach doing the same I/O is not the
        // next thing to cross a lower line.
        hookTimeout: 15_000
    }
});
