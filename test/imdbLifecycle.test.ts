import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { Runtime } from '../src/core/runtime.ts';
import type { ImdbDataset } from '../src/metadata/imdbDataset.ts';

/**
 * Who keeps the dataset *fresh*, and when.
 *
 * Opening `imdb.db` and ingesting into it are two different things, and through
 * 1.1 only the first followed the config. `startRefresh` was called once, at
 * startup, from `src/index.ts` — so ticking the box in the config UI opened an
 * empty database that nothing ever filled, and every rating stayed missing
 * until someone restarted the container. That failure is indistinguishable from
 * the feature not working: `get_library` reports "0 rated" either way.
 *
 * The refresher is injected rather than imported, so these run without a
 * network and without waiting a day for an interval — and so `Runtime` keeps
 * the property its own doc comment claims, that constructing one never reaches
 * the network unless the caller asked for it.
 */

const BEARER = 'a'.repeat(64);

let dir: string;
let audit: WriteAudit;
/** Held so cleanup can close the dataset's handle on `imdb.db`. */
let runtime: Runtime | undefined;

/** Every dataset the refresher was handed, and whether it has been stopped. */
type Started = { dataset: ImdbDataset; stopped: boolean };

const spy = (): { started: Started[]; refresh: (d: ImdbDataset) => () => void } => {
    const started: Started[] = [];
    return {
        started,
        refresh: (dataset: ImdbDataset) => {
            const record: Started = { dataset, stopped: false };
            started.push(record);
            return () => {
                record.stopped = true;
            };
        }
    };
};

const write = async (imdb: boolean): Promise<void> => {
    await writeFile(
        join(dir, 'config.yaml'),
        `auth:\n  bearer_token: ${BEARER}\n  username: admin\n  allowed_hosts: []\nservices: {}\n` +
            (imdb ? 'metadata:\n  imdb:\n    enabled: true\n' : ''),
        'utf8'
    );
};

const runtimeFrom = async (opts: { refresh: (d: ImdbDataset) => () => void }): Promise<Runtime> => {
    const { config } = await loadConfig(dir);
    runtime = Runtime.fromConfig(config, audit, { configDir: dir, refresh: opts.refresh });
    return runtime;
};

/**
 * **Not** the `arr-mcp-imdb-` prefix, deliberately. That one belongs to
 * `ingestOnce`'s staging directories, and `sweepStaging` deletes anything
 * wearing it that has gone a day untouched — so a config directory borrowing
 * the name would be a test fixture that a production code path is entitled to
 * delete. The first draft of this file did borrow it, and left 35 of them
 * behind besides.
 */
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arr-mcp-lifecycle-'));
    audit = WriteAudit.ephemeral();
});

afterEach(async () => {
    audit.close();

    // The open dataset holds a handle on imdb.db, and Windows refuses to
    // unlink an open file however `force` is set — `rm` fails with EBUSY, and
    // the directory leaks exactly as it did before this cleanup existed.
    try {
        runtime?.dataset?.close();
    } catch {
        // Already closed by a test that switched the dataset off.
    }
    runtime = undefined;

    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the IMDb refresh follows the config', () => {
    /** The reported bug, as a test. */
    it('starts refreshing when the dataset is switched on by a reload', async () => {
        await write(false);
        const { started, refresh } = spy();
        const runtime = await runtimeFrom({ refresh });

        expect(started).toHaveLength(0);
        expect(runtime.dataset).toBeUndefined();

        await write(true);
        await runtime.reload();

        expect(runtime.dataset).toBeDefined();
        expect(started).toHaveLength(1);
        // The refresh must be pointed at the database that was just opened,
        // not at some other one — filling a dataset nothing reads is the same
        // bug wearing a different hat.
        expect(started[0]?.dataset).toBe(runtime.dataset);
    });

    it('stops refreshing when the dataset is switched off', async () => {
        await write(true);
        const { started, refresh } = spy();
        const runtime = await runtimeFrom({ refresh });
        expect(started).toHaveLength(1);

        await write(false);
        await runtime.reload();

        expect(runtime.dataset).toBeUndefined();
        expect(started[0]?.stopped).toBe(true);
    });

    /**
     * The common case on reload, and the one that would leak. Every unrelated
     * config save — a timeout, a permission — reloads the runtime; if each
     * started another refresh, a day of editing would leave a stack of timers
     * all downloading 223 MB on the same schedule.
     */
    it('does not start a second refresh when the answer has not changed', async () => {
        await write(true);
        const { started, refresh } = spy();
        const runtime = await runtimeFrom({ refresh });

        await runtime.reload();
        await runtime.reload();

        expect(started).toHaveLength(1);
        expect(started[0]?.stopped).toBe(false);
    });

    it('starts one refresh when the dataset is already on at startup', async () => {
        await write(true);
        const { started, refresh } = spy();
        const runtime = await runtimeFrom({ refresh });

        expect(runtime.dataset).toBeDefined();
        expect(started).toHaveLength(1);
    });

    it('never refreshes when the dataset is off', async () => {
        await write(false);
        const { started, refresh } = spy();
        const runtime = await runtimeFrom({ refresh });

        expect(runtime.dataset).toBeUndefined();
        expect(started).toHaveLength(0);
    });

    /**
     * Off, then on again. The stopped refresher must not be reused — a cleared
     * interval does not restart, so carrying the old stop function forward
     * would leave the second dataset with nothing refreshing it.
     */
    it('starts a fresh refresh when the dataset is switched off and on again', async () => {
        await write(true);
        const { started, refresh } = spy();
        const runtime = await runtimeFrom({ refresh });

        await write(false);
        await runtime.reload();
        await write(true);
        await runtime.reload();

        expect(started).toHaveLength(2);
        expect(started[0]?.stopped).toBe(true);
        expect(started[1]?.stopped).toBe(false);
        expect(started[1]?.dataset).toBe(runtime.dataset);
    });

    /** The default. Nothing that does not ask for a refresher gets a download. */
    it('does not refresh at all when no refresher was supplied', async () => {
        await write(true);
        const { config } = await loadConfig(dir);
        runtime = Runtime.fromConfig(config, audit, { configDir: dir });

        expect(runtime.dataset).toBeDefined();
        await expect(runtime.reload()).resolves.toBeUndefined();
    });
});
