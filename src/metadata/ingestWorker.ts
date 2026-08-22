/**
 * The IMDb ingest, in its own thread.
 *
 * `replaceAll` is a synchronous better-sqlite3 transaction over millions of
 * rows followed by a VACUUM. On the main thread that froze every tool call,
 * connection test and web request for minutes, once a week — while `refresh.ts`
 * promised "several minutes of normal service, not a container that looks
 * broken". That was true of the download half only.
 *
 * This opens its **own** connection to the same file, because a better-sqlite3
 * handle cannot cross a thread boundary. The database is in WAL mode, so the
 * main thread keeps answering from the pre-transaction snapshot until this
 * commits.
 */
import { workerData } from 'node:worker_threads';
import { ImdbDataset } from './imdbDataset.ts';
import { ingestOnce } from './refresh.ts';

const { dir, baseUrl } = workerData as { dir: string; baseUrl?: string };

const dataset = ImdbDataset.open(dir);
try {
    await ingestOnce(dataset, baseUrl === undefined ? {} : { baseUrl });
} finally {
    dataset.close();
}
