import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { logger } from '../core/logger.ts';
import type { ImdbDataset } from './imdbDataset.ts';
import { parseEpisodes, parseRatings, parseTitles } from './ingest.ts';

/**
 * Fetching the dumps, and the daily schedule (0.8 spec ).
 *
 * The only file in `src/metadata/` that touches the network, which is what
 * lets the store and the parser be tested without one.
 */

export const IMDB_BASE_URL = 'https://datasets.imdbws.com';

/** IMDb publishes daily. Spec explains why this is not configurable: there
 *  is no second sensible value, and a knob with one answer invites a wrong one. */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Download one dump and yield its lines, decompressed. */
async function* download(baseUrl: string, file: string): AsyncGenerator<string> {
    const res = await fetch(`${baseUrl}/${file}`);
    if (!res.ok || res.body === null) {
        // Names the file: "HTTP 404" alone would not say which of the three,
        // and they fail independently.
        throw new Error(`could not fetch ${file}: HTTP ${res.status}`);
    }

    // Streamed rather than buffered — title.basics is on the order of 10⁷ rows
    // and this runs on a NAS.
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    const lines = createInterface({ input: body.pipe(createGunzip()), crlfDelay: Infinity });

    for await (const line of lines) yield line;
}

/**
 * Fetch all three dumps, **then** replace.
 *
 * Buffering the parsed rows costs memory and is still the right trade: the
 * failure it prevents is a download dying between file one and file three,
 * leaving today's titles standing against yesterday's ratings. `replaceAll`
 * is one transaction, so nothing is visible until all three arrived intact.
 */
export async function ingestOnce(dataset: ImdbDataset, opts: { baseUrl?: string } = {}): Promise<void> {
    const baseUrl = opts.baseUrl ?? IMDB_BASE_URL;
    const started = Date.now();

    const collect = async <T>(file: string, parse: (lines: Iterable<string>) => Generator<T>): Promise<T[]> => {
        const raw: string[] = [];
        for await (const line of download(baseUrl, file)) raw.push(line);
        return [...parse(raw)];
    };

    const titles = await collect('title.basics.tsv.gz', parseTitles);
    const ratings = await collect('title.ratings.tsv.gz', parseRatings);
    const episodes = await collect('title.episode.tsv.gz', parseEpisodes);

    dataset.replaceAll({ titles, ratings, episodes });

    logger.info(
        { titles: titles.length, ratings: ratings.length, episodes: episodes.length, ms: Date.now() - started },
        'IMDb dataset ingested'
    );
}

/**
 * Start the daily refresh, and return a function that stops it.
 *
 * **Startup never awaits this.** A first run that takes twenty minutes is
 * twenty minutes of normal service, not twenty minutes of a container that
 * looks broken — every tool answers exactly as it did before until the first
 * ingest lands.
 */
export function startRefresh(dataset: ImdbDataset, opts: { baseUrl?: string } = {}): () => void {
    const run = (): void => {
        ingestOnce(dataset, opts).catch((err: unknown) => {
            // A failed refresh keeps the previous dataset, so this is a
            // degraded answer rather than an outage. It warns instead of
            // becoming an unhandled rejection that would take the process
            // down over a transient 503.
            logger.warn({ err }, 'IMDb dataset refresh failed; keeping the previous one');
        });
    };

    run();

    const timer = setInterval(run, REFRESH_INTERVAL_MS);
    // Unreffed so a pending refresh never holds the process open at shutdown.
    timer.unref();

    return () => clearInterval(timer);
}
