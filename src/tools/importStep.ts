import type { NextStep } from '../core/nextStep.ts';
import type { QueueItem } from '../services/types.ts';
import { instanceArgs } from './resolveInstance.ts';

/** Radarr, Sonarr and Lidarr import a download by id. Whisparr has no manual import, so a call to it would be refused and is never offered. */
const IMPORTERS: readonly string[] = ['radarr', 'sonarr', 'lidarr'];

/**
 * The *arr that should import this row: its own service when it is one, since a
 * title match can pick up another instance's grab. Only a download client's row
 * (no media id) falls back to `fallback`, the item's managing service: an *arr
 * row that cannot import is another service's grab, not this item's.
 */
function importerFor(row: QueueItem, fallback: string | undefined): string | undefined {
    return [row.service, row.mediaId === undefined ? fallback : undefined].find(
        (s): s is string => s !== undefined && IMPORTERS.includes(instanceArgs(s).service)
    );
}

/**
 * The import to offer for a finished download, shared by `diagnose_media` and
 * `get_queue`. The caller decides the row is finished and unimported; this
 * needs its download id and an *arr that can import it.
 */
export function importStepFor(row: QueueItem, fallback?: string): NextStep | undefined {
    const importer = importerFor(row, fallback);
    if (row.downloadId === undefined || importer === undefined) return undefined;
    return {
        tool: 'import_download',
        arguments: { ...instanceArgs(importer), action: 'import', download_id: row.downloadId },
        why: `Asks ${importer} to import the finished download.`
    };
}

/**
 * Finished, and the *arr will not or cannot import it: `importBlocked`, or
 * `importPending` with reasons. A live Sonarr 4.0.20 reports a download it
 * finds nothing importable in the second way, retrying every cycle with the
 * same result, so `importPending` alone does not mean it is coping.
 */
export const importFailing = (row: QueueItem): boolean =>
    row.importState === 'importBlocked' || (row.importState === 'importPending' && (row.statusMessages?.length ?? 0) > 0);

/** The import for a row the *arr keeps failing on by itself: the preview shows what it finds and why each file is refused. */
export function retriedImportStepFor(row: QueueItem, fallback?: string): NextStep | undefined {
    const step = importStepFor(row, fallback);
    const importer = importerFor(row, fallback);
    return step === undefined || importer === undefined
        ? undefined
        : { ...step, why: `${importer} keeps failing to import it by itself; the preview shows what it finds and why each file is refused.` };
}

/** The importers whose import_download takes a `mapping`. Lidarr's does not. */
const MAPPERS: readonly string[] = ['radarr', 'sonarr'];

/** An orphaned row whose importer takes a `mapping`: the only way it learns where the files go. */
export const needsMapping = (row: QueueItem): boolean => row.orphaned === true && MAPPERS.includes(instanceArgs(row.service).service);

/**
 * The import to offer for an orphaned row: one the *arr matched to nothing in
 * its library. That is a deleted film or series, or a release it never
 * matched at all, and only a `mapping` naming what each file is can tell its
 * importer where the second kind goes. None where the importer takes no mapping.
 */
export function orphanImportStepFor(row: QueueItem): NextStep | undefined {
    if (!needsMapping(row)) return undefined;
    const step = importStepFor(row);
    return step === undefined
        ? undefined
        : { ...step, why: `${row.service} matched this download to nothing in its library: deleted, or never matched. To import it, add \`mapping\` with what each file is.` };
}
