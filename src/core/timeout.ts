export const TIMED_OUT: unique symbol = Symbol('timed out');

export type Deadline = {
    race<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT>;
    clear(): void;
};

/** One budget shared by several reads: each `race` gets whatever is left of it. */
export function deadline(ms: number): Deadline {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof TIMED_OUT>(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref();
    });
    return {
        race: work => Promise.race([work, expired]),
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
