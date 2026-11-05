/**
 * Shelfmark scrubbing for `capture-fixtures.ts`, split out so it can be unit
 * tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 *
 * `/api/config` is the web UI's settings blob, with the operator's Calibre and
 * Audiobookshelf addresses in it, and the adapter reads only the version from
 * it, so everything else is dropped. `/api/status` carries who asked for each
 * book and where it landed: those are blanked and the titles stay, as they do
 * for films and series.
 */
import { isRow, type Row } from './redact.ts';

const CONFIG_KEPT = ['build_version', 'release_version'];

export function anonymiseShelfmarkConfig(body: unknown): unknown {
    if (!isRow(body)) return body;
    return Object.fromEntries(Object.entries(body).filter(([key]) => CONFIG_KEPT.includes(key)));
}

/** A book's blurb is someone's copyright, and its URLs name the operator's own proxy: blanked. */
export function anonymiseShelfmarkSearch(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.books)) return body;
    return {
        ...body,
        books: (body.books as unknown[]).slice(0, 3).map(book => (isRow(book) ? { ...book, description: '', cover_url: '', source_url: '', display_fields: [] } : book))
    };
}

/** Rows kept per source, enough for the shape and short of a catalogue. */
const RELEASES_PER_SOURCE = 3;

/**
 * A row's URLs can hold an indexer's API key, and `extra` repeats them with
 * covers and file names, so they go. An indexer's name is identity on Prowlarr's
 * rows; `direct_download` names Shelfmark's own source, which stays.
 */
export function anonymiseShelfmarkReleases(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.releases)) return body;
    const seen = new Map<unknown, number>();
    const releases = (body.releases as unknown[]).filter(isRow).flatMap(row => {
        const n = (seen.get(row.source) ?? 0) + 1;
        seen.set(row.source, n);
        if (n > RELEASES_PER_SOURCE) return [];
        return [
            {
                ...row,
                download_url: '',
                info_url: '',
                // The download count alone: it is what the adapter ranks releases by.
                extra: isRow(row.extra) && typeof row.extra.downloads === 'number' ? { downloads: row.extra.downloads } : {},
                ...(row.source === 'direct_download' ? {} : { indexer: `Example Indexer ${n}`, source_id: `example-${n}` })
            }
        ];
    });
    return { releases, sources_searched: body.sources_searched };
}

/** A message that names a path or an address is replaced whole, so no part of either survives. */
const NAMES_A_PLACE = /[/\\]|:\d/;

/** A task id is the release's `source_id`, which on a Prowlarr row is the indexer's URL. */
const safeTaskId = (id: string, n: number): string => (id.includes('://') ? `example-task-${n}` : id);

function anonymiseTask(task: Row, n: number): Row {
    const out: Row = { ...task };
    if (typeof task.id === 'string') out.id = safeTaskId(task.id, n);
    for (const key of ['username', 'download_path', 'preview']) {
        if (typeof task[key] === 'string' && task[key] !== '') out[key] = key === 'username' ? 'example-user' : '';
    }
    if (typeof task.user_id === 'number') out.user_id = 1;
    if (typeof task.status_message === 'string' && NAMES_A_PLACE.test(task.status_message)) out.status_message = 'Example message';
    return out;
}

/** Rows kept per bucket of finished downloads: the shape, short of someone's whole reading list. */
const ACTIVITY_PER_BUCKET = 3;

/** The live queue's buckets as `/api/status` has them, plus finished ones. Requests name people, so they go. */
export function anonymiseShelfmarkSnapshot(body: unknown): unknown {
    if (!isRow(body) || !isRow(body.status)) return body;
    const status = Object.fromEntries(
        Object.entries(body.status).map(([bucket, tasks]) => [bucket, isRow(tasks) ? Object.fromEntries(Object.entries(tasks).slice(0, ACTIVITY_PER_BUCKET)) : tasks])
    );
    return { status: anonymiseShelfmarkStatus(status), requests: [], dismissed: [] };
}

/** A row names its task three times over: `source_id`, and inside `id` and `item_key`. */
export function anonymiseShelfmarkHistory(body: unknown): unknown {
    if (!Array.isArray(body)) return body;
    const seen = new Map<unknown, number>();
    return (body as unknown[]).filter(isRow).flatMap(row => {
        const n = (seen.get(row.final_status) ?? 0) + 1;
        seen.set(row.final_status, n);
        if (n > ACTIVITY_PER_BUCKET) return [];
        const taskId = safeTaskId(typeof row.source_id === 'string' ? row.source_id : '', n);
        const snapshot = isRow(row.snapshot) && isRow(row.snapshot.download) ? { ...row.snapshot, download: anonymiseTask(row.snapshot.download, n) } : row.snapshot;
        return [{ ...row, id: `download:${taskId}`, item_key: `download:${taskId}`, source_id: taskId, snapshot }];
    });
}

/** `{ <status>: { <task id>: task } }`, one bucket per queue status. */
export function anonymiseShelfmarkStatus(body: unknown): unknown {
    if (!isRow(body)) return body;
    return Object.fromEntries(
        Object.entries(body).map(([status, tasks]) => [
            status,
            isRow(tasks) ? Object.fromEntries(Object.entries(tasks).map(([id, task], n) => [safeTaskId(id, n + 1), isRow(task) ? anonymiseTask(task, n + 1) : task])) : tasks
        ])
    );
}
