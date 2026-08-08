/**
 * One real IMDb ingest, measured.
 *
 * The numbers in the README come from here. Run it again when they need
 * refreshing — IMDb's dumps grow, and a disk figure quoted in a README is only
 * as good as the day it was taken.
 *
 *   node --experimental-strip-types scripts/measure-imdb.ts
 *
 * It downloads a few hundred megabytes and writes to a temp directory, which it
 * removes afterwards. Nothing in the repo or the config volume is touched.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMDB_BASE_URL, ingestOnce } from '../src/metadata/refresh.ts';
import { IMDB_FILENAME, ImdbDataset } from '../src/metadata/imdbDataset.ts';

const FILES = ['title.basics.tsv.gz', 'title.ratings.tsv.gz'];

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

/** Every file in the directory: WAL and shm count until a checkpoint. */
const onDisk = (dir: string): number =>
    readdirSync(dir).reduce((total, f) => total + statSync(join(dir, f)).size, 0);

async function compressedSize(file: string): Promise<number> {
    const res = await fetch(`${IMDB_BASE_URL}/${file}`, { method: 'HEAD' });
    return Number(res.headers.get('content-length') ?? 0);
}

const dir = mkdtempSync(join(tmpdir(), 'imdb-measure-'));

try {
    let download = 0;
    for (const file of FILES) {
        const size = await compressedSize(file);
        download += size;
        console.log(`${file.padEnd(24)} ${mb(size).padStart(9)} compressed`);
    }
    console.log(`${'download per refresh'.padEnd(24)} ${mb(download).padStart(9)}\n`);

    const started = Date.now();
    const dataset = ImdbDataset.open(dir);
    console.log('ingesting…');
    await ingestOnce(dataset);
    const seconds = Math.round((Date.now() - started) / 1000);

    const status = dataset.status();
    dataset.close();

    // Checkpointed and vacuumed, so this is what the file settles at rather
    // than what it peaked at mid-write.
    const db = new Database(join(dir, IMDB_FILENAME));
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.close();

    console.log('\n--- measured ---');
    console.log('titles              ', status.titles.toLocaleString('en'));
    console.log('rated               ', status.ratings.toLocaleString('en'));
    console.log('ingest wall clock   ', `${seconds}s`);
    console.log('on disk             ', mb(onDisk(dir)));
} finally {
    // Best effort: Windows can still hold the SQLite file briefly after close,
    // and failing to tidy a temp directory must not lose the measurement that
    // was the whole point of the run.
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        console.log('(could not remove', dir, '— delete it by hand)');
    }
}
