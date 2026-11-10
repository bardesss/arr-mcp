import type { Server } from 'node:http';
import { logger } from './core/logger.ts';

/** Under `docker stop`'s 10 s, so the process leaves by itself before SIGKILL. */
const SHUTDOWN_DEADLINE_MS = 8_000;

/** How long open connections get to finish before they are cut. */
const DRAIN_GRACE_MS = 5_000;

export type ShutdownStep = { name: string; run: () => void | Promise<void> };

/**
 * One shutdown for every way the process is asked to stop. The steps run in
 * order and a failing one is logged without skipping the rest: a stuck HTTP
 * drain must not leave the databases unclosed. A step that never returns is
 * cut off by the deadline, which exits 1 so the supervisor sees it.
 *
 * Calling it again, as when SIGTERM and SIGINT arrive together, returns the
 * first run's promise.
 */
export function createShutdown(
    steps: readonly ShutdownStep[],
    opts: { deadlineMs?: number; exit?: (code: number) => void } = {}
): (reason: string) => Promise<void> {
    const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
    const exit = opts.exit ?? ((code: number) => process.exit(code));
    let running: Promise<void> | undefined;

    return reason => (running ??= (async () => {
        logger.info({ reason }, 'shutting down');
        const timer = setTimeout(() => {
            logger.error({ deadlineMs }, 'shutdown overran its deadline; exiting anyway');
            exit(1);
        }, deadlineMs);
        for (const step of steps) {
            try {
                await step.run();
            } catch (err) {
                logger.warn({ err, step: step.name }, 'shutdown step failed');
            }
        }
        clearTimeout(timer);
        logger.info('shut down cleanly');
        exit(0);
    })());
}

/**
 * Stop accepting, let in-flight requests finish for `graceMs`, then cut what is
 * left. `server.close` alone waits for keep-alive and streaming connections
 * (an MCP client holds one open) for as long as they last.
 */
export function closeServer(server: Server, graceMs: number = DRAIN_GRACE_MS): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(() => server.closeAllConnections(), graceMs);
        server.close(() => {
            clearTimeout(timer);
            resolve();
        });
        server.closeIdleConnections();
    });
}
