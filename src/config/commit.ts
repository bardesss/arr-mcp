import { logger } from '../core/logger.ts';
import type { Runtime } from '../core/runtime.ts';
import { ConfigDriftError, saveConfig } from './save.ts';
import type { Config } from './schema.ts';

/** Writes `next` if the file still matches `expected`, then applies it. */
export async function commitConfig(runtime: Runtime, expected: Config, next: Config): Promise<void> {
    try {
        await saveConfig(runtime.configDir, next, { expected });
    } catch (err) {
        // Pick up the hand edit, so reading again and retrying can succeed.
        if (err instanceof ConfigDriftError) {
            await runtime.reload().catch((reloadErr: unknown) => {
                logger.warn({ err: reloadErr }, 'config.yaml changed on disk and does not load; keeping the running config');
            });
        }
        throw err;
    }
    await runtime.reload();
}
