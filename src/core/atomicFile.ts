import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { serial } from './serial.ts';

/**
 * A unique temp name per write: a fixed `<file>.tmp` meant two overlapping
 * writes shared one file and both renamed it into place, so one could rename a
 * half-written copy of the other. 0o600 on the temp file too: it holds the same
 * secrets for the moment it exists.
 */
const tempFor = (path: string): string => `${path}.${process.pid}.${randomUUID()}.tmp`;

/**
 * Overlapping renames onto one path fail outright on Windows with EPERM, and
 * everywhere else the last write wins.
 */
const queue = serial();

/** Replaces `path` atomically, 0o600. */
export const writeFileAtomic = (path: string, text: string): Promise<void> =>
    queue(async () => {
        const tmp = tempFor(path);
        try {
            await writeFile(tmp, text, { mode: 0o600 });
            await rename(tmp, path);
        } catch (error) {
            // The temp file holds every key; a failed write must not leave it behind.
            try {
                await rm(tmp, { force: true });
            } catch {
                // the original error is the one worth seeing
            }
            throw error;
        }
    });

export function writeFileAtomicSync(path: string, text: string): void {
    const tmp = tempFor(path);
    try {
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, path);
    } catch (error) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            // the original error is the one worth seeing
        }
        throw error;
    }
}
