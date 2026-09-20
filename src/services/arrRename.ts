import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { logger } from '../core/logger.ts';
import { awaitArrCommand, postArrCommand, renamedCount } from './arrCommands.ts';

/**
 * Renaming a set of files whose names are each other's.
 *
 * After a remap rotates a season, every file's wanted name is the name another
 * file in the same set is still using, so no rename in it has a free
 * destination: Sonarr answers `completed` having renamed nothing. There is no
 * "rename this file to that name" endpoint — `RenameFiles` renames to whatever
 * the *naming format* produces — so the only way through is to change the
 * format, rename once into names nothing holds, change it back, and rename
 * again into the real ones.
 *
 * That is a server-wide setting changed for the duration of two commands, and
 * everything in this file exists to bound what that can cost: it refuses to
 * start behind a queue, it recovers the format after a kill rather than only
 * in a `finally`, and it reports anything the window caught. Measured on a
 * live Sonarr 4.0.19, the window is two commands and under a second when the
 * queue is clear (bardesss/arr-mcp#264).
 */

/**
 * Appended to the naming format for the first pass.
 *
 * It ends up in the filename, and from there in Sonarr's own history
 * permanently — `episodeFileRenamed` records `sourceTitle` and nothing prunes
 * it — so it names the tool and the operation rather than reading like a
 * stray tag someone left behind.
 *
 * A pure suffix, which is what makes the recovery below possible: the original
 * format is the live value with this removed, so nothing has to be stored
 * anywhere to put it back.
 */
export const RENAME_MARKER = ' [arr-mcp-remap]';

type RawNaming = Record<string, unknown> & {
    id?: number;
    standardEpisodeFormat?: string;
    dailyEpisodeFormat?: string;
    animeEpisodeFormat?: string;
};

type RawCommandRow = { id?: number; name?: string; commandName?: string; status?: string };

/**
 * The format a series is actually named by.
 *
 * Sonarr keeps three and uses the one matching the series' own type. Changing
 * `standardEpisodeFormat` for an anime series changes a format nothing in that
 * series is named by, so the first pass renames nothing and the deadlock is
 * still there — with the setting changed for no reason. Measured on the
 * tester's library: 1085 standard, 67 anime, 1 daily.
 */
export function namingFormatKey(seriesType: string | undefined): keyof RawNaming {
    if (seriesType === 'anime') return 'animeEpisodeFormat';
    if (seriesType === 'daily') return 'dailyEpisodeFormat';
    return 'standardEpisodeFormat';
}

/**
 * Sonarr's own housekeeping, which is queued or running essentially always:
 * `RefreshMonitoredDownloads` and `ProcessMonitoredDownloads` each run every
 * minute. Waiting for a genuinely empty queue would mean never starting.
 *
 * They are also exactly what can import a file into the window, which is why
 * that is watched for afterwards rather than prevented — see
 * `importsDuring`. What this list is for is the *other* kind: a command that
 * takes our rename's turn in the queue and holds the temporary format live
 * while it runs. Behind a `RefreshSeries` on a large library that is minutes.
 */
const HOUSEKEEPING = new Set([
    'RefreshMonitoredDownloads',
    'ProcessMonitoredDownloads',
    'CheckHealth',
    'Housekeeping',
    'MessagingCleanup',
    'ApplicationCheckUpdate',
    'BackupCleanup'
]);

/**
 * Refuses to open the window behind anything that would hold it open.
 *
 * The window is not a fixed few seconds — it is one command's turn in Sonarr's
 * queue. Identical rename commands on a live instance took 3.7s each purely on
 * scheduling, and that was a quiet queue.
 */
export async function assertQueueClear(http: ServiceHttp, service: string): Promise<void> {
    const rows = await http.get<RawCommandRow[]>('/api/v3/command');
    const busy = rows.filter(c => {
        const status = (c.status ?? '').toLowerCase();
        if (status !== 'queued' && status !== 'started') return false;
        return !HOUSEKEEPING.has(c.name ?? '') && !HOUSEKEEPING.has(c.commandName ?? '');
    });

    if (busy.length === 0) return;

    throw new ServiceError('UpstreamError', service, `${service} is busy, so the rename was not started`, {
        remedy: `Renaming a rotated season changes ${service}'s episode naming format for the length of two commands, and starting that behind ${busy
            .map(c => c.name ?? c.commandName ?? 'a command')
            .join(', ')} would leave it changed until that finishes. The reassignment is already applied and correct — wait for ${service} to go quiet and run the remap again to pick up the renames.`
    });
}

/** The live format for this series type, with a marker stripped if one
 *  survived a kill — see `RENAME_MARKER`. */
async function readFormat(
    http: ServiceHttp,
    service: string,
    key: keyof RawNaming
): Promise<{ format: string }> {
    const naming = await http.get<RawNaming>('/api/v3/config/naming');
    const live = naming[key];
    if (typeof live !== 'string' || live === '') {
        throw new ServiceError('UpstreamError', service, `${service} reports no ${String(key)} to rename by`, {
            remedy: `Set an episode naming format in ${service} under Settings → Media Management, then try again.`
        });
    }

    if (!live.endsWith(RENAME_MARKER)) return { format: live };

    // A previous run was killed between changing the format and putting it
    // back. Recovered from the live value rather than from anything written
    // down: the marker is a suffix, so the original is what is left without
    // it.
    const restored = live.slice(0, -RENAME_MARKER.length);
    logger.warn(
        { service, key: String(key) },
        'naming format still carried the remap marker from an interrupted run; restoring it'
    );
    await setFormat(http, key, restored);
    return { format: restored };
}

/**
 * Changes one key of the naming config and nothing else. The config is
 * re-read for every write rather than reused from `readFormat`: the PUT takes
 * the whole object, so a snapshot taken before the window would put back
 * whatever else someone changed during it — `renameEpisodes`, the folder
 * formats, the other two episode formats — with no error and no log line.
 */
const setFormat = async (http: ServiceHttp, key: keyof RawNaming, value: string): Promise<void> => {
    const live = await http.get<RawNaming>('/api/v3/config/naming');
    await http.put(`/api/v3/config/naming`, { ...live, [key]: value }, true);
};

type RawHistoryPage = {
    records?: { id?: number; data?: { importedPath?: string } }[];
};

const IMPORT_HISTORY = `/api/v3/history?page=1&pageSize=50&sortKey=date&sortDirection=descending&eventType=3`;

/**
 * The newest import's history id, read before the window opens. Bounding the
 * window by id rather than by timestamp keeps both clocks out of it: our host's
 * and Sonarr's need not agree, and a Sonarr a few seconds behind would file an
 * import from inside the window under "before it".
 */
async function newestImportId(http: ServiceHttp, service: string): Promise<number | undefined> {
    try {
        const page = await http.get<RawHistoryPage>(IMPORT_HISTORY);
        return (page.records ?? []).reduce((max, r) => Math.max(max, r.id ?? 0), 0);
    } catch (err) {
        logger.warn({ service, err }, 'could not read history before the rename window; imports during it will not be checked');
        return undefined;
    }
}

// `eventType=3` is Sonarr's `downloadFolderImported`, numeric in the query,
// confirmed live.

/**
 * Anything imported while the temporary format was live, which would have been
 * named by it.
 *
 * This is the one real cost of the window and it is not preventable: the
 * per-minute `ProcessMonitoredDownloads` is excluded from the queue check
 * above because it is always there. So it is reported instead — a file named
 * with the marker is obvious once someone knows to look, and invisible
 * otherwise.
 */
async function importsDuring(http: ServiceHttp, service: string, after: number | undefined): Promise<string[]> {
    if (after === undefined) return [];
    try {
        const page = await http.get<RawHistoryPage>(IMPORT_HISTORY);
        // The marker test is what scopes this to the series type: the format
        // changed is one of three, and an import named by another one cannot
        // carry it.
        return (page.records ?? [])
            .filter(r => (r.id ?? 0) > after)
            .map(r => r.data?.importedPath)
            .filter((p): p is string => typeof p === 'string' && p.includes(RENAME_MARKER.trim()))
            .map(p => fenceText(p, { service, field: 'path' }));
    } catch (err) {
        // The window is closed by the time this runs and the renames are done.
        // Failing to read history is not a reason to report the rename as
        // failed — it is a reason to say it could not be checked.
        logger.warn({ service, err }, 'could not read history to check what imported during the rename window');
        return [];
    }
}

/** How many of these files Sonarr still wants to rename. Undefined when it
 *  could not be read — the caller then falls back to the command's own count. */
async function stillMisnamed(http: ServiceHttp, seriesId: number, fileIds: number[]): Promise<number | undefined> {
    try {
        const pending = await http.get<{ episodeFileId?: number }[]>(`/api/v3/rename?seriesId=${seriesId}`);
        return pending.filter(r => r.episodeFileId !== undefined && fileIds.includes(r.episodeFileId)).length;
    } catch {
        return undefined;
    }
}

const renamePass = async (
    http: ServiceHttp,
    service: string,
    seriesId: number,
    fileIds: number[]
): Promise<number | undefined> => {
    const queued = await postArrCommand(http, service, { name: 'RenameFiles', seriesId, files: fileIds });
    const settled = await awaitArrCommand(http, service, queued.commandId);
    return renamedCount(settled.message);
};

export type TwoPassResult = {
    renamed: number;
    /** Files imported while the temporary format was live, and so named by it. */
    caughtInWindow: string[];
};

/**
 * Renames a rotated set, through a temporary naming format.
 *
 * Both passes are sent for the whole set rather than one file at a time. The
 * cheaper-looking alternative — break the cycle at one file and let the rest
 * fall like a chain — was measured and is worse: `RenameFiles` re-reads its
 * ids from the database, so the order they are sent in is ignored and it
 * costs one command per file, with the same format window either way.
 *
 * The format is put back in a `finally`, and *also* recovered by
 * `readFormat` on the next run, because a `finally` does not run when the
 * process is killed.
 */
export async function renameThroughTemporaryFormat(
    http: ServiceHttp,
    service: string,
    seriesId: number,
    seriesType: string | undefined,
    fileIds: number[]
): Promise<TwoPassResult> {
    await assertQueueClear(http, service);

    const key = namingFormatKey(seriesType);
    const { format } = await readFormat(http, service, key);
    const importedBefore = await newestImportId(http, service);

    try {
        await setFormat(http, key, `${format}${RENAME_MARKER}`);
        const first = await renamePass(http, service, seriesId, fileIds);
        if (first !== undefined && first < fileIds.length) {
            throw new ServiceError(
                'UpstreamError',
                service,
                `${service} renamed only ${first} of ${fileIds.length} file(s) into temporary names`,
                {
                    remedy: `The naming format has been put back. The reassignment is applied and correct; the filenames are not. Check ${service}'s log for the file it would not rename.`
                }
            );
        }
    } finally {
        await setFormat(http, key, format);
    }

    // Second pass under the real format: every destination is free now,
    // because the first pass moved every one of these files off it.
    const second = await renamePass(http, service, seriesId, fileIds);

    // The command's own count is not trusted alone: a build that stops sending
    // the message reports undefined, and two undefineds would otherwise read as
    // every file renamed. Sonarr's own list of what still wants a different
    // name is the ground truth, and is read whenever it can be.
    const short = (await stillMisnamed(http, seriesId, fileIds)) ?? (second === undefined ? 0 : fileIds.length - second);
    const renamed = fileIds.length - short;

    if (short > 0) {
        throw new ServiceError('UpstreamError', service, `${service} left ${short} file(s) under a temporary name`, {
            remedy: `The naming format is back to what it was, and every file is still on disk — but ${short} of them is not named as it should be, and may still carry "${RENAME_MARKER.trim()}". Run trigger_scan with action "rename" on this series to finish it.`
        });
    }

    return { renamed, caughtInWindow: await importsDuring(http, service, importedBefore) };
}
