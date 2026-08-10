import { closeSync, createWriteStream, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
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
    const staging = mkdtempSync(join(tmpdir(), 'arr-mcp-imdb-'));

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
