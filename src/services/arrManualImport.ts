import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { awaitArrCommand, postArrCommand, renamedCount } from './arrCommands.ts';
import { readArrQueue } from './arrQueue.ts';
import type {
    CommandHandle,
    EpisodeReassignment,
    EpisodeRemapOutcome,
    EpisodeRemapPlan,
    ImportCandidate
} from './types.ts';

/**
 * The download that finished and was never imported — `get_queue` shows it
 * stuck at `importBlocked`, and a library scan does not touch it, because the
 * file is still sitting in the download client's folder.
 *
 * Two steps, both driven by the service's own matching: `/manualimport` says
 * what it thinks each file is and why it will not take it, and the
 * `ManualImport` command imports the ones it *would* take. The quality and
 * languages are echoed back exactly as reported — inventing a quality here is
 * how a file imports as something it is not.
 */

type RawRejection = { reason?: string };
type RawCandidate = {
    path?: string;
    name?: string;
    relativePath?: string;
    size?: number;
    quality?: unknown;
    languages?: unknown;
    releaseGroup?: string | null;
    indexerFlags?: number;
    movie?: { id?: number; title?: string };
    series?: { id?: number; title?: string };
    seasonNumber?: number | null;
    episodes?: { id?: number }[] | null;
    rejections?: RawRejection[] | null;
};

const matchedIdOf = (raw: RawCandidate, resource: 'movie' | 'series'): number | undefined =>
    resource === 'movie' ? raw.movie?.id : raw.series?.id;

function toCandidate(service: string, resource: 'movie' | 'series', raw: RawCandidate): ImportCandidate | undefined {
    if (typeof raw.path !== 'string' || raw.path === '') return undefined;

    const title = resource === 'movie' ? raw.movie?.title : raw.series?.title;
    const episodes = (raw.episodes ?? []).map(e => e.id).filter((id): id is number => typeof id === 'number');

    // A series file the service could not place in an episode is not
    // importable, however healthy it looks: `ManualImport` with no episode ids
    // is accepted and imports nothing.
    const unplaced = resource === 'series' && episodes.length === 0 ? ['no episode matched'] : [];

    return {
        path: raw.path,
        display: fenceText(raw.relativePath ?? raw.name ?? raw.path, { service, field: 'path' }),
        ...(raw.size === undefined ? {} : { sizeBytes: raw.size }),
        ...(title === undefined ? {} : { matchedTitle: fenceText(title, { service, field: 'title' }) }),
        rejections: [
            ...(raw.rejections ?? [])
                .map(r => r.reason)
                .filter((r): r is string => typeof r === 'string' && r !== '')
                .map(r => fenceText(r, { service, field: 'rejection' })),
            ...unplaced
        ],
        ...(matchedIdOf(raw, resource) === undefined ? {} : { matchedId: matchedIdOf(raw, resource) as number }),
        ...(episodes.length === 0 ? {} : { episodeIds: episodes })
    };
}

/**
 * Both services read `trackedDownload.ImportItem.OutputPath` with no null check
 * (`ManualImportService.GetMediaFiles`), and `ImportItem` is set only once the
 * download client reports the item complete — so a download that is still
 * running answers HTTP 500 where a 4xx belongs. Confirmed against a live Radarr
 * 6.3.0.10514; Sonarr's copy of the method is identical.
 *
 * An id the service never tracked is not this case — that answers 200 and an
 * empty list — so the queue is read to confirm the state, and a 500 it cannot
 * account for is rethrown untouched rather than blamed on an unfinished
 * download.
 */
async function explainUnfinishedDownload(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    downloadId: string,
    err: unknown
): Promise<unknown> {
    if (!(err instanceof ServiceError) || err.kind !== 'UpstreamError') return err;

    let row;
    try {
        row = (await readArrQueue(http, service, resource)).find(
            q => q.downloadId?.toLowerCase() === downloadId.toLowerCase()
        );
    } catch {
        // The queue is only here to explain. Failing to read it leaves the
        // original error, which is still the truthful one.
        return err;
    }

    if (row === undefined || row.status.toLowerCase() === 'completed') return err;

    const state = row.importState === undefined ? row.status : `${row.status}/${row.importState}`;
    return new ServiceError('UpstreamError', service, `download ${downloadId} has not finished downloading`, {
        remedy: `get_queue reports it as ${state}. There is nothing to import until the download client says the item is complete — ${service} answers HTTP 500 rather than a clean refusal until then. Wait for it to finish, then try again.`,
        cause: err
    });
}

async function readCandidates(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    downloadId: string
): Promise<{ raw: RawCandidate[]; candidates: ImportCandidate[] }> {
    let raw: RawCandidate[];
    try {
        raw = await http.get<RawCandidate[]>(
            `/api/v3/manualimport?downloadId=${encodeURIComponent(downloadId)}&filterExistingFiles=true`
        );
    } catch (err) {
        throw await explainUnfinishedDownload(http, service, resource, downloadId, err);
    }

    return {
        raw,
        candidates: raw.map(r => toCandidate(service, resource, r)).filter((c): c is ImportCandidate => c !== undefined)
    };
}

export async function listArrImportCandidates(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    downloadId: string
): Promise<ImportCandidate[]> {
    return (await readCandidates(http, service, resource, downloadId)).candidates;
}

/**
 * Re-reads the candidates rather than taking them from the preview: the token
 * binds to the download, and a file list that has moved on should import what
 * is there now or refuse — never a path that no longer exists.
 */
export async function runArrManualImport(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    downloadId: string
): Promise<CommandHandle> {
    const { raw, candidates } = await readCandidates(http, service, resource, downloadId);

    const importable = raw.filter((_, i) => {
        const candidate = candidates[i];
        return candidate !== undefined && candidate.rejections.length === 0 && candidate.matchedId !== undefined;
    });

    if (importable.length === 0) {
        const reasons = [...new Set(candidates.flatMap(c => c.rejections))].join('; ');
        throw new ServiceError('UpstreamError', service, `${service} will not import anything from ${downloadId}`, {
            remedy:
                reasons === ''
                    ? `${service} reported no importable files for that download id. Check it is still in get_queue — ids do not survive an item leaving the queue.`
                    : `It rejected every file: ${reasons}. Fix that in ${service} — this tool imports what the service is willing to take, and forcing a rejected file is not something it will do on your behalf.`
        });
    }

    const files = importable.map(r => ({
        path: r.path,
        ...(resource === 'movie'
            ? { movieId: r.movie?.id }
            : {
                  seriesId: r.series?.id,
                  ...(r.seasonNumber === null || r.seasonNumber === undefined ? {} : { seasonNumber: r.seasonNumber }),
                  episodeIds: (r.episodes ?? []).map(e => e.id)
              }),
        // Echoed back exactly as reported. A quality this code invented is a
        // file that imports as something it is not.
        ...(r.quality === undefined ? {} : { quality: r.quality }),
        ...(r.languages === undefined ? {} : { languages: r.languages }),
        ...(r.releaseGroup === null || r.releaseGroup === undefined ? {} : { releaseGroup: r.releaseGroup }),
        ...(r.indexerFlags === undefined ? {} : { indexerFlags: r.indexerFlags }),
        downloadId
    }));

    return postArrCommand(http, service, { name: 'ManualImport', importMode: 'auto', files });
}

/**
 * The mislabel made once, at the original import: the file named E24 is the
 * Pilot, and the filename, Sonarr's database, the media server and Sonarr's
 * own matcher all agree with the wrong answer. There is nothing to detect it
 * against, so this applies a correction a person has already made.
 *
 * It is the same `ManualImport` command the download path posts, with the
 * episode ids taken from the caller rather than the matcher. For a file inside
 * the series folder Sonarr skips the upgrader, so nothing moves on disk; it
 * drops the file's old row and writes a new one. Checked against a live Sonarr
 * 4.0.20 in bardesss/arr-mcp#264, which is also where the three side effects
 * the tool reports come from.
 *
 * Sonarr only. A Radarr file belongs to one movie, and a movie mislabel is a
 * different item rather than a different slot in the same one.
 */

type RawEpisodeRow = { id?: number; seasonNumber?: number; episodeNumber?: number; episodeFileId?: number };
type RawSeriesFile = RawCandidate & { episodeFileId?: number };

const sxe = (season: number, episode: number): string =>
    `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

type ResolvedRemap = {
    moves: {
        file: RawSeriesFile;
        episodeId: number;
        season: number;
        display: string;
        from: string;
        to: string;
        /** The file currently on the destination episode, if any. */
        holds: number | undefined;
    }[];
    emptied: string[];
    /** True when the moves contain a true cycle: every file in it wants the
     *  name another file in it holds, so no order of renames frees one and the
     *  filenames need a naming-format change and two passes. */
    rotation: boolean;
    /** True when some move wants a name a moving file still holds, but there is
     *  no cycle: the tail renames first, so running rename again peels the rest. */
    chain: boolean;
};

async function resolveEpisodeRemap(
    http: ServiceHttp,
    service: string,
    seriesId: number,
    reassignments: EpisodeReassignment[]
): Promise<ResolvedRemap> {
    // With a series id and no folder, Sonarr maps the files it already has
    // rather than parsing names, so `episodes` is the current association —
    // and after a remap, the corrected one.
    const [files, episodes] = await Promise.all([
        http.get<RawSeriesFile[]>(`/api/v3/manualimport?seriesId=${seriesId}`),
        http.get<RawEpisodeRow[]>(`/api/v3/episode?seriesId=${seriesId}`)
    ]);

    const label = (e: RawEpisodeRow): string => sxe(e.seasonNumber ?? 0, e.episodeNumber ?? 0);
    const episodeById = new Map(episodes.filter(e => typeof e.id === 'number').map(e => [e.id as number, e]));
    const fileById = new Map(files.filter(f => typeof f.episodeFileId === 'number').map(f => [f.episodeFileId as number, f]));

    const seenPaths = new Set<string>();
    const targets = new Map<number, string>();
    const resolved = reassignments.map(r => {
        const file = files.find(f => f.path === r.path || f.relativePath === r.path);
        if (file === undefined || typeof file.path !== 'string') {
            throw new ServiceError('NotFound', service, `series ${seriesId} has no imported file at "${r.path}"`, {
                remedy: 'Give the path relative to the series folder, as Sonarr names it — "Season 01/Show - S01E01 - Pilot.mkv" — or absolute. Only files Sonarr has already imported can be reassigned; a file it never took needs action: "import" or a scan first.'
            });
        }
        if (seenPaths.has(file.path)) throw new Error(`"${r.path}" appears more than once in reassignments.`);
        seenPaths.add(file.path);

        const target = episodes.find(e => e.seasonNumber === r.season && e.episodeNumber === r.episode);
        if (target?.id === undefined) {
            throw new ServiceError('NotFound', service, `series ${seriesId} has no episode ${sxe(r.season, r.episode)}`, {
                remedy: 'get_media_details with include_episodes lists the season and episode numbers Sonarr knows.'
            });
        }
        const clash = targets.get(target.id);
        if (clash !== undefined) {
            throw new Error(`"${clash}" and "${r.path}" are both reassigned to ${label(target)}; one file per episode.`);
        }
        targets.set(target.id, r.path);

        return { file, target: { ...target, id: target.id } };
    });

    const listed = new Set(resolved.map(m => m.file.episodeFileId));

    // A one-way remap leaves the file that used to hold the target as a row no
    // episode points at. Nothing is lost on disk, but it reads as a missing
    // episode plus a dangling file — so the whole rotation has to be in one list.
    for (const { target } of resolved) {
        const holder = target.episodeFileId ? fileById.get(target.episodeFileId) : undefined;
        if (holder !== undefined && !listed.has(holder.episodeFileId)) {
            throw new Error(
                `${label(target)} is currently "${holder.relativePath ?? holder.path}", which is not in reassignments. Moving another file onto ${label(target)} would leave it attached to nothing — say where it goes too, so the whole rotation is applied in one call.`
            );
        }
    }

    const labelOf = (id: number): string => {
        const e = episodeById.get(id);
        return e === undefined ? `episode ${id}` : label(e);
    };
    const moves: ResolvedRemap['moves'] = [];
    const emptied = new Set<string>();

    for (const { file, target } of resolved) {
        const current = (file.episodes ?? []).map(e => e.id).filter((id): id is number => typeof id === 'number');
        if (current.length === 1 && current[0] === target.id) continue;

        for (const id of current) if (!targets.has(id)) emptied.add(labelOf(id));
        moves.push({
            file,
            episodeId: target.id,
            season: target.seasonNumber ?? 0,
            display: fenceText(file.relativePath ?? file.path as string, { service, field: 'path' }),
            from: current.map(labelOf).join('+') || 'no episode',
            to: label(target),
            holds: target.episodeFileId ? target.episodeFileId : undefined
        });
    }

    // A held target's holder is always in the list (the orphan check above
    // refuses anything else), and a holder already on its own episode would
    // clash with this target, so the holder of a move's target is itself a move.
    // Following holders from a move either ends at a free target (a chain) or
    // comes back round to it (a cycle). Computed over `moves`, not `resolved`:
    // a file already in place is not renamed and takes no part in either.
    const moveByFile = new Map(moves.map(m => [m.file.episodeFileId, m]));
    const inCycle = (start: ResolvedRemap['moves'][number]): boolean => {
        let cur = start;
        for (let i = 0; i < moves.length; i++) {
            const next = cur.holds === undefined ? undefined : moveByFile.get(cur.holds);
            if (next === undefined) return false;
            if (next === start) return true;
            cur = next;
        }
        return false;
    };
    const rotation = moves.some(inCycle);
    const chain = !rotation && moves.some(m => m.holds !== undefined);

    return { moves, emptied: [...emptied], rotation, chain };
}

const seriesIdOf = (service: string, seriesId: string): number => {
    const id = Number(seriesId);
    if (!Number.isInteger(id)) {
        throw new ServiceError('NotFound', service, `"${seriesId}" is not a Sonarr series id`, {
            remedy: 'Sonarr series ids are integers. Take one from `acquisition.id` on get_library or get_media_details.'
        });
    }
    return id;
};

export async function planArrEpisodeRemap(
    http: ServiceHttp,
    service: string,
    seriesId: string,
    reassignments: EpisodeReassignment[]
): Promise<EpisodeRemapPlan> {
    const { moves, emptied, rotation, chain } = await resolveEpisodeRemap(http, service, seriesIdOf(service, seriesId), reassignments);
    return { moves: moves.map(({ display, from, to }) => ({ display, from, to })), emptied, rotation, chain };
}

/** Re-resolves rather than trusting the preview, for the same reason the
 *  download import does: the association may have moved on since. */
export async function runArrEpisodeRemap(
    http: ServiceHttp,
    service: string,
    seriesId: string,
    reassignments: EpisodeReassignment[]
): Promise<EpisodeRemapOutcome> {
    const id = seriesIdOf(service, seriesId);
    const { moves, rotation } = await resolveEpisodeRemap(http, service, id, reassignments);

    if (moves.length === 0) {
        throw new ServiceError('UpstreamError', service, 'every file is already on the episode asked for', {
            remedy: 'Nothing was sent. If the preview said otherwise, something else changed the association in between.'
        });
    }

    // One command for the whole set: applied file by file, a rotation would
    // pass through the orphaned state the check above refuses. `importMode` is
    // left out — Sonarr never reads it for a file already in the series folder.
    const files = moves.map(({ file, episodeId, season }) => ({
        path: file.path,
        seriesId: id,
        seasonNumber: season,
        episodeIds: [episodeId],
        ...(file.quality === undefined ? {} : { quality: file.quality }),
        ...(file.languages === undefined ? {} : { languages: file.languages }),
        ...(file.releaseGroup === null || file.releaseGroup === undefined ? {} : { releaseGroup: file.releaseGroup }),
        ...(file.indexerFlags === undefined ? {} : { indexerFlags: file.indexerFlags })
    }));

    const remap = await postArrCommand(http, service, { name: 'ManualImport', files });
    await awaitArrCommand(http, service, remap.commandId);

    // `resolveEpisodeRemap` refuses a file without a path, so the filter drops
    // nothing — it is how that guarantee reaches the type.
    const movedPaths = files.map(f => f.path).filter((p): p is string => typeof p === 'string');
    await verifyRemapLanded(http, service, id, moves);

    return { remap, cycle: rotation, ...(await renameRemappedFiles(http, service, id, movedPaths)) };
}

/**
 * Checks that the reassignment Sonarr accepted is the one it applied.
 *
 * Not defensive programming for its own sake — caught live. A rotation on a
 * clean series applies exactly as asked, but the same rotation sent seconds
 * after two earlier remaps of the same series left one episode pointing at a
 * second, duplicate row for another file's path, and the file that should have
 * moved there attached to nothing. Sonarr reported the command `completed`
 * and `successful` throughout.
 *
 * Nothing is lost when that happens — every file is still on disk under its
 * own name — but a half-applied rotation reads as a missing episode plus a
 * duplicate, and reporting it as done is how it goes unnoticed. So the write
 * fails here, after the fact, naming what actually happened.
 */
async function verifyRemapLanded(
    http: ServiceHttp,
    service: string,
    seriesId: number,
    moves: ResolvedRemap['moves']
): Promise<void> {
    const episodes = await http.get<RawEpisodeRow[]>(`/api/v3/episode?seriesId=${seriesId}`);
    const files = await http.get<RawSeriesFile[]>(`/api/v3/manualimport?seriesId=${seriesId}`);
    const pathOf = new Map(
        files
            .filter(f => typeof f.episodeFileId === 'number')
            .map(f => [f.episodeFileId as number, f.path ?? f.relativePath ?? ''])
    );

    const wrong = moves.filter(m => {
        const episode = episodes.find(e => e.id === m.episodeId);
        const landed = episode?.episodeFileId;
        return landed === undefined || landed === 0 || pathOf.get(landed) !== m.file.path;
    });
    if (wrong.length === 0) return;

    throw new ServiceError(
        'UpstreamError',
        service,
        `${service} accepted the reassignment but ${wrong.length} of ${moves.length} file(s) did not land on the episode asked for`,
        {
            remedy: `Every file is still on disk under its own name — nothing is lost, but the library is half-applied: ${wrong
                .map(m => `${m.to} should hold ${m.display}`)
                .join('; ')}. Run trigger_scan with action "scan" and \`id\` set to this series so ${service} re-reads the folder, check what it settled on, then send the remap again if it is still wrong.`
        }
    );
}

type RawRenameRow = { episodeFileId?: number; existingPath?: string; newPath?: string };

/**
 * Makes the filenames match the episodes the remap just moved the files onto.
 *
 * Part of the remap rather than a `rename` call afterwards, for two reasons
 * found live (#264). `RenameSeries` — what `action: "rename"` sends — renames
 * the *whole series*, which on the series this issue came from would have
 * renamed 40 files in seasons the remap never touched. And the ids change:
 * Sonarr recreates each moved file's record, so the ids the caller had before
 * the remap are stale and the rename has to be scoped to the new ones.
 *
 * A destination that is still on disk is left alone rather than forced. In a
 * rotation every new name is another moved file's current name, so nothing in
 * the set has a free destination — Sonarr reports that as `completed` with
 * "0 selected episode files renamed", which is why the count below is read
 * rather than the status. Breaking that deadlock needs Sonarr's naming format
 * changed and two passes; it is deliberately not done here, and the caller is
 * told which files are waiting on it.
 */
async function renameRemappedFiles(
    http: ServiceHttp,
    service: string,
    seriesId: number,
    movedPaths: string[]
): Promise<{ renamed: number; blocked: { path: string; wants: string }[] }> {
    // Re-read for the ids Sonarr has just assigned, and ask it what it would
    // rename rather than deriving names from the format ourselves.
    const [after, pending] = await Promise.all([
        http.get<RawSeriesFile[]>(`/api/v3/manualimport?seriesId=${seriesId}`),
        http.get<RawRenameRow[]>(`/api/v3/rename?seriesId=${seriesId}`)
    ]);

    const moved = new Set(
        after
            .filter(f => typeof f.path === 'string' && movedPaths.includes(f.path))
            .map(f => f.episodeFileId)
            .filter((id): id is number => typeof id === 'number')
    );

    // Every file the series holds right now. A destination in this set is a
    // name Sonarr cannot write to, whoever holds it.
    const onDisk = new Set(after.map(f => f.relativePath).filter((p): p is string => typeof p === 'string'));

    const mine = pending.filter(r => typeof r.episodeFileId === 'number' && moved.has(r.episodeFileId));
    const blocked = mine
        .filter(r => typeof r.newPath === 'string' && onDisk.has(r.newPath))
        .map(r => ({
            path: fenceText(r.existingPath ?? '', { service, field: 'path' }),
            wants: fenceText(r.newPath ?? '', { service, field: 'path' })
        }));

    const free = mine.filter(r => !(typeof r.newPath === 'string' && onDisk.has(r.newPath)));
    if (free.length === 0) return { renamed: 0, blocked };

    const rename = await postArrCommand(http, service, {
        name: 'RenameFiles',
        seriesId,
        files: free.map(r => r.episodeFileId)
    });
    const settled = await awaitArrCommand(http, service, rename.commandId);
    const count = renamedCount(settled.message);

    // `completed` is not the signal — the count is. A build that stops
    // sending the message reports undefined, which is not zero: the files it
    // was asked about are reported as renamed rather than silently written
    // off, since Sonarr accepted the command and said nothing was wrong.
    if (count !== undefined && count < free.length) {
        throw new ServiceError(
            'UpstreamError',
            service,
            `${service} reassigned the files but renamed only ${count} of ${free.length}`,
            {
                remedy: `The reassignment is applied and correct; only the filenames are behind. ${service} reported: "${settled.message ?? ''}". Check its log for the file it would not rename, then run action: "rename" on the series to retry.`
            }
        );
    }

    return { renamed: count ?? free.length, blocked };
}
