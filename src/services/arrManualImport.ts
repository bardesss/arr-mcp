import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { ArrKind } from '../core/resolver.ts';
import { arrItemId, awaitArrCommand, postArrCommand, renamedCount } from './arrCommands.ts';
import { renameThroughTemporaryFormat } from './arrRename.ts';
import { readArrQueue } from './arrQueue.ts';
import type {
    CommandHandle,
    EpisodeReassignment,
    EpisodeRemapOutcome,
    EpisodeRemapPlan,
    ImportCandidate,
    ImportMapping,
    QueueItem
} from './types.ts';
import { episodeCode } from '../core/labels.ts';

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
    episodes?: { id?: number; seasonNumber?: number; episodeNumber?: number }[] | null;
    /** Lidarr only (`ManualLibraryKind`, Lidarr 3.1.0): a file belongs to an artist, an album and its tracks. */
    artist?: { id?: number; artistName?: string };
    album?: { id?: number; title?: string };
    albumReleaseId?: number;
    tracks?: { id?: number }[] | null;
    disableReleaseSwitching?: boolean;
    rejections?: RawRejection[] | null;
    /** Set here, never upstream: the file was placed by a caller's mapping. */
    mapped?: true;
};

type RawEpisodeRow = { id?: number; seasonNumber?: number; episodeNumber?: number; episodeFileId?: number };

/** The film, series or artist the file matched: Radarr, Sonarr and Lidarr name its field after the kind. */
const matchedIdOf = (raw: RawCandidate, resource: ArrKind): number | undefined => raw[resource]?.id;

const trackIdsOf = (raw: RawCandidate): number[] =>
    (raw.tracks ?? []).map(t => t.id).filter((id): id is number => typeof id === 'number');

/** A Lidarr file is named by its artist and album, the way a Sonarr file is by its series and episode labels. */
function musicTitleOf(raw: RawCandidate): string | undefined {
    const artist = raw.artist?.artistName;
    if (artist === undefined) return undefined;
    return raw.album?.title === undefined ? artist : `${artist} — ${raw.album.title}`;
}

/**
 * A Lidarr file with no album, no release or no tracks cannot be imported:
 * `ManualImport` looks up the album, the release and the tracks by id for every
 * file it is given, and the read reports a missing release as
 * `albumReleaseId: 0` (`ManualImportResource`, Lidarr 3.1.0). Like a Sonarr
 * file with no episode, it is reported as not importable however healthy it
 * looks.
 */
const unplacedMusic = (raw: RawCandidate): string[] => [
    ...(typeof raw.album?.id === 'number' ? [] : ['no album matched']),
    ...(Number.isInteger(raw.albumReleaseId) && (raw.albumReleaseId as number) > 0 ? [] : ['no release matched']),
    ...(trackIdsOf(raw).length > 0 ? [] : ['no track matched'])
];

function toCandidate(service: string, resource: ArrKind, raw: RawCandidate): ImportCandidate | undefined {
    if (typeof raw.path !== 'string' || raw.path === '') return undefined;

    const title = resource === 'artist' ? musicTitleOf(raw) : raw[resource]?.title;
    const episodes = (raw.episodes ?? []).map(e => e.id).filter((id): id is number => typeof id === 'number');
    const labels = (raw.episodes ?? [])
        .filter(e => typeof e.seasonNumber === 'number' && typeof e.episodeNumber === 'number')
        .map(e => episodeCode(e.seasonNumber as number, e.episodeNumber as number));

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
            ...unplaced,
            ...(resource === 'artist' ? unplacedMusic(raw) : [])
        ],
        ...(matchedIdOf(raw, resource) === undefined ? {} : { matchedId: matchedIdOf(raw, resource) as number }),
        ...(episodes.length === 0 ? {} : { episodeIds: episodes }),
        ...(labels.length === 0 ? {} : { episodeLabels: labels }),
        ...(raw.mapped === true ? { mapped: true as const } : {})
    };
}

/** The queue row for `downloadId` while that download has not finished, or `undefined`. */
async function unfinishedRow(
    http: ServiceHttp,
    service: string,
    resource: ArrKind,
    downloadId: string
): Promise<QueueItem | undefined> {
    const row = (await readArrQueue(http, service, resource)).find(
        q => q.downloadId?.toLowerCase() === downloadId.toLowerCase()
    );
    return row === undefined || row.status.toLowerCase() === 'completed' ? undefined : row;
}

/**
 * The *arrs' `QueueStatus`: `unknown`, `queued`, `paused`, `downloading`,
 * `completed`, `failed`, `warning`, `delay`, `downloadClientUnavailable` and
 * `fallback` (the generated specs). These are a download on its way to
 * `completed`.
 */
const IN_PROGRESS = new Set(['queued', 'paused', 'delay', 'downloading']);

/**
 * Worded by state: a download that is still on its way "has not finished", and
 * waiting is the remedy, with `why` explaining the service's answer to a read
 * while it runs. One at `failed` is not going to finish, so saying it had not
 * would read as "wait for it"; it is named as failed, and the remedy is to
 * remove it or fix it in the client. `warning` usually means stuck rather than
 * stopped: the clients map a stalled torrent and missing files to it
 * (`QBittorrent`, `TransmissionBase`, Lidarr 3.1.0), and a stalled torrent
 * often finishes later. Not every warning will: a qBittorrent magnet with DHT
 * off waits there for good. So it is named as a warning, and the remedy points
 * at the row's own reason, which the client gives in the queue row's
 * `errorMessage` (`QueueService`) and `get_queue` shows at `detail: "full"`.
 * Anything else (`unknown`, `downloadClientUnavailable`, `fallback`) says only
 * what is known: the queue does not report it completed.
 */
function notFinished(service: string, downloadId: string, row: QueueItem, why: string, cause?: unknown): ServiceError {
    const status = row.status.toLowerCase();
    const state = row.importState === undefined ? row.status : `${row.status}/${row.importState}`;
    const opts = cause === undefined ? {} : { cause };
    if (IN_PROGRESS.has(status)) {
        return new ServiceError('UpstreamError', service, `download ${downloadId} has not finished downloading`, {
            remedy: `get_queue reports it as ${state}. There is nothing to import until the download client says the item is complete — ${why}. Wait for it to finish, then try again.`,
            ...opts
        });
    }
    if (status === 'warning') {
        return new ServiceError('UpstreamError', service, `download ${downloadId} has a warning in the download client`, {
            remedy: `get_queue reports it as ${state}, not completed, so there is nothing to import yet. get_queue at \`detail: "full"\` shows that row's \`errorMessage\`, and any \`statusMessages\`, which say why when the client gave a reason. A stalled torrent often finishes later, so waiting may be enough; otherwise fix it in the download client and try again.`,
            ...opts
        });
    }
    if (status === 'failed') {
        return new ServiceError('UpstreamError', service, `download ${downloadId} is ${row.status} in the download client`, {
            remedy: `get_queue reports it as ${state}, not completed, so there is nothing to import. remove_queue_item removes it, with \`blocklist: true\` to have ${service} look for another release; or fix it in the download client and try again.`,
            ...opts
        });
    }
    return new ServiceError('UpstreamError', service, `download ${downloadId} is not completed`, {
        remedy: `get_queue reports it as ${state}, so there is nothing to import yet. Check the download there and in the download client, then try again.`,
        ...opts
    });
}

/**
 * Radarr and Sonarr read `trackedDownload.ImportItem.OutputPath` with no null
 * check (`ManualImportService.GetMediaFiles`), and `ImportItem` is set only
 * once the download client reports the item complete — so a download that is
 * still running answers HTTP 500 where a 4xx belongs. Confirmed against a live
 * Radarr 6.3.0.10514; Sonarr's copy of the method is identical. Lidarr is
 * refused before its read instead (`refuseUnfinishedMusic`).
 *
 * An id the service never tracked is not this case — that answers 200 and an
 * empty list — so the queue is read to confirm the state, and a 500 it cannot
 * account for is rethrown untouched rather than blamed on an unfinished
 * download.
 */
async function explainUnfinishedDownload(
    http: ServiceHttp,
    service: string,
    resource: ArrKind,
    downloadId: string,
    err: unknown
): Promise<unknown> {
    if (!(err instanceof ServiceError) || err.kind !== 'UpstreamError') return err;

    let row;
    try {
        row = await unfinishedRow(http, service, resource, downloadId);
    } catch {
        // The queue is only here to explain. Failing to read it leaves the
        // original error, which is still the truthful one.
        return err;
    }

    return row === undefined
        ? err
        : notFinished(service, downloadId, row, `${service} answers HTTP 500 rather than a clean refusal until then`, err);
}

/**
 * Lidarr cannot be left to fail the candidate read for a download still in
 * progress. It asks the download client for the item when it has none yet
 * (`ManualImportService.GetMediaFiles`, Lidarr 3.1.0). NZBGet reports no
 * folder until it finishes, so that read still answers HTTP 500 (seen on
 * 3.1.6.5079). A torrent client reports the folder while it fills, so the read
 * lists the partial files and judges them as they stand: seen on 2.1.3.3927
 * with qBittorrent, every file rejected as "Has missing tracks" or with no
 * album matched. Its queue is read first, and an unfinished download is
 * refused the way Radarr and Sonarr refuse it. A queue that cannot be read
 * fails the import too, since without it an unfinished download cannot be
 * told apart.
 */
async function refuseUnfinishedMusic(http: ServiceHttp, service: string, downloadId: string): Promise<void> {
    const row = await unfinishedRow(http, service, 'artist', downloadId);
    if (row !== undefined) {
        throw notFinished(service, downloadId, row, `until then ${service} either fails the read or lists a torrent's partial files`);
    }
}

const UNKNOWN_QUALITY = { quality: { id: 0, name: 'Unknown' }, revision: { version: 1, real: 0, isRepack: false } };
const UNKNOWN_LANGUAGES = [{ id: 0, name: 'Unknown' }];

function checkMappingShape(service: string, resource: 'movie' | 'series', m: ImportMapping): void {
    const series = m.seriesId !== undefined || m.season !== undefined || m.episodes !== undefined;
    if (resource === 'movie' && (m.movieId === undefined || series)) {
        throw new Error(`On ${service}, a mapping entry takes \`movie_id\` and nothing else ("${m.path}").`);
    }
    if (
        resource === 'series' &&
        (m.movieId !== undefined || m.seriesId === undefined || m.season === undefined || (m.episodes ?? []).length === 0)
    ) {
        throw new Error(`On ${service}, a mapping entry takes \`series_id\`, \`season\` and \`episodes\` ("${m.path}").`);
    }
}

type TargetLookup = { title?: string; episodes: RawEpisodeRow[] };

/** Read before the reprocess call, which answers an unknown id with a 404 that
 *  names `/manualimport` rather than the id. */
async function lookUpTarget(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: number
): Promise<TargetLookup> {
    let target: { title?: string };
    try {
        target = await http.get<{ title?: string }>(`${http.apiRoot}/${resource}/${id}`);
    } catch (err) {
        if (err instanceof ServiceError && err.kind === 'NotFound') {
            throw new ServiceError('NotFound', service, `${service} has no ${resource} ${id}`, {
                remedy: 'Take the id from `acquisition.id` on get_library.',
                cause: err
            });
        }
        throw err;
    }
    const episodes =
        resource === 'series' ? await http.get<RawEpisodeRow[]>(`${http.apiRoot}/episode?seriesId=${id}`) : [];
    return { ...(target.title === undefined ? {} : { title: target.title }), episodes };
}

/**
 * The service re-judges each mapped file through the reprocess call its own
 * Manual Import dialog makes, so a person's answer replaces the matcher's guess
 * without overriding a rejection the service still has. Paths, series and
 * episodes are all resolved first, so a bad one fails before anything is sent.
 */
async function applyMapping(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    downloadId: string,
    raw: RawCandidate[],
    mapping: ImportMapping[]
): Promise<RawCandidate[]> {
    const seen = new Set<number>();
    const located = mapping.map(m => {
        checkMappingShape(service, resource, m);
        const index = raw.findIndex(r => r.path === m.path || r.relativePath === m.path || r.name === m.path);
        if (index === -1) {
            const known = raw.map(r => r.relativePath ?? r.name ?? r.path).join('; ');
            throw new ServiceError('NotFound', service, `download ${downloadId} has no file "${m.path}"`, {
                remedy: `Use a path as the preview names it. ${service} sees: ${fenceText(known, { service, field: 'path' })}.`
            });
        }
        if (seen.has(index)) throw new Error(`"${m.path}" appears more than once in mapping.`);
        seen.add(index);
        return { m, r: raw[index] as RawCandidate & { path: string }, index };
    });

    const targetOf = (m: ImportMapping): number => (resource === 'movie' ? m.movieId : m.seriesId) as number;
    const targets = new Map<number, TargetLookup>();
    for (const id of new Set(located.map(l => targetOf(l.m)))) {
        targets.set(id, await lookUpTarget(http, service, resource, id));
    }

    const items = located.map(({ m, r, index }) => {
        const known = targets.get(targetOf(m))?.episodes ?? [];
        const episodes = (m.episodes ?? []).map(n => {
            const found = known.find(e => e.seasonNumber === m.season && e.episodeNumber === n);
            if (found?.id === undefined) {
                throw new ServiceError('NotFound', service, `series ${m.seriesId} has no episode ${episodeCode(m.season ?? 0, n)}`, {
                    remedy: 'get_media_details with include_episodes lists the season and episode numbers Sonarr knows.'
                });
            }
            return found;
        });

        return {
            m,
            r,
            index,
            episodes,
            body: {
                path: r.path,
                downloadId,
                ...(resource === 'movie'
                    ? { movieId: m.movieId }
                    : { seriesId: m.seriesId, seasonNumber: m.season, episodeIds: episodes.map(e => e.id) }),
                // Sonarr reads both without a null check. Unknown asks it to
                // parse them from the file, as it would have anyway.
                quality: r.quality ?? UNKNOWN_QUALITY,
                languages: r.languages ?? UNKNOWN_LANGUAGES,
                ...(r.releaseGroup === null || r.releaseGroup === undefined ? {} : { releaseGroup: r.releaseGroup }),
                ...(r.indexerFlags === undefined ? {} : { indexerFlags: r.indexerFlags })
            }
        };
    });

    const judged = await http.post<RawCandidate[]>(`${http.apiRoot}/manualimport`, items.map(i => i.body));

    const merged = [...raw];
    items.forEach(({ m, r, index, episodes, body }, i) => {
        const back = judged[i] ?? {};
        const title = targets.get(targetOf(m))?.title;
        const releaseGroup = back.releaseGroup ?? r.releaseGroup;
        const indexerFlags = back.indexerFlags ?? r.indexerFlags;
        const target = { id: targetOf(m), ...(title === undefined ? {} : { title }) };
        merged[index] = {
            ...r,
            ...(resource === 'movie' ? { movie: target } : { series: target, seasonNumber: m.season as number, episodes }),
            quality: back.quality ?? body.quality,
            languages: back.languages ?? body.languages,
            ...(releaseGroup === undefined ? {} : { releaseGroup }),
            ...(indexerFlags === undefined ? {} : { indexerFlags }),
            rejections: back.rejections ?? [],
            mapped: true
        };
    });
    return merged;
}

/**
 * A mapping answers "which movie, or which season and episodes", and a Lidarr
 * file is neither. Refused before anything is sent, never ignored: an ignored
 * one would import on Lidarr's own match while the caller believed theirs had
 * been applied.
 */
function refuseMusicMapping(service: string, mapping: readonly ImportMapping[]): void {
    if (mapping.length === 0) return;
    throw new Error(
        `${service} does not take a \`mapping\`: it names a movie or episodes, and a Lidarr file belongs to an album and its tracks. ` +
            'Drop it. If Lidarr matched a file to the wrong album, fix the match in Lidarr itself.'
    );
}

/**
 * Lidarr's read defaults `replaceExistingFiles` to true (`ManualImportController`,
 * Lidarr 3.1.0), which judges every file as if it may overwrite the library's
 * copy. This tool never asks for that, so it says so on the read as on the
 * import.
 */
const candidateQuery = (resource: ArrKind, downloadId: string): string =>
    `downloadId=${encodeURIComponent(downloadId)}&filterExistingFiles=true` +
    (resource === 'artist' ? '&replaceExistingFiles=false' : '');

async function readCandidates(
    http: ServiceHttp,
    service: string,
    resource: ArrKind,
    downloadId: string,
    mapping: ImportMapping[] = []
): Promise<{ raw: RawCandidate[]; judged: (ImportCandidate | undefined)[]; candidates: ImportCandidate[] }> {
    if (resource === 'artist') {
        refuseMusicMapping(service, mapping);
        await refuseUnfinishedMusic(http, service, downloadId);
    }
    let raw: RawCandidate[];
    try {
        raw = await http.get<RawCandidate[]>(`${http.apiRoot}/manualimport?${candidateQuery(resource, downloadId)}`);
    } catch (err) {
        throw await explainUnfinishedDownload(http, service, resource, downloadId, err);
    }
    if (mapping.length > 0 && resource !== 'artist') raw = await applyMapping(http, service, resource, downloadId, raw, mapping);

    // `judged` keeps one slot per raw row, `undefined` where a row has no
    // path, so `judged[i]` is always `raw[i]`'s own verdict. `candidates`
    // drops those slots for display, and is never indexed against `raw`.
    const judged = raw.map(r => toCandidate(service, resource, r));
    return { raw, judged, candidates: judged.filter((c): c is ImportCandidate => c !== undefined) };
}

export async function listArrImportCandidates(
    http: ServiceHttp,
    service: string,
    resource: ArrKind,
    downloadId: string,
    mapping?: ImportMapping[]
): Promise<ImportCandidate[]> {
    return (await readCandidates(http, service, resource, downloadId, mapping)).candidates;
}

/**
 * Re-reads the candidates to post their current quality and ids, but imports
 * exactly the files the preview listed (`paths`) or refuses: a file list that
 * has moved on since the preview is never imported on the old confirmation.
 */
export async function runArrManualImport(
    http: ServiceHttp,
    service: string,
    resource: ArrKind,
    downloadId: string,
    mapping?: ImportMapping[],
    paths?: string[]
): Promise<CommandHandle> {
    const { raw, judged, candidates } = await readCandidates(http, service, resource, downloadId, mapping);

    // Indexed through `judged`, never `candidates`: the filtered list is
    // shorter than `raw` whenever a row had no path, and pairing it with
    // `raw` by position put the next file's verdict on the wrong row, posting
    // a pathless row or a file the service had rejected.
    let importable = raw.filter((_, i) => {
        const candidate = judged[i];
        return candidate !== undefined && candidate.rejections.length === 0 && candidate.matchedId !== undefined;
    });

    if (importable.length === 0) {
        const reasons = [...new Set(candidates.flatMap(c => c.rejections))].join('; ');
        const fix =
            resource === 'artist'
                ? `Fix the match in ${service} itself: \`mapping\` names movies and episodes, and this tool imports what the service is willing to take, never forcing a rejected file.`
                : `If ${service} matched a file to the wrong movie or episodes, or to none, pass \`mapping\` to say what it is and ${service} judges it again. Anything it still rejects has to be fixed in ${service}: this tool imports what the service is willing to take, and forcing a rejected file is not something it will do on your behalf.`;
        throw new ServiceError('UpstreamError', service, `${service} will not import anything from ${downloadId}`, {
            remedy:
                reasons === ''
                    ? `${service} reported no importable files for that download id. Check it is still in get_queue — ids do not survive an item leaving the queue.`
                    : `It rejected every file: ${reasons}. ${fix}`
        });
    }

    if (paths !== undefined) {
        const present = new Set(importable.map(r => r.path));
        const gone = paths.filter(p => !present.has(p));
        if (gone.length > 0) {
            // The paths are not echoed: they come from the download and are unfenced.
            throw new ServiceError(
                'UpstreamError',
                service,
                `${service}'s files for ${downloadId} have changed since the preview: ${gone.length} previewed file(s) are no longer importable`,
                { remedy: 'Preview the import again and confirm the new token.' }
            );
        }
        const wanted = new Set(paths);
        importable = importable.filter(r => r.path !== undefined && wanted.has(r.path));
    }

    if (resource === 'artist') {
        // Lidarr's `ManualImportFile`: artist, album, the release the matcher
        // chose and its tracks, echoed as Lidarr reported them.
        const music = importable.map(r => ({
            path: r.path,
            artistId: r.artist?.id,
            albumId: r.album?.id,
            albumReleaseId: r.albumReleaseId,
            trackIds: trackIdsOf(r),
            ...(r.quality === undefined ? {} : { quality: r.quality }),
            ...(r.indexerFlags === undefined ? {} : { indexerFlags: r.indexerFlags }),
            downloadId,
            disableReleaseSwitching: r.disableReleaseSwitching ?? false
        }));
        return postArrCommand(http, service, { name: 'ManualImport', importMode: 'auto', replaceExistingFiles: false, files: music });
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

type RawSeriesFile = RawCandidate & { episodeFileId?: number };

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
        http.get<RawSeriesFile[]>(`${http.apiRoot}/manualimport?seriesId=${seriesId}`),
        http.get<RawEpisodeRow[]>(`${http.apiRoot}/episode?seriesId=${seriesId}`)
    ]);

    const label = (e: RawEpisodeRow): string => episodeCode(e.seasonNumber ?? 0, e.episodeNumber ?? 0);
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
            throw new ServiceError('NotFound', service, `series ${seriesId} has no episode ${episodeCode(r.season, r.episode)}`, {
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

export async function planArrEpisodeRemap(
    http: ServiceHttp,
    service: string,
    seriesId: string,
    reassignments: EpisodeReassignment[]
): Promise<EpisodeRemapPlan> {
    const { moves, emptied, rotation, chain } = await resolveEpisodeRemap(http, service, arrItemId(service, 'series', seriesId), reassignments);
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
    const id = arrItemId(service, 'series', seriesId);
    const { moves } = await resolveEpisodeRemap(http, service, id, reassignments);

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

    return { remap, ...(await renameRemappedFiles(http, service, id, movedPaths)) };
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
    const episodes = await http.get<RawEpisodeRow[]>(`${http.apiRoot}/episode?seriesId=${seriesId}`);
    const files = await http.get<RawSeriesFile[]>(`${http.apiRoot}/manualimport?seriesId=${seriesId}`);
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

/** Which of Sonarr's three episode naming formats this series is named by. */
const seriesTypeOf = async (http: ServiceHttp, seriesId: number): Promise<string | undefined> =>
    (await http.get<{ seriesType?: string }>(`${http.apiRoot}/series/${seriesId}`)).seriesType;

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
): Promise<{ renamed: number; blocked: { path: string; wants: string }[]; caughtInWindow?: string[] }> {
    // Re-read for the ids Sonarr has just assigned, and ask it what it would
    // rename rather than deriving names from the format ourselves.
    const [after, pending] = await Promise.all([
        http.get<RawSeriesFile[]>(`${http.apiRoot}/manualimport?seriesId=${seriesId}`),
        http.get<RawRenameRow[]>(`${http.apiRoot}/rename?seriesId=${seriesId}`)
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
    const isBlocked = (r: RawRenameRow): boolean => typeof r.newPath === 'string' && onDisk.has(r.newPath);
    const free = mine.filter(r => !isBlocked(r));

    // Every destination taken: the rotation. `RenameFiles` would answer
    // `completed` having renamed nothing, so the only way through is two
    // passes under a temporary naming format — see `arrRename.ts` for what
    // that costs and how it is bounded.
    if (mine.length > 0 && free.length === 0) {
        const ids = mine.map(r => r.episodeFileId).filter((id): id is number => typeof id === 'number');
        const { renamed, caughtInWindow } = await renameThroughTemporaryFormat(
            http,
            service,
            seriesId,
            await seriesTypeOf(http, seriesId),
            ids
        );
        return { renamed, blocked: [], caughtInWindow };
    }

    if (free.length === 0) return { renamed: 0, blocked: [] };

    const blocked = mine.filter(isBlocked).map(r => ({
        path: fenceText(r.existingPath ?? '', { service, field: 'path' }),
        wants: fenceText(r.newPath ?? '', { service, field: 'path' })
    }));

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
                remedy: `The reassignment is applied and correct; only the filenames are behind. ${service} reported: ${fenceText(settled.message ?? '', { service, field: 'message' }) || 'nothing'}. Check its log for the file it would not rename, then run action: "rename" on the series to retry.`
            }
        );
    }

    return { renamed: count ?? free.length, blocked };
}
