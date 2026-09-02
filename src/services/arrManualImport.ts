import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { postArrCommand } from './arrCommands.ts';
import type { CommandHandle, ImportCandidate } from './types.ts';

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

async function readCandidates(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    downloadId: string
): Promise<{ raw: RawCandidate[]; candidates: ImportCandidate[] }> {
    const raw = await http.get<RawCandidate[]>(
        `/api/v3/manualimport?downloadId=${encodeURIComponent(downloadId)}&filterExistingFiles=true`
    );
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
