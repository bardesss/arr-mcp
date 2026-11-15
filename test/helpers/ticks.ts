/** Resolves after `n` microtask turns, so a test can choose which of several concurrent reads answers first, without timers. */
export const afterTicks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await Promise.resolve();
};
