import { loadConfig } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { buildAdapters } from '../services/registry.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { buildToolContext, type ToolContext } from '../tools/register.ts';
import type { WriteAudit } from './audit.ts';
import { ConfirmTokens } from './confirm.ts';
import { logger } from './logger.ts';
import { Sessions } from './session.ts';

/**
 * Everything a request needs that a config change can invalidate, behind one
 * swap.
 *
 * Before the config UI, `index.ts` read the config once, built the adapters
 * once, and handed both to `buildApp`, which closed over them — so changing a
 * service meant restarting the container. Editing config from a web page and
 * then telling the user to restart it would be a worse experience than the
 * hand-edited YAML it replaces.
 *
 * The swap is one assignment of an immutable snapshot, not a mutation of a
 * live object. A request that started before a reload finishes against the
 * snapshot it began with, rather than seeing half of each — which is what
 * makes "reload while a tool call is in flight" safe without any locking.
 */

export type RuntimeSnapshot = {
    config: Config;
    adapters: readonly ServiceAdapter[];
    tools: ToolContext;
};

export class Runtime {
    #snapshot: RuntimeSnapshot;
    readonly #configDir: string;
    readonly #audit: WriteAudit;

    /**
     * Deliberately outside the snapshot, and so **not** rebuilt on reload.
     *
     * Confirmation tokens span two calls by construction, and sessions span
     * many. Rebuilding either on every config change would mean a config edit
     * silently invalidated an in-flight write confirmation, or logged the
     * person making the edit out of the page they were editing from. Neither
     * is a safety property: the permission check runs again at confirm time
     * against the *new* config, so a revoked permission is still enforced.
     */
    readonly confirm: ConfirmTokens;
    readonly sessions: Sessions;

    private constructor(configDir: string, audit: WriteAudit, config: Config) {
        this.#configDir = configDir;
        this.#audit = audit;
        this.confirm = new ConfirmTokens();
        this.sessions = new Sessions();
        this.#snapshot = buildSnapshot(config, audit, this.confirm);
    }

    static async start(configDir: string, audit: WriteAudit): Promise<{ runtime: Runtime; created: boolean }> {
        const { config, created, generated } = await loadConfig(configDir);
        const runtime = new Runtime(configDir, audit, config);
        runtime.printCredentials(generated);
        return { runtime, created };
    }

    /**
     * A runtime around a config already in hand, without reading the disk.
     *
     * `adapters` overrides what would be built from the config, which is the
     * same seam every adapter already offers with its injectable `fetch`: it
     * lets a test drive real tool code against a fake service. A reload
     * rebuilds from config as normal, so the override is a starting state, not
     * a permanent replacement.
     *
     * `reload()` works if `configDir` names a real directory; with the default
     * it will fail, which is correct — a runtime that never read a file has
     * nothing to re-read.
     */
    static fromConfig(
        config: Config,
        audit: WriteAudit,
        opts: { configDir?: string; adapters?: readonly ServiceAdapter[] } = {}
    ): Runtime {
        const runtime = new Runtime(opts.configDir ?? '', audit, config);
        if (opts.adapters !== undefined) {
            runtime.#snapshot = {
                config,
                adapters: opts.adapters,
                tools: buildToolContext(opts.adapters, config, audit, runtime.confirm)
            };
        }
        return runtime;
    }

    get current(): RuntimeSnapshot {
        return this.#snapshot;
    }

    get config(): Config {
        return this.#snapshot.config;
    }

    /** Where config.yaml lives, so the config UI writes to the same directory
     *  this runtime reloads from rather than deriving it a second time. */
    get configDir(): string {
        return this.#configDir;
    }

    /**
     * Re-reads config.yaml and rebuilds everything derived from it.
     *
     * Throws rather than half-applying: `loadConfig` validates, so a config
     * that would not start the process does not replace one that is working.
     * The caller reports the error to whoever tried to save it.
     */
    async reload(): Promise<void> {
        const { config } = await loadConfig(this.#configDir);
        this.#snapshot = buildSnapshot(config, this.#audit, this.confirm);
        logger.info({ services: this.#snapshot.adapters.map(a => a.id) }, 'configuration reloaded');
    }

    /** Printed once, on the run that generates them — the password cannot be
     *  recovered afterwards, only replaced. */
    printCredentials(generated: { bearerToken?: string; password?: string; username?: string }): void {
        if (generated.password !== undefined) {
            logger.info(
                { username: generated.username ?? 'admin', password: generated.password },
                'config UI credentials — this password is not stored and will not be shown again'
            );
        }
        if (generated.bearerToken !== undefined) {
            logger.info({ token: generated.bearerToken }, 'bearer token for /mcp — also shown in the config UI');
        }
    }
}

function buildSnapshot(config: Config, audit: WriteAudit, confirm: ConfirmTokens): RuntimeSnapshot {
    const adapters = buildAdapters(config);
    return { config, adapters, tools: buildToolContext(adapters, config, audit, confirm) };
}
