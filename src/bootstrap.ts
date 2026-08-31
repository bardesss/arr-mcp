import type { Hono } from 'hono';
import { buildApp } from './app.ts';
import { ConfigInvalidError } from './config/load.ts';
import type { WriteAudit } from './core/audit.ts';
import { logger } from './core/logger.ts';
import type { LogStore } from './core/logs.ts';
import { Runtime } from './core/runtime.ts';
import type { Sessions } from './core/session.ts';
import { startRefresh } from './metadata/refresh.ts';
import { buildRepairApp } from './repair.ts';
import type { PromoteResult } from './repair.ts';

export type BootstrapDeps = {
    configDir: string;
    audit: WriteAudit;
    logs: LogStore;
    sessions: Sessions;
    version: string;
    port: number;
};

/** What `serve` needs, and the only thing the entry point takes from here. */
export type Booted = {
    fetch: (req: Request, env?: unknown) => Response | Promise<Response>;
};

/**
 * Starts normally, or — when the only thing wrong is the config's content —
 * serves the repair page until a save fixes it.
 *
 * Extracted from the entry point so the swap can be tested. The returned
 * `fetch` reads `app` on every request rather than closing over its `fetch`,
 * and that indirection is the whole restart-free promotion: bind it once and
 * a repaired instance goes on serving the repair page forever.
 */
export async function bootstrap(deps: BootstrapDeps): Promise<Booted> {
    const { configDir, audit, logs, sessions, version, port } = deps;
    let app: Hono;

    const startNormally = async (): Promise<Hono> => {
        const { runtime } = await Runtime.start(configDir, audit, {
            refresh: dataset => startRefresh(dataset),
            sessions
        });

        logger.info({ adapters: runtime.current.adapters.map(a => a.id) }, 'configuration loaded');

        if (runtime.config.auth.password_hash === undefined) {
            logger.warn(
                { port },
                `arr-mcp is not set up yet — open http://<host>:${port} to choose a username and password`
            );
        } else if (runtime.current.adapters.length === 0) {
            logger.warn(
                { config: `${configDir}/config.yaml` },
                'no services configured — add them in the config UI, or edit config.yaml'
            );
        }

        if (runtime.dataset !== undefined) {
            logger.info(
                'IMDb dataset enabled — refreshing in the background; ratings appear once the first ingest finishes'
            );
        }

        return buildApp({ runtime, audit, logs });
    };

    const promote = async (): Promise<PromoteResult> => {
        try {
            app = await startNormally();
            return { ok: true };
        } catch (err) {
            if (err instanceof ConfigInvalidError) return { ok: false, detail: err.detail };
            throw err;
        }
    };

    try {
        app = await startNormally();
    } catch (err) {
        // Only a config we could read and not understand. A volume that will
        // not write stays fatal: a repair page whose Save can never succeed is
        // worse than exiting.
        if (!(err instanceof ConfigInvalidError)) throw err;
        logger.error(
            { config: `${configDir}/config.yaml` },
            `config.yaml is invalid — serving the repair page only:\n${err.detail}`
        );
        app = buildRepairApp({ configDir, sessions, version, failure: err, onPromote: promote });
    }

    // `env` is forwarded rather than dropped: node-server passes
    // `{ incoming, outgoing }` there, and nothing reads it yet.
    return { fetch: (req, env) => app.fetch(req, env) };
}
