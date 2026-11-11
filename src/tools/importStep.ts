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
