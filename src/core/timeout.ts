export const TIMED_OUT: unique symbol = Symbol('timed out');

export type Deadline = {
    race<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT>;
    /** True once the budget has run out, so a caller can skip a read that could only be discarded. */
    expired(): boolean;
    clear(): void;
};

/** One budget shared by several reads: each `race` gets whatever is left of it. */
export function deadline(ms: number): Deadline {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over = false;
    const expired = new Promise<typeof TIMED_OUT>(resolve => {
        timer = setTimeout(() => {
            over = true;
            resolve(TIMED_OUT);
        }, ms);
        timer.unref();
    });
    return {
        race: work => Promise.race([work, expired]),
        expired: () => over,
        clear: () => clearTimeout(timer)
    };
}

export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    const budget = deadline(ms);
    try {
        return await budget.race(work);
    } finally {
        budget.clear();
    }
}
