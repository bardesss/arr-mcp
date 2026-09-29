import type { Context } from 'hono';
import { commitConfig } from '../config/commit.ts';
import { ConfigDriftError, ConfigRejectedError } from '../config/save.ts';
import type { Config } from '../config/schema.ts';
import { logger } from '../core/logger.ts';
import { originOf } from '../web/routes.ts';
import { apiError, etagMatches } from './http.ts';
import type { ApiDeps } from './index.ts';

const STALE = 'The config changed since you read it. Read it again and retry.';

/** Returns the config now in force, or the refusal to send. */
export async function applyWrite(
    c: Context,
    deps: ApiDeps,
    what: string,
    build: (config: Config) => Config
): Promise<Config | Response> {
    const { runtime } = deps;
    const expected = runtime.config;
    if (!etagMatches(c.req.header('if-match'), expected)) return apiError(c, 412, STALE);

    let next: Config;
    try {
        next = build(expected);
    } catch (err) {
        return apiError(c, 400, (err as Error).message);
    }

    try {
        await commitConfig(runtime, expected, next);
    } catch (err) {
        if (err instanceof ConfigDriftError) return apiError(c, 412, STALE);
        if (err instanceof ConfigRejectedError) return apiError(c, 400, err.message);
        logger.error({ err }, 'config save from the management API failed');
        return apiError(c, 500, 'Saving config.yaml failed. The server log has the details.');
    }

    logger.info({ ...originOf(c), what }, 'configuration saved from the management API');
    return runtime.config;
}
