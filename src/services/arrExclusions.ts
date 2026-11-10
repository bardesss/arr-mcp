import type { ServiceHttp } from '../core/http.ts';
import type { ImportExclusion } from './types.ts';

/**
 * Import list exclusions: titles an *arr's own import lists will not add
 * again. Radarr, Sonarr and Lidarr differ only in the path, the field the
 * exclusion is keyed on, and what they call the title, read live from Radarr
 * 6.4 (`tmdbId, movieTitle, movieYear, id`) and Sonarr 4.0 (`tvdbId, title,
 * id`), and from Lidarr's spec (`foreignId, artistName, id`).
 *
 * None of them looks one up by its key, so a check reads the whole list. On
 * the live Radarr that is 1,348 rows, which is one call and small.
 *
 * Whisparr is left out on purpose: its exclusion field is named `tvdbId`
 * while its add flow speaks ThePornDB ids, and which of them the field holds
 * needs a live capture.
 */

type ExclusionShape = {
    path: 'exclusions' | 'importlistexclusion';
    keyField: 'tmdbId' | 'tvdbId' | 'foreignId';
    titleField: 'movieTitle' | 'title' | 'artistName';
    yearField?: 'movieYear';
};

export const RADARR_EXCLUSIONS: ExclusionShape = { path: 'exclusions', keyField: 'tmdbId', titleField: 'movieTitle', yearField: 'movieYear' };
export const SONARR_EXCLUSIONS: ExclusionShape = { path: 'importlistexclusion', keyField: 'tvdbId', titleField: 'title' };
export const LIDARR_EXCLUSIONS: ExclusionShape = { path: 'importlistexclusion', keyField: 'foreignId', titleField: 'artistName' };

type RawExclusion = Record<string, unknown> & { id?: number };

/** The key as the *arr stores it: a number for TMDB and TVDB, a lower-case GUID for MusicBrainz. */
const keyOf = (shape: ExclusionShape, externalId: string): number | string =>
    shape.keyField === 'foreignId' ? externalId.toLowerCase() : Number(externalId);

export async function findExclusion(http: ServiceHttp, shape: ExclusionShape, externalId: string): Promise<ImportExclusion | undefined> {
    const key = keyOf(shape, externalId);
    const rows = await http.getArray<RawExclusion>(`${http.apiRoot}/${shape.path}`);
    const row = rows.find(r => {
        const value = r[shape.keyField];
        return typeof value === 'string' ? value.toLowerCase() === key : value === key;
    });
    return row === undefined || typeof row.id !== 'number' ? undefined : { id: row.id };
}

/** `title` is stored as given, unfenced: it is the *arr's own record, not text shown to a model. */
export async function addExclusion(
    http: ServiceHttp,
    shape: ExclusionShape,
    externalId: string,
    label: { title: string; year?: number }
): Promise<void> {
    await http.post<unknown>(`${http.apiRoot}/${shape.path}`, {
        [shape.keyField]: keyOf(shape, externalId),
        [shape.titleField]: label.title,
        ...(shape.yearField === undefined || label.year === undefined ? {} : { [shape.yearField]: label.year })
    });
}

export async function removeExclusion(http: ServiceHttp, shape: ExclusionShape, exclusionId: number): Promise<void> {
    await http.delete(`${http.apiRoot}/${shape.path}/${exclusionId}`);
}
