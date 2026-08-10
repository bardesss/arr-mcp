import { closeSync, createWriteStream, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { logger } from '../core/logger.ts';
import type { ImdbDataset } from './imdbDataset.ts';
import { parseRatings, parseTitles } from './ingest.ts';

/**
 * Fetching the dumps, and the weekly schedule.
 *
 * The only file in `src/metadata/` that touches the network, which is what lets
 * the store and the parser be tested without one.
 */

export const IMDB_BASE_URL = 'https://datasets.imdbws.com';

/**
 * Weekly, though IMDb publishes daily — the publish cadence is not the useful
 * one here.
 *
 * What this database holds is average ratings for titles that already exist. An
 * average over two million votes moves by hundredths across a *year*; refetching
 * 223 MB every night to change a third decimal place spent 6.5 GB a month of a
 * NAS's bandwidth to answer every question exactly as it did the night before.
 * Weekly is under a gigabyte a month for the same answers.
 *
 * **What this costs, stated plainly:** a title IMDb published in the last week
 * may have no row yet, so a brand-new release can be missing from `discover`,
 * and a series added to your library the day it premiered goes without an IMDb
 * rating until the next refresh. Ratings for anything older — which is nearly
 * everything anybody owns — are unaffected.
 *
 * Still not configurable, for the reason it never was: there is no interval a
 * user could pick that would serve them better than this one, and a setting
 * that cannot help can still be set wrong.
 */
export const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What every staging directory is named, and nothing else is.
 *
 * Exported so the sweep and the thing it sweeps cannot drift apart: two
 * spellings of this would mean either cleaning up nothing or cleaning up
 * somebody else's directory, and both fail silently.
 */
export const STAGING_PREFIX = 'arr-mcp-imdb-';

/**
 * How long a staging directory must have gone untouched before it counts as
 * abandoned rather than in use.
 *
 * An ingest takes minutes, so a day is a hundredfold margin. The gate exists
 * because a *young* staging directory is the only evidence available that
 * another process — a second container sharing /tmp, or `measure-imdb.ts` —
 * is still writing to it, and deleting a running ingest's dumps out from
 * under it would turn a slow disk leak into a broken refresh.
 */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Remove staging directories that an earlier run never got to remove itself.
 *
 * `ingestOnce` cleans up in a `finally`, which covers a failed download and a
 * failed parse but **not** the process being killed — and that is the failure
 * this project has actually had. The first real ingest was OOM-killed, and
 * days later 661 MB of `title.basics.tsv` was still sitting in the OS temp
 * directory. At a weekly refresh that leaks slowly enough that nobody notices
 * until a disk is full.
 *
 * Returns how many it removed, and **never throws**: this is housekeeping in
 * front of the download that is the actual point, so a permission error or a
 * directory that vanished mid-scan must not take the refresh down with it.
 */
export function sweepStaging(root: string, opts: { now?: number } = {}): number {
    const now = opts.now ?? Date.now();
    let removed = 0;

    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch {
        // No temp directory, or not readable. Nothing to clean, and nothing
        // worth failing a refresh over.
        return 0;
    }

    for (const name of entries) {
        if (!name.startsWith(STAGING_PREFIX)) continue;

        const path = join(root, name);
        try {
            const stat = statSync(path);
            // A plain file that happens to match is not ours: staging is
            // always a directory, and deleting an unrelated file on a name
            // collision would be a real bug rather than a tidy-up.
            if (!stat.isDirectory()) continue;
            if (now - stat.mtimeMs < ABANDONED_AFTER_MS) continue;

            rmSync(path, { recursive: true, force: true });
            removed += 1;
        } catch (err) {
            logger.warn({ path, err }, 'could not remove an abandoned IMDb staging directory');
        }
    }

    return removed;
}

/**
 * Download one dump, decompressed, **to a file** — never into memory.
 *
 * `title.basics` is ~12M lines. Holding them cost about 4 GB of heap and killed
 * the process outright the first time this ran against the real dumps: the
 * generators in `ingest.ts` are lazy precisely so peak memory is one row, and
 * buffering the lines first threw that away.
 *
 * Staging to disk is also what makes the synchronous transaction below
 * possible. better-sqlite3 transactions cannot `await`, so the network has to
 * be finished with before the write begins.
 */
async function downloadTo(baseUrl: string, file: string, path: string): Promise<void> {
    const res = await fetch(`${baseUrl}/${file}`);
    if (!res.ok || res.body === null) {
        // Names the file: "HTTP 404" alone would not say which of them, and they
        // fail independently.
        throw new Error(`could not fetch ${file}: HTTP ${res.status}`);
    }

    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(body, createGunzip(), createWriteStream(path));
}

/**
 * A file's lines, synchronously and a megabyte at a time.
 *
 * Synchronous because it is consumed inside better-sqlite3's transaction, which
 * cannot await. Chunked because the whole point is not to materialise a
 * gigabyte of TSV to read it.
 */
export function* linesOf(path: string): Generator<string> {
    const fd = openSync(path, 'r');
    const buffer = Buffer.alloc(1 << 20);
    let carry = '';

    try {
        for (;;) {
            const read = readSync(fd, buffer, 0, buffer.length, null);
            if (read === 0) break;

            const chunk = carry + buffer.toString('utf8', 0, read);
            const lines = chunk.split('\n');
            // The final piece may be half a line, and belongs to the next chunk.
            carry = lines.pop() ?? '';

            for (const line of lines) yield line;
        }

        if (carry !== '') yield carry;
    } finally {
        closeSync(fd);
    }
}

/**
 * Fetch both dumps, **then** replace.
 *
 * Both land before anything is written, so a download dying between them cannot
 * leave today's titles standing against yesterday's ratings. `replaceAll` is one
 * transaction, so nothing is visible until both arrived.
 *
 * `title.episode` is deliberately not fetched. It was ingested through 1.0 and
 * never read by a single query — 52 MB a day and millions of rows for a table
 * nothing consulted.
 */
export async function ingestOnce(dataset: ImdbDataset, opts: { baseUrl?: string } = {}): Promise<void> {
    const baseUrl = opts.baseUrl ?? IMDB_BASE_URL;
    const started = Date.now();

    // Before staging our own, not after: this is the moment we are about to
    // ask for another ~700 MB of temp space, so it is the moment worth
    // reclaiming what a killed predecessor left behind.
    const swept = sweepStaging(tmpdir());
    if (swept > 0) logger.info({ swept }, 'removed abandoned IMDb staging directories');

    const staging = mkdtempSync(join(tmpdir(), STAGING_PREFIX));

    try {
        const titlesFile = join(staging, 'title.basics.tsv');
        const ratingsFile = join(staging, 'title.ratings.tsv');

        await downloadTo(baseUrl, 'title.basics.tsv.gz', titlesFile);
        await downloadTo(baseUrl, 'title.ratings.tsv.gz', ratingsFile);

        // Read lazily from disk straight into the transaction, so the rows are
        // never all in memory at once.
        dataset.replaceAll({
            titles: parseTitles(linesOf(titlesFile)),
            ratings: parseRatings(linesOf(ratingsFile))
        });

        const status = dataset.status();
        logger.info(
            { titles: status.titles, ratings: status.ratings, ms: Date.now() - started },
            'IMDb dataset ingested'
        );
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

/**
 * Start the weekly refresh, returning a function that stops it.
 *
 * Runs once immediately, then on the interval — which is what makes switching
 * the dataset on from the config UI produce ratings rather than an empty
 * database that waits a week. `Runtime` calls this the moment it opens the
 * database, and calls the returned stop function when it closes it.
 *
 * **Startup never awaits this.** A first run of several minutes is several
 * minutes of normal service, not a container that looks broken — every tool
 * answers exactly as before until the first ingest lands.
 */
export function startRefresh(dataset: ImdbDataset, opts: { baseUrl?: string } = {}): () => void {
    const run = (): void => {
        ingestOnce(dataset, opts).catch((err: unknown) => {
            // A failed refresh keeps the previous dataset, so this is a degraded
            // answer rather than an outage — it warns instead of becoming an
            // unhandled rejection that would take the process down over a 503.
            logger.warn({ err }, 'IMDb dataset refresh failed; keeping the previous one');
        });
    };

    run();

    const timer = setInterval(run, REFRESH_INTERVAL_MS);
    // Unreffed so a pending refresh never holds the process open at shutdown.
    timer.unref();

    return () => clearInterval(timer);
}
