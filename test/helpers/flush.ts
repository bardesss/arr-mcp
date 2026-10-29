/** One turn of the event loop: every promise continuation already queued has run when it resolves. */
export const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
