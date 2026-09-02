import { ServiceError } from '../core/errors.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { CommandHandle, CommandStatus } from './types.ts';

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

type RawCommand = {
    id?: number;
    name?: string;
    commandName?: string;
    status?: string;
    queued?: string;
    started?: string;
    ended?: string;
};

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

/** How long after a command ends it is still worth reporting. "Did my search
 *  finish?" is a question about the last few minutes; anything older is
 *  history, which `get_history` answers. */
const RECENT_MS = 15 * 60 * 1000;

/**
 * The tasks this server can start, and therefore the only ones a caller can
 * be following up. Everything else on `/api/v3/command` is the scheduler's
 * own housekeeping.
 *
 * An allowlist rather than a denylist, and **not** a filter on `trigger`,
 * because a live probe killed that idea: Radarr reports its own per-minute
 * `RefreshMonitoredDownloads` as `manual` and `ProcessMonitoredDownloads` as
 * `unspecified`, while Sonarr calls the same work `scheduled`. Filtering on
 * the trigger would have kept exactly the noise. Measured on a quiet stack,
 * the unfiltered window held 37 rows, every one of them a poller.
 */
const FOLLOWABLE = new Set([
    'MoviesSearch',
    'SeriesSearch',
    'SeasonSearch',
    'EpisodeSearch',
    'RefreshMovie',
    'RefreshSeries',
    'RenameMovie',
    'RenameSeries',
    'ManualImport',
    'ApplicationIndexerSync'
]);

/** Bounded like `scans` rather than wrapped in a truncation envelope: one
 *  `limit` budget already spans failures and disks, and a third claimant on it
 *  would make `limit` mean nothing. */
const MAX_COMMANDS = 25;

/**
 * What the service is running now, plus what it has just finished — the
 * follow-up `trigger_search` and `trigger_scan` never had. A command that is
 * not in this list and not in the last fifteen minutes of it has finished;
 * that is the whole answer.
 *
 * Scoped to the tasks this server can start (`FOLLOWABLE`): on a live stack
 * the raw window is entirely the scheduler's per-minute pollers, which would
 * crowd out the one row the caller asked about.
 */
export async function readArrCommands(
    http: ServiceHttp,
    service: string,
    now: number = Date.now()
): Promise<CommandStatus[]> {
    const rows = await http.get<RawCommand[]>('/api/v3/command');

    return rows
        .filter((c): c is RawCommand & { id: number } => typeof c.id === 'number')
        // `commandName` is the task's own name; `name` is the display form,
        // and on some builds they differ in case only. Either matching is
        // enough — dropping a real search because a build spelled it the
        // other way would defeat the point of the list.
        .filter(c => FOLLOWABLE.has(c.name ?? '') || FOLLOWABLE.has(c.commandName ?? ''))
        .filter(c => {
            const status = (c.status ?? '').toLowerCase();
            if (status === 'queued' || status === 'started') return true;
            // `Date.parse` on a malformed value is NaN, which compares false
            // against everything — a row with an unreadable end time drops out
            // rather than being reported as running.
            return now - Date.parse(c.ended ?? '') <= RECENT_MS;
        })
        .map(c => ({
            service,
            commandId: c.id,
            // `commandName` is the task; `name` is the display form and is
            // what every other CommandHandle here reports.
            name: c.name ?? c.commandName ?? 'unknown',
            status: c.status ?? 'unknown',
            ...(c.queued === undefined ? {} : { queuedAt: c.queued }),
            ...(c.started === undefined ? {} : { startedAt: c.started }),
            ...(c.ended === undefined ? {} : { endedAt: c.ended })
        }))
        .sort((a, b) => (b.queuedAt ?? '').localeCompare(a.queuedAt ?? ''))
        .slice(0, MAX_COMMANDS);
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
