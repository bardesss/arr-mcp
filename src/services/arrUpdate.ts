import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { MediaUpdateOptions, MediaUpdateState } from './types.ts';

/**
 * Changing something already in Radarr or Sonarr. Shared for the reason
 * `arrAdd.ts` is shared: the two differ only in the REST noun, and writing it
 * twice is how they drift into disagreeing about what an update means.
 *
 * Always read-modify-write. Both services **replace the whole resource** on
 * PUT, so a partial body blanks every field left out — including the path, the
 * tags and the season list.
 */

type RawResource = {
    id?: number;
    title?: string;
    year?: number;
    monitored?: boolean;
    qualityProfileId?: number;
    path?: string;
    rootFolderPath?: string;
    tags?: number[];
    minimumAvailability?: string;
    seriesType?: string;
};

const numericId = (service: string, resource: 'movie' | 'series', value: string): number => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ServiceError('NotFound', service, `"${value}" is not a ${service} ${resource} id`, {
            remedy: `${service} ids are integers. Take one from \`acquisition.id\` on get_library or get_media_details.`
        });
    }
    return id;
};

const toState = (service: string, raw: RawResource): MediaUpdateState => ({
    title: fenceText(raw.title ?? '', { service, field: 'title' }),
    ...(raw.year === undefined || raw.year === 0 ? {} : { year: raw.year }),
    monitored: raw.monitored ?? false,
    ...(raw.qualityProfileId === undefined ? {} : { qualityProfileId: raw.qualityProfileId }),
    ...(raw.path === undefined ? {} : { path: fenceText(raw.path, { service, field: 'path' }) }),
    tagIds: raw.tags ?? [],
    ...(raw.minimumAvailability === undefined ? {} : { minimumAvailability: raw.minimumAvailability }),
    ...(raw.seriesType === undefined ? {} : { seriesType: raw.seriesType })
});

export async function readArrForUpdate(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: string
): Promise<MediaUpdateState> {
    const numeric = numericId(service, resource, id);
    return toState(service, await http.get<RawResource>(`/api/v3/${resource}/${numeric}`));
}

export async function updateArrMedia(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: string,
    opts: MediaUpdateOptions
): Promise<MediaUpdateState> {
    const numeric = numericId(service, resource, id);
    const current = await http.get<RawResource>(`/api/v3/${resource}/${numeric}`);

    const body: Record<string, unknown> = { ...current };
    if (opts.qualityProfileId !== undefined) body.qualityProfileId = opts.qualityProfileId;
    if (opts.monitored !== undefined) body.monitored = opts.monitored;
    if (opts.minimumAvailability !== undefined) body.minimumAvailability = opts.minimumAvailability;
    if (opts.seriesType !== undefined) body.seriesType = opts.seriesType;
    if (opts.tagIds !== undefined) body.tags = opts.tagIds;
    if (opts.rootFolderPath !== undefined) body.rootFolderPath = opts.rootFolderPath;

    // `moveFiles` is only ever true alongside a new root folder: the flag
    // means "move to the folder this body names", and sending it without one
    // asks the service to move an item to where it already is.
    const move = opts.rootFolderPath !== undefined && opts.moveFiles;
    const updated = await http.put<RawResource>(`/api/v3/${resource}/${numeric}?moveFiles=${String(move)}`, body);

    // Both services answer with the updated resource. A build that answers
    // something empty would otherwise report every field as cleared.
    return toState(service, typeof updated?.id === 'number' ? updated : { ...current, ...body });
}
