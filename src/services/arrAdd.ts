import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { AddCandidate, AddMediaOptions, QualityProfile, RootFolder } from './types.ts';

/**
 * Adding to Radarr and Sonarr, shared for the same reason the queue read is:
 * the two differ only in which noun and which external id they use. The
 * differences are the four values in `ArrAddShape`; everything else — the
 * profile and root-folder lookups, the "is it already there" check, the
 * argument validation — is identical, and writing it twice is how the two
 * drift into disagreeing about what adding means.
 */

export type ArrAddShape = {
    /** `movie` or `series` — the REST noun. */
    resource: 'movie' | 'series';
    /** `tmdbId` or `tvdbId` — the field the add posts back. */
    idField: 'tmdbId' | 'tvdbId';
    /** For error prose: which provider's id this service speaks. */
    idLabel: 'tmdb' | 'tvdb';
    lookupPath: (id: number) => string;
    /**
     * Radarr's by-id lookup answers a single object; Sonarr's term search
     * answers an array. Not cosmetic — reading one as the other yields
     * undefined and reports a real film as "matched nothing".
     */
    lookupReturnsArray: boolean;
    /** Radarr searches for a movie, Sonarr for missing episodes. */
    searchOption: 'searchForMovie' | 'searchForMissingEpisodes';
};

/**
 * Both services use the term search, and Radarr's dedicated
 * `/movie/lookup/tmdb?tmdbId=` is deliberately **not** used, despite existing
 * and being the more obvious choice.
 *
 * Probed against a live Radarr 6.3.0:
 *
 *   /movie/lookup/tmdb?tmdbId=603 200, one MovieResource
 *   /movie/lookup/tmdb?tmdbId=999999999 500, MovieNotFoundException
 *   /movie/lookup?term=tmdb:603 200, a one-element array
 *   /movie/lookup?term=tmdb:999999999 200, []
 *
 * An unknown id is a **500** on the dedicated endpoint, which `classifyHttpStatus`
 * turns into `UpstreamError` — telling the user Radarr is broken when in fact
 * their id is wrong. The term form answers an empty array, which becomes a
 * clean `NotFound` naming the id. Symmetry with Sonarr, which has no by-id
 * endpoint at all, is a bonus rather than the reason.
 */
export const RADARR_ADD: ArrAddShape = {
    resource: 'movie',
    idField: 'tmdbId',
    idLabel: 'tmdb',
    lookupPath: id => `/api/v3/movie/lookup?term=tmdb:${id}`,
    lookupReturnsArray: true,
    searchOption: 'searchForMovie'
};

export const SONARR_ADD: ArrAddShape = {
    resource: 'series',
    idField: 'tvdbId',
    idLabel: 'tvdb',
    lookupPath: id => `/api/v3/series/lookup?term=tvdb:${id}`,
    lookupReturnsArray: true,
    searchOption: 'searchForMissingEpisodes'
};

type RawProfile = { id?: number; name?: string };
type RawRootFolder = { path?: string; freeSpace?: number };
type RawLookup = { id?: number; title?: string; year?: number };

export async function readQualityProfiles(http: ServiceHttp, service: string): Promise<QualityProfile[]> {
    const rows = await http.get<RawProfile[]>('/api/v3/qualityprofile');
    return rows
        .filter((p): p is RawProfile & { id: number } => typeof p.id === 'number')
        .map(p => {
            const name = p.name ?? `profile ${p.id}`;
            // Raw for matching, fenced for prose — see QualityProfile.
            return { id: p.id, name, display: fenceText(name, { service, field: 'name' }) };
        });
}

export async function readRootFolders(http: ServiceHttp, service: string): Promise<RootFolder[]> {
    const rows = await http.get<RawRootFolder[]>('/api/v3/rootfolder');
    return rows
        .filter((r): r is RawRootFolder & { path: string } => typeof r.path === 'string' && r.path !== '')
        .map(r => ({
            // Raw, because this is what gets posted back as a directory.
            path: r.path,
            // Fenced, because this is what reaches model context as prose.
            display: fenceText(r.path, { service, field: 'path' }),
            ...(typeof r.freeSpace === 'number' ? { freeSpaceBytes: r.freeSpace } : {})
        }));
}

/**
 * The single lookup both the preview and the write are built from. Returns the
 * service's own raw payload alongside the fenced summary, because the add has
 * to post the former back and the preview has to show the latter — and doing
 * the lookup twice to get both would be two chances for them to disagree about
 * what is being added.
 */
async function lookupRaw(
    http: ServiceHttp,
    service: string,
    shape: ArrAddShape,
    externalId: string
): Promise<{ raw: RawLookup; candidate: AddCandidate }> {
    const numeric = Number(externalId);
    if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new ServiceError('NotFound', service, `"${externalId}" is not a ${shape.idLabel} id`, {
            remedy: `${service} adds by ${shape.idLabel} id, which is a positive integer. lookup_media returns one under \`ids.${shape.idLabel}\`.`
        });
    }

    const notFound = new ServiceError('NotFound', service, `${shape.idLabel} id ${numeric} matched nothing`, {
        remedy: `Check the id with lookup_media. ${service} resolves this against its own metadata provider, so an id that is right for the other service will not match here — Radarr takes TMDB, Sonarr takes TVDB.`
    });

    const payload = await http.get<RawLookup | RawLookup[]>(shape.lookupPath(numeric));
    const first = shape.lookupReturnsArray ? (payload as RawLookup[])[0] : (payload as RawLookup);
    if (first === undefined || first.title === undefined) throw notFound;

    return {
        raw: first,
        candidate: {
            title: fenceText(first.title, { service, field: 'title' }),
            ...(first.year === undefined || first.year === 0 ? {} : { year: first.year }),
            // A lookup for something not in the library carries no `id` at all
            // (verified live against Radarr and Sonarr, and matching the
            // recorded fixtures), so an id here means it is already added — a
            // no-op, not an error. The `> 0` also rules out a zero, which some
            // builds are reported to send instead of omitting the field.
            ...(typeof first.id === 'number' && first.id > 0 ? { existingId: first.id } : {})
        }
    };
}

export async function lookupArrForAdd(
    http: ServiceHttp,
    service: string,
    shape: ArrAddShape,
    externalId: string
): Promise<AddCandidate> {
    return (await lookupRaw(http, service, shape, externalId)).candidate;
}

export async function addArrMedia(
    http: ServiceHttp,
    service: string,
    shape: ArrAddShape,
    opts: AddMediaOptions
): Promise<{ id: number; title: string }> {
    const { raw, candidate } = await lookupRaw(http, service, shape, opts.externalId);

    if (candidate.existingId !== undefined) {
        // Reached only when something was added between the preview and the
        // confirmation. Posting anyway creates a duplicate entry, so it fails.
        throw new ServiceError('UpstreamError', service, `that ${shape.resource} is already in ${service}`, {
            remedy: 'It was added between the preview and the confirmation, so nothing was changed here.'
        });
    }

    // Built from the service's own raw lookup payload, not from the fenced
    // candidate: the fence exists for model context, and a title carrying
    // escaped angle brackets is not what anyone wants stored in their library.
    const body: Record<string, unknown> = {
        ...raw,
        [shape.idField]: Number(opts.externalId),
        qualityProfileId: opts.qualityProfileId,
        rootFolderPath: opts.rootFolderPath,
        monitored: opts.monitored,
        addOptions: { [shape.searchOption]: opts.searchNow }
    };

    // Sonarr stores each series in its own folder by default, and omitting
    // this drops every episode of every series into the root together.
    if (shape.resource === 'series') body.seasonFolder = true;
    // Radarr's own UI defaults to "Released", which is what stops a brand-new
    // film grabbing a cinema recording the day it is announced.
    if (shape.resource === 'movie') body.minimumAvailability = 'released';

    const created = await http.post<RawLookup>(`/api/v3/${shape.resource}`, body);
    if (typeof created.id !== 'number' || created.id <= 0) {
        throw new ServiceError('UpstreamError', service, `${service} returned no id for the added ${shape.resource}`, {
            remedy: 'It may still have been added — check with get_media_details before trying again.'
        });
    }

    return { id: created.id, title: fenceText(created.title ?? '', { service, field: 'title' }) };
}
