/**
 * Runs tasks one after another, in call order. A rejected task rejects for its
 * caller only; the next one still runs.
 */
export function serial(): <T>(task: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(task: () => Promise<T>): Promise<T> => {
        const run = tail.then(task, task);
        tail = run.catch(() => undefined);
        return run;
    };
}
