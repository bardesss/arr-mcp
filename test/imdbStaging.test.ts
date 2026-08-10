import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { STAGING_PREFIX, sweepStaging } from '../src/metadata/refresh.ts';

/**
 * Cleaning up after an ingest that never got to clean up after itself.
 *
 * `ingestOnce` removes its staging directory in a `finally`, which covers a
 * failed download and a failed parse. It does not cover the process being
 * killed — and that is the failure this project has actually had: the first
 * real ingest was OOM-killed (f3e4a95), and two days later 661 MB of
 * `title.basics.tsv` was still sitting in the OS temp directory. A weekly
 * refresh leaks slowly enough that nobody notices until the disk is full.
 *
 * Age-gated rather than "delete every staging dir I find", because a second
 * process — another container sharing /tmp, or `scripts/measure-imdb.ts` —
 * may be part-way through an ingest of its own, and its staging directory
 * looks exactly like abandoned one. An ingest takes minutes; the gate is a
 * day.
 */

/** Its own root, never the real temp directory: a test that swept `tmpdir()`
 *  itself would delete a concurrently-running ingest's staging on a dev box. */
let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'arr-mcp-sweep-test-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** A directory with a staged dump in it, aged by touching its mtime. */
const staged = (name: string, ageMs: number): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'title.basics.tsv'), 'tconst\ttitleType\n', 'utf8');

    const seconds = (NOW - ageMs) / 1000;
    utimesSync(dir, seconds, seconds);
    return dir;
};

describe('sweeping abandoned staging directories', () => {
    it('removes a staging directory left by a killed ingest', () => {
        const abandoned = staged(`${STAGING_PREFIX}dead01`, 48 * HOUR);

        expect(sweepStaging(root, { now: NOW })).toBe(1);
        expect(existsSync(abandoned)).toBe(false);
    });

    /**
     * The whole reason for the age gate. A staging directory being *young* is
     * the only evidence available that another process is still using it, and
     * deleting a running ingest's dumps mid-stream would turn a slow disk leak
     * into a broken refresh.
     */
    it('leaves a recent one alone, which may be an ingest in progress', () => {
        const running = staged(`${STAGING_PREFIX}live01`, 2 * HOUR);

        expect(sweepStaging(root, { now: NOW })).toBe(0);
        expect(existsSync(running)).toBe(true);
    });

    it('does not touch directories belonging to anything else', () => {
        const other = staged('some-other-tool-cache', 48 * HOUR);
        const alsoOther = staged('arr-mcp-ui-abc123', 48 * HOUR);

        expect(sweepStaging(root, { now: NOW })).toBe(0);
        expect(existsSync(other)).toBe(true);
        expect(existsSync(alsoOther)).toBe(true);
    });

    it('removes several at once and reports how many', () => {
        staged(`${STAGING_PREFIX}a`, 30 * HOUR);
        staged(`${STAGING_PREFIX}b`, 40 * HOUR);
        const young = staged(`${STAGING_PREFIX}c`, 1 * HOUR);

        expect(sweepStaging(root, { now: NOW })).toBe(2);
        expect(existsSync(young)).toBe(true);
    });

    /**
     * A sweep is housekeeping. It runs immediately before a download that is
     * the actual point of the exercise, so anything it cannot do — a
     * permission error, a directory that vanished under it, no temp directory
     * at all — must not take the refresh down with it.
     */
    it('reports nothing rather than throwing when the root does not exist', () => {
        expect(sweepStaging(join(root, 'nope'), { now: NOW })).toBe(0);
    });

    it('ignores a plain file that happens to match the prefix', () => {
        const file = join(root, `${STAGING_PREFIX}notadir`);
        writeFileSync(file, 'x', 'utf8');
        const seconds = (NOW - 48 * HOUR) / 1000;
        utimesSync(file, seconds, seconds);

        expect(sweepStaging(root, { now: NOW })).toBe(0);
        expect(existsSync(file)).toBe(true);
    });
});
