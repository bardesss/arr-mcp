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

/**
 * How long to wait for a queued command to finish, and how often to ask.
 *
 * Everything else in `trigger_scan` queues and returns, which is right for a
 * scan nobody is waiting on. A remap is different: the rename that follows it
 * needs the file ids the remap assigns, so there is a second command that
 * cannot be posted until the first is done.
 *
 * The budget is generous because the wait is a queue position, not the work:
 * identical rename commands on a live Sonarr took 3.7s each purely on
 * scheduling, and behind a `RefreshSeries` on a large library it is minutes
 * (measured in bardesss/arr-mcp#264).
 */
const COMMAND_POLL_MS = 1_000;
export const COMMAND_WAIT_MS = 180_000;

/** Sonarr's terminal states. `completed` is not success on its own — see
 *  `renamedCount` below for the command that lies about it. */
const SETTLED = new Set(['completed', 'failed', 'aborted', 'cancelled']);

type RawCommandDetail = RawCommand & { message?: string; result?: string };

/**
 * Waits for one command to reach a terminal state, and hands back the row
 * rather than a verdict: `status` alone does not say whether the work
 * happened, and the caller is the one that knows what success looks like.
 */
export async function awaitArrCommand(
    http: ServiceHttp,
    service: string,
    commandId: number,
    sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<{ status: string; result?: string; message?: string }> {
    const deadline = Date.now() + COMMAND_WAIT_MS;

    for (;;) {
        const row = await http.get<RawCommandDetail>(`/api/v3/command/${commandId}`);
        const status = (row.status ?? 'unknown').toLowerCase();
        if (SETTLED.has(status)) {
            return {
                status,
                ...(row.result === undefined ? {} : { result: row.result }),
                ...(row.message === undefined ? {} : { message: row.message })
            };
        }

        if (Date.now() >= deadline) {
            throw new ServiceError(
                'Timeout',
                service,
                `${service} command ${commandId} was still ${status} after ${COMMAND_WAIT_MS / 1000}s`,
                {
                    remedy: `It has not failed — it is queued behind something. stack_health's \`commands\` says what ${service} is working on; check back there rather than sending this again.`
                }
            );
        }

        await sleep(COMMAND_POLL_MS);
    }
}

/**
 * How many files a `RenameFiles` command actually renamed.
 *
 * The count is the only truthful signal this command gives. A rename blocked
 * because every destination is taken by another file in the same set finishes
 * `completed` with `result: successful` and the message "0 selected episode
 * files renamed for <series>" — verified live on Sonarr 4.0.19, and
 * independently in #264. Anything reading the status alone reports that as a
 * success.
 *
 * Undefined when the message is missing or shaped differently, which is not
 * the same as zero: a build that stops sending it must not be read as having
 * renamed nothing.
 */
export function renamedCount(message: string | undefined): number | undefined {
    const match = /^(\d+) selected episode files renamed/.exec(message ?? '');
    return match === undefined || match === null ? undefined : Number(match[1]);
}
