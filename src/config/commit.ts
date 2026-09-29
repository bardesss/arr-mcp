import { logger } from '../core/logger.ts';
import type { Runtime } from '../core/runtime.ts';
import { ConfigInvalidError } from './load.ts';
import { ConfigDriftError, ConfigUnloadableError, saveConfig } from './save.ts';
import type { Config } from './schema.ts';

/** Writes `next` if the file still matches `expected`, then applies it. */
export async function commitConfig(runtime: Runtime, expected: Config, next: Config): Promise<void> {
    try {
        await saveConfig(runtime.configDir, next, { expected });
    } catch (err) {
        // Pick up the hand edit, so reading again and retrying can succeed.
        if (err instanceof ConfigDriftError) {
            try {
                await runtime.reload();
            } catch (reloadErr) {
                // The reason only: the error object can carry the salvaged auth block.
                const reason = reloadErr instanceof ConfigInvalidError ? reloadErr.detail : String((reloadErr as Error)?.message ?? reloadErr);
                logger.warn({ reason }, 'config.yaml changed on disk and does not load; keeping the running config');
                throw new ConfigUnloadableError();
            }
        }
        throw err;
    }
    await runtime.reload();
}
