import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { arrItemId } from './arrCommands.ts';
import type { MediaUpdateOptions, MediaUpdateState } from './types.ts';

/**
 * Changing something already in Radarr or Sonarr. Shared for the reason
 * `arrAdd.ts` is shared: the two differ only in the REST noun, and writing it
 * twice is how they drift into disagreeing about what an update means.
 *
 * Through the editor, `PUT /{movie|series}/editor`. It sets only the fields it
 * is sent. Given a root folder it derives the new path itself, and moves the
 * files only when `moveFiles` is true. The single-item PUT moved to the `path`
 * in its body, which a read-modify-write left as the old one, so a root folder
 * change moved nothing.
 */

type RawResource = {
    id?: number;
    title?: string;
    year?: number;
    monitored?: boolean;
    qualityProfileId?: number;
    path?: string;
    tags?: number[];
    minimumAvailability?: string;
    seriesType?: string;
    /** Sonarr 4 only (`NewItemMonitorTypes`): whether a refresh monitors the seasons it adds. */
    monitorNewItems?: string;
};

const toState = (service: string, raw: RawResource): MediaUpdateState => ({
    title: fenceText(raw.title ?? '', { service, field: 'title' }),
    ...(raw.year === undefined || raw.year === 0 ? {} : { year: raw.year }),
    monitored: raw.monitored ?? false,
    ...(raw.qualityProfileId === undefined ? {} : { qualityProfileId: raw.qualityProfileId }),
    ...(raw.path === undefined ? {} : { path: fenceText(raw.path, { service, field: 'path' }) }),
    tagIds: raw.tags ?? [],
    ...(raw.minimumAvailability === undefined ? {} : { minimumAvailability: raw.minimumAvailability }),
    ...(raw.seriesType === undefined ? {} : { seriesType: raw.seriesType }),
    ...(raw.monitorNewItems === 'all' || raw.monitorNewItems === 'none' ? { monitorNewItems: raw.monitorNewItems } : {})
});

export async function readArrForUpdate(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: string
): Promise<MediaUpdateState> {
    const numeric = arrItemId(service, resource, id);
    return toState(service, await http.get<RawResource>(`${http.apiRoot}/${resource}/${numeric}`));
}

export async function updateArrMedia(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: string,
    opts: MediaUpdateOptions
): Promise<MediaUpdateState> {
    const numeric = arrItemId(service, resource, id);

    const body: Record<string, unknown> = { [resource === 'movie' ? 'movieIds' : 'seriesIds']: [numeric] };
    if (opts.qualityProfileId !== undefined) body.qualityProfileId = opts.qualityProfileId;
    if (opts.monitored !== undefined) body.monitored = opts.monitored;
    if (opts.minimumAvailability !== undefined) body.minimumAvailability = opts.minimumAvailability;
    if (opts.seriesType !== undefined) body.seriesType = opts.seriesType;
    if (opts.monitorNewItems !== undefined) body.monitorNewItems = opts.monitorNewItems;
    if (opts.rootFolderPath !== undefined) body.rootFolderPath = opts.rootFolderPath;
    if (opts.tagIds !== undefined) {
        body.tags = opts.tagIds;
        body.applyTags = 'replace';
    }
    // `moveFiles` is only ever true alongside a new root folder: the flag
    // means "move to the folder this body names", and sending it without one
    // asks the service to move an item to where it already is.
    body.moveFiles = opts.rootFolderPath !== undefined && opts.moveFiles;

    // The spec gives the editor PUT a bare 200 with no schema, so the body is
    // discarded and the state is read back: one GET, independent of the shape.
    await http.put(`${http.apiRoot}/${resource}/editor`, body, true);
    return readArrForUpdate(http, service, resource, id);
}
