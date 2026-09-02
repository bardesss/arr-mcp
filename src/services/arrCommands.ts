import { ServiceError } from '../core/errors.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { CommandHandle } from './types.ts';

/**
 * The command endpoint Radarr and Sonarr share. Every queued task in this
 * codebase goes through `postArrCommand`, so the handle a caller gets back is
 * built one way rather than three.
 *
 * The payload shapes are **not** symmetric between the two services and
 * cannot be guessed: Sonarr's refresh takes a bare `seriesId` where Radarr's
 * takes `movieIds: []`, exactly as `SeriesSearch` and `MoviesSearch` differ.
 * Sending the other one's shape is accepted and runs against nothing.
 */

type RawCommand = { id?: number; name?: string; status?: string };

export async function postArrCommand(
    http: ServiceHttp,
    service: string,
    body: Record<string, unknown> & { name: string }
): Promise<CommandHandle> {
    const queued = await http.post<RawCommand>('/api/v3/command', body);
    return {
        service,
        commandId: queued.id ?? 0,
        name: queued.name ?? body.name,
        ...(typeof queued.status === 'string' ? { status: queued.status } : {})
    };
}

/** Refused before the POST: both services accept an id they cannot resolve
 *  and report a queued command that runs against nothing. */
export function arrItemId(service: string, resource: 'movie' | 'series', value: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ServiceError('NotFound', service, `"${value}" is not a ${service} ${resource} id`, {
            remedy: `${service} ids are integers. Take one from \`acquisition.id\` on get_library or get_media_details.`
        });
    }
    return id;
}

export async function refreshArrItem(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: string
): Promise<CommandHandle> {
    const numeric = arrItemId(service, resource, id);
    return postArrCommand(
        http,
        service,
        resource === 'movie' ? { name: 'RefreshMovie', movieIds: [numeric] } : { name: 'RefreshSeries', seriesId: numeric }
    );
}

export async function renameArrItem(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: string
): Promise<CommandHandle> {
    const numeric = arrItemId(service, resource, id);
    return postArrCommand(
        http,
        service,
        resource === 'movie' ? { name: 'RenameMovie', movieIds: [numeric] } : { name: 'RenameSeries', seriesIds: [numeric] }
    );
}
