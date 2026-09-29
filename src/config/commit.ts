import type { Runtime } from '../core/runtime.ts';
import { saveConfig } from './save.ts';
import type { Config } from './schema.ts';

/** Writes `next` if the file still matches `expected`, then applies it. */
export async function commitConfig(runtime: Runtime, expected: Config, next: Config): Promise<void> {
    await saveConfig(runtime.configDir, next, { expected });
    await runtime.reload();
}
