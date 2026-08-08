import { loadConfig } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { IMDB_FILENAME, ImdbDataset } from '../metadata/imdbDataset.ts';
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

/**
 * What `fromConfig` uses when a test gives it no directory: a runtime that
 * cannot reload, and must not write anything beside a config file it does not
 * have.
 */
const NO_CONFIG_DIR = '';

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

    /**
     * The IMDb dataset, when `metadata.imdb.enabled` is on.
     *
     * Outside the snapshot for the same reason as the two above, and a
     * stronger one: it is a database that can take twenty minutes to build,
     * and rebuilding it because someone changed a timeout would be absurd. A
     * reload only opens or closes it when the config's answer actually
     * changed.
     *
     * Opening is all this class does. Keeping it *fresh* is `startRefresh`,
     * which the entry point calls — so constructing a Runtime never reaches
     * the network, and no test has to opt out of a download it did not ask
     * for.
     */
    #dataset: ImdbDataset | undefined;

    get dataset(): ImdbDataset | undefined {
        return this.#dataset;
    }

    private constructor(configDir: string, audit: WriteAudit, config: Config) {
        this.#configDir = configDir;
        this.#audit = audit;
        this.confirm = new ConfirmTokens();
        this.sessions = new Sessions();
        // Before the snapshot, not after: the tool context closes over the
        // dataset, so it has to exist by the time it is built.
        this.#syncDataset(config);
        this.#snapshot = buildSnapshot(config, audit, this.confirm, this.#dataset);
    }

    /**
     * Open or close the dataset to match the config, and do nothing at all
     * when the answer has not changed — which is the common case on reload.
     *
     * `ImdbDataset.open` touches the filesystem, so it is skipped entirely
     * when there is no real config directory: `fromConfig`'s default is a
     * placeholder, and a test that never asked for a dataset must not have one
     * written beside it.
     */
    #syncDataset(config: Config): void {
        const wanted = config.metadata?.imdb?.enabled === true && this.#configDir !== NO_CONFIG_DIR;

        if (wanted && this.#dataset === undefined) {
            this.#dataset = ImdbDataset.open(this.#configDir);
            logger.info({ file: IMDB_FILENAME }, 'IMDb dataset opened');
            return;
        }

        if (!wanted && this.#dataset !== undefined) {
            this.#dataset.close();
            this.#dataset = undefined;
            logger.info('IMDb dataset closed — no longer enabled');
        }
    }

    static async start(configDir: string, audit: WriteAudit): Promise<{ runtime: Runtime; created: boolean }> {
        const { config, created } = await loadConfig(configDir);
        return { runtime: new Runtime(configDir, audit, config), created };
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
        const runtime = new Runtime(opts.configDir ?? NO_CONFIG_DIR, audit, config);
        if (opts.adapters !== undefined) {
            runtime.#snapshot = {
                config,
                adapters: opts.adapters,
                tools: buildToolContext(opts.adapters, config, audit, runtime.confirm, runtime.dataset)
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
        this.#syncDataset(config);
        this.#snapshot = buildSnapshot(config, this.#audit, this.confirm, this.#dataset);
        logger.info({ services: this.#snapshot.adapters.map(a => a.id) }, 'configuration reloaded');
    }

}

function buildSnapshot(
    config: Config,
    audit: WriteAudit,
    confirm: ConfirmTokens,
    dataset: ImdbDataset | undefined
): RuntimeSnapshot {
    const adapters = buildAdapters(config);
    return { config, adapters, tools: buildToolContext(adapters, config, audit, confirm, dataset) };
}
