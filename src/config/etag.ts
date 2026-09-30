import { createHmac, randomBytes } from 'node:crypto';
import { stableJson } from './save.ts';
import type { Config } from './schema.ts';

// Per process, so a tag is no offline oracle for a guessed secret in the config.
const KEY = randomBytes(32);

/**
 * One tag for the whole config: that is what the save's drift check compares.
 * Strong, because If-Match never matches a weak tag.
 */
export const configEtag = (config: Config): string =>
    `"${createHmac('sha256', KEY).update(stableJson(config)).digest('hex').slice(0, 16)}"`;
