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
 * Everything a config change can invalidate, behind one swap — so editing
 * config from the web page takes effect without restarting the container.
 *
 * The swap is one assignment of an immutable snapshot, never a mutation of a
 * live object. A request that started before a reload finishes against the
 * snapshot it began with rather than seeing half of each, which is what makes
 * "reload mid-tool-call" safe without any locking.
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

/**
 * Keeping an open dataset current, and how to stop.
 *
 * A seam rather than a direct call to `startRefresh`, for the property the
 * `#dataset` doc claims: constructing a Runtime must not reach the network
 * unless the caller asked it to. `src/index.ts` passes the real one; every
 * test that never mentions the dataset gets `NO_REFRESH` and no download.
 */
export type Refresher = (dataset: ImdbDataset) => () => void;

/** The default. Nothing to keep fresh, and nothing to stop. */
const NO_REFRESH: Refresher = () => () => {};

export class Runtime {
    #snapshot: RuntimeSnapshot;
    readonly #configDir: string;
    readonly #audit: WriteAudit;
    readonly #refresh: Refresher;

    /**
     * Deliberately outside the snapshot, and so **not** rebuilt on reload.
     *
     * Confirmation tokens span two calls by construction, and sessions span
     * many. Rebuilding either on every config change would mean a config edit
     * silently invalidated an in-flight write confirmation, or logged the
     * person making the edit out of the page they were editing from. Neither
     * is a safety property: the permission check runs again at confirm time
     * against the *new* config, so a revoked permission is still enforced.
     *
     * `sessions` is injectable so the repair server and the real one can share
     * one signing key — otherwise a save promotes the operator into a login
     * screen, having just typed their password.
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
     * Opening it and keeping it *fresh* are the same decision, so both live
     * here. Through 1.1 they did not: `startRefresh` was called once at
     * startup from the entry point, so switching the dataset on from the
     * config UI opened an empty database that nothing ever ingested into, and
     * every rating stayed missing until the container was restarted — a
     * feature that looks broken rather than one that looks off. What the
     * entry point supplies now is the *refresher*, not the timing.
     */
    #dataset: ImdbDataset | undefined;

    /** Stops the refresh belonging to `#dataset`, and only while one is open. */
    #stopRefresh: (() => void) | undefined;

    get dataset(): ImdbDataset | undefined {
        return this.#dataset;
    }

    private constructor(
        configDir: string,
        audit: WriteAudit,
        config: Config,
        refresh: Refresher,
        sessions: Sessions
    ) {
        this.#configDir = configDir;
        this.#audit = audit;
        this.#refresh = refresh;
        this.confirm = new ConfirmTokens();
        this.sessions = sessions;
        // Before the snapshot, not after: the tool context closes over the
        // dataset, so it has to exist by the time it is built.
        this.#syncDataset(config);
        this.#snapshot = buildSnapshot(config, audit, this.confirm, this.#dataset);
    }

    /**
     * Open or close the dataset to match the config — and start or stop its
     * refresh with it — doing nothing at all when the answer has not changed,
     * which is the common case on reload.
     *
     * The "unchanged" branch is what stops every unrelated save from stacking
     * up refreshers: editing a timeout reloads the runtime, and a second timer
     * per edit would mean a day of configuring left a pile of them all
     * downloading 223 MB on the same schedule.
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
            // After the open, and pointed at the database that was just
            // opened: a refresh filling a dataset nothing reads would be the
            // same bug this call exists to fix, wearing a different hat.
            this.#stopRefresh = this.#refresh(this.#dataset);
            return;
        }

        if (!wanted && this.#dataset !== undefined) {
            // Stopped *before* the close, so no further ingest is scheduled
            // against a database about to go away. An ingest already in flight
            // is not cancellable — it will fail on the closed handle and be
            // logged by the refresher's own catch, which is the right outcome:
            // a warning about a download nobody wants any more.
            this.#stopRefresh?.();
            this.#stopRefresh = undefined;
            this.#dataset.close();
            this.#dataset = undefined;
            logger.info('IMDb dataset closed — no longer enabled');
        }
    }

    static async start(
        configDir: string,
        audit: WriteAudit,
        opts: { refresh?: Refresher; sessions?: Sessions } = {}
    ): Promise<{ runtime: Runtime; created: boolean }> {
        const { config, created } = await loadConfig(configDir);
        return {
            runtime: new Runtime(configDir, audit, config, opts.refresh ?? NO_REFRESH, opts.sessions ?? new Sessions()),
            created
        };
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
        opts: {
            configDir?: string;
            adapters?: readonly ServiceAdapter[];
            refresh?: Refresher;
            sessions?: Sessions;
        } = {}
    ): Runtime {
        const runtime = new Runtime(
            opts.configDir ?? NO_CONFIG_DIR,
            audit,
            config,
            opts.refresh ?? NO_REFRESH,
            opts.sessions ?? new Sessions()
        );
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
