import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ServiceId, serviceOf } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { NextStep } from '../core/nextStep.ts';
import {
    hasCommandStatus,
    hasBookLibraryScan,
    hasEpisodeRemap,
    hasLibraryMaintenance,
    hasLibraryScan,
    hasManualImport,
    hasMediaDetails,
    hasPostProcess,
    hasUserLibrary,
    type BookLibrary,
    type BookLibraryScanCapable,
    type EpisodeRemapCapable,
    type LibraryMaintenanceCapable,
    type ImportMapping,
    type LibraryScanCapable,
    type ManualImportCapable,
    type PostProcessCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, instanceArgs, resolveInstance } from './resolveInstance.ts';
import { outcomeText, registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';

/**
 * The other half of the answer `diagnose` gives most often.
 *
 * `diagnose` names a stale library scan as the usual reason something that
 * finished downloading is still not playable — and until 1.0 nothing here could
 * act on it, so its best answer ended "now go and start one yourself". The tool
 * that identifies a problem should be able to fix it.
 *
 * **Safe, not destructive.** A scan reads the filesystem and updates a
 * database; nothing is deleted, nothing is grabbed, and running one you did not
 * need costs time and disk I/O rather than data. `destructive` is reserved for
 * writes whose worst outcome is losing something.
 */

const findAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & LibraryScanCapable => {
    const adapter = resolveInstance(adapters, service, instance);

    if (!hasLibraryScan(adapter)) {
        // Refused rather than accepted as a no-op: a queue client or an indexer
        // has no library to scan, and reporting success for an action that
        // could never happen is how a model concludes the scan is done.
        throw new ServiceError('NotFound', service, `${service} has no library to scan`, {
            remedy: 'Only radarr, sonarr, whisparr, lidarr, jellyfin, plex and grimmory manage a library, and prowlarr syncs its indexers to them. For "it downloaded but will not play", the media server — jellyfin or plex — is almost always the one you want.'
        });
    }

    return adapter;
};

/** The per-item form asks for more: a media server has the whole-library scan
 *  and neither the refresh nor the rename. */
const findItemAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & LibraryMaintenanceCapable => {
    const adapter = resolveInstance(adapters, service, instance);

    if (!hasLibraryMaintenance(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot refresh or rename one item`, {
            remedy: 'Only radarr, sonarr, whisparr and lidarr manage individual items. For a media server, scan the whole library — omit `id`.'
        });
    }

    return adapter;
};

/** Importing a finished download is Radarr's, Sonarr's and Lidarr's alone: a
 *  media server never had the file in a download folder to begin with. */
const findImportAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & ManualImportCapable => {
    const adapter = resolveInstance(adapters, service, instance);

    if (!hasManualImport(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot import a download`, {
            remedy: 'Only radarr, sonarr and lidarr import downloads. Pick the one that was supposed to manage the item.'
        });
    }

    return adapter;
};

/** Running post-processing again is a download client's job: NZBGet's. */
const findPostProcessAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & PostProcessCapable => {
    const adapter = resolveInstance(adapters, service, instance);

    if (!hasPostProcess(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot run post-processing again`, {
            remedy: 'postprocess is for nzbget: it reruns NZBGet\'s post-processing on a finished download. For a download Radarr, Sonarr or Lidarr never took, use action "import" on that *arr instead.'
        });
    }

    return adapter;
};

/** Only Sonarr has episodes to put a file in. */
const findRemapAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & EpisodeRemapCapable => {
    const adapter = resolveInstance(adapters, service, instance);

    if (!hasEpisodeRemap(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no episodes to reassign a file to`, {
            remedy: 'remap is for sonarr: it moves an already-imported file onto a different episode of the same series.'
        });
    }

    return adapter;
};

/** The media servers that can be told to scan: what a remap leaves out of date. */
const scannableMediaServers = (adapters: readonly ServiceAdapter[]): ServiceAdapter[] =>
    adapters.filter(a => hasUserLibrary(a) && hasLibraryScan(a));

const IdSchema = z.string().regex(/^[1-9]\d*$/, 'a numeric id, as `acquisition.id` on get_library');

type MappingInput = {
    path: string;
    movie_id?: string | undefined;
    series_id?: string | undefined;
    season?: number | undefined;
    episodes?: number[] | undefined;
};

const toImportMapping = (mapping: MappingInput[] | undefined): ImportMapping[] | undefined =>
    mapping?.map(m => ({
        path: m.path,
        ...(m.movie_id === undefined ? {} : { movieId: Number(m.movie_id) }),
        ...(m.series_id === undefined ? {} : { seriesId: Number(m.series_id) }),
        ...(m.season === undefined ? {} : { season: m.season }),
        ...(m.episodes === undefined ? {} : { episodes: m.episodes })
    }));

/** `library` and `action: "bookdrop"` are Grimmory's; on any other service they are refused, not ignored. */
const refuseGrimmoryOnly = (service: ServiceId, library: string | undefined, action: string): void => {
    if (library === undefined && action !== 'bookdrop') return;
    throw new ServiceError('NotFound', service, `${service} has no ${library === undefined ? 'Bookdrop' : 'library to pick by name'}`, {
        remedy: '`library` and action "bookdrop" are for grimmory. Other services scan their whole library, or one item with `id`.'
    });
};

const libraryList = (libraries: readonly BookLibrary[]): string =>
    libraries.map(l => `${l.label} (id ${l.id})`).join(', ');

/**
 * The library `library` names. A match is by id or by name, ignoring case, and
 * both count at once: a library named "2" and the library with id 2 are two
 * answers, and two answers is a refusal that lists them, never a pick.
 */
function resolveBookLibrary(service: ServiceId, libraries: readonly BookLibrary[], wanted: string): BookLibrary {
    const lower = wanted.toLowerCase();
    const matches = libraries.filter(l => l.id === wanted || l.name.toLowerCase() === lower);

    if (matches.length === 1) return matches[0] as BookLibrary;

    if (matches.length > 1) {
        throw new ServiceError('NotFound', service, `"${wanted}" matches ${matches.length} libraries in ${service}`, {
            remedy: `They are ${libraryList(matches)}. Pass the numeric id of the one you mean as \`library\`.`
        });
    }

    throw new ServiceError('NotFound', service, `${service} has no library "${wanted}"`, {
        remedy: libraries.length === 0 ? `${service} has no libraries.` : `Its libraries are ${libraryList(libraries)}. Pass a name or an id.`
    });
}

async function planBookScan(
    adapter: ServiceAdapter & BookLibraryScanCapable,
    args: { service: ServiceId; instance: string | undefined; action: string; id: string | undefined; library: string | undefined }
): Promise<WritePlan> {
    const { service, instance, action, id, library } = args;
    const bound = (libraryIds: string[]) => ({ service, action, libraryIds, ...(instance === undefined ? {} : { instance }) });

    if (action === 'bookdrop' && id !== undefined) return planBookdropImport(adapter, { service, instance, id, library });
    if (id !== undefined) {
        throw new ServiceError('NotFound', service, `${service} cannot scan one item by id`, {
            remedy: 'On grimmory `id` is a book. To rescan one library pass `library`, with its name or id. To approve a Bookdrop file, pass its id with action "bookdrop".'
        });
    }
    if (action !== 'scan' && action !== 'bookdrop') {
        throw new ServiceError('NotFound', service, `${service} cannot ${action}`, {
            remedy: 'grimmory takes action "scan" (all libraries, or one with `library`) and "bookdrop".'
        });
    }

    if (action === 'bookdrop') {
        if (library !== undefined) {
            throw new Error('action "bookdrop" rescans the Bookdrop folder, not a library: drop `library`, or use action "scan".');
        }
        return {
            target: `${adapter.id}:bookdrop`,
            summary: `Ask ${adapter.id} to rescan its Bookdrop folder.`,
            effects: [
                `Has ${adapter.id} look in the Bookdrop folder again for files added since it last looked.`,
                'Imports nothing by itself: new files wait in the Bookdrop until they are finalised in Grimmory.',
                'Runs in the background.'
            ],
            args: bound([])
        };
    }

    const all = await adapter.listBookLibraries();
    const chosen = library === undefined ? [...all] : [resolveBookLibrary(service, all, library)];
    const scanned = chosen.filter(l => !l.watch);
    const skips = chosen
        .filter(l => l.watch)
        .map(l => `Skips ${l.label}: its watch is on, so Grimmory's file watcher already picks up changes there.`);
    const target = library === undefined ? `${adapter.id}:libraries` : `${adapter.id}:library/${chosen[0]?.id ?? ''}`;

    if (scanned.length === 0) {
        return {
            target,
            summary:
                chosen.length === 0
                    ? `${adapter.id} has no libraries to rescan.`
                    : `Nothing to rescan in ${adapter.id}: the file watcher already picks up changes in ${chosen.length === 1 ? 'that library' : 'every library'}.`,
            effects: skips,
            noop: true
        };
    }

    return {
        target,
        summary: `Ask ${adapter.id} to rescan ${scanned.length === 1 ? 'one library' : `${scanned.length} libraries`}.`,
        effects: [
            ...scanned.map(l => `Rescans ${l.label} (id ${l.id}) for books added, moved or removed on disk since the last scan.`),
            ...skips,
            'Runs in the background, one library after another.'
        ],
        args: bound(scanned.map(l => l.id))
    };
}

/**
 * Approves one Bookdrop file (#532) with the metadata Grimmory read from the
 * file, never the provider match it fetched: a provider hit with another
 * publisher is another edition. Library and folder are taken when there is
 * only one, and otherwise must be named.
 */
async function planBookdropImport(
    adapter: ServiceAdapter & BookLibraryScanCapable,
    args: { service: ServiceId; instance: string | undefined; id: string; library: string | undefined }
): Promise<WritePlan> {
    const { service, instance, id, library } = args;
    const file = await adapter.readBookdropFile(id);
    if (file === undefined) {
        throw new ServiceError('NotFound', service, `${service} has no Bookdrop file ${id} waiting`, {
            remedy: 'get_queue lists the Bookdrop files waiting, as grimmory:<id>. It may already have been imported or discarded.'
        });
    }
    if (file.original === undefined) {
        throw new ServiceError('UpstreamError', service, `${service} has not read the metadata of Bookdrop file ${id} yet`, {
            remedy: 'Rescan the Bookdrop (action "bookdrop" without `id`) and try again once Grimmory has read the file.'
        });
    }
    const all = await adapter.listBookLibraries();
    if (library === undefined && all.length !== 1) {
        throw new ServiceError('NotFound', service, `${service} has ${all.length} libraries, so pass \`library\``, {
            remedy: all.length === 0 ? `${service} has no libraries.` : `Its libraries are ${libraryList(all)}.`
        });
    }
    const chosen = library === undefined ? all[0]! : resolveBookLibrary(service, all, library);
    if (chosen.pathIds.length !== 1) {
        throw new ServiceError('UpstreamError', service, `${chosen.label} has ${chosen.pathIds.length} folders`, {
            remedy: 'arr-mcp only imports into a library with a single folder. Approve this file in Grimmory, or pick another `library`.'
        });
    }
    const title = typeof file.original.title === 'string' && file.original.title !== '' ? file.original.title : id;
    return {
        target: `${adapter.id}:bookdrop/${id}`,
        summary: `Import Bookdrop file ${file.label} into ${chosen.label}.`,
        effects: [
            `Moves the file into ${chosen.label} as a new book and takes it off the Bookdrop.`,
            file.shown.length === 0 ? 'Uses the metadata in the file itself.' : `Uses the metadata in the file itself: ${file.shown.join(', ')}.`,
            'Not the provider match Grimmory fetched, which may be another edition. fix_metadata can change it afterwards.'
        ],
        args: {
            service,
            action: 'bookdrop',
            fileId: id,
            libraryId: chosen.id,
            pathId: chosen.pathIds[0]!,
            metadata: file.original,
            title,
            ...(instance === undefined ? {} : { instance })
        }
    };
}

async function applyBookScan(adapter: ServiceAdapter & BookLibraryScanCapable, plan: WritePlan): Promise<string> {
    if (plan.args?.action === 'bookdrop' && typeof plan.args.fileId === 'string') {
        const a = plan.args as { fileId: string; libraryId: string; pathId: string; metadata: Record<string, unknown>; title: string };
        const { bookId } = await adapter.finalizeBookdropFile(a);
        return bookId === undefined
            ? `${adapter.id} imported Bookdrop file ${a.fileId}. Its new book id could not be told apart; search_media finds it by title.`
            : `${adapter.id} imported Bookdrop file ${a.fileId} as book ${bookId} (grimmory:${bookId}).`;
    }
    if (plan.args?.action === 'bookdrop') {
        await adapter.rescanBookdrop();
        return `${adapter.id} is rescanning its Bookdrop folder. It runs in the background: new files show under the Bookdrop in Grimmory, and stack_health reports any left waiting.`;
    }

    const ids = (plan.args?.libraryIds as string[] | undefined) ?? [];
    for (const id of ids) await adapter.refreshBookLibrary(id);

    return `${adapter.id} is rescanning ${ids.length === 1 ? '1 library' : `${ids.length} libraries`}. It runs in the background: check get_library in a few minutes rather than expecting the books to be there now.`;
}

const TriggerScanInput = z.object({
    service: serviceOf(['radarr', 'sonarr', 'whisparr', 'lidarr', 'jellyfin', 'plex', 'grimmory', 'prowlarr', 'nzbget']).describe(
        'prowlarr syncs its indexers to the apps; nzbget only with action: "postprocess".'
    ),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    action: z
        .enum(['scan', 'rename', 'import', 'remap', 'postprocess', 'bookdrop'])
        .default('scan')
        .describe(
            'scan rescans the library, or just one item when `id` is given (on Lidarr only the refresh narrows to one artist: the rescan still reads every root folder); on Radarr, Sonarr, Whisparr and Lidarr it refreshes metadata from the provider first. rename renames one item\'s files to the service\'s own naming scheme, and requires `id`. import takes a finished download the service never picked up, and requires `download_id`; add `mapping` when the service cannot tell what a file is. remap reassigns already-imported Sonarr files to the episodes a person has confirmed they are, and requires `id` and `reassignments`. postprocess reruns NZBGet\'s post-processing on a finished download, and requires `download_id`. bookdrop rescans Grimmory\'s Bookdrop folder for new files, or with `id` imports that one file.'
        ),
    id: z
        .string()
        .min(1)
        .optional()
        .describe(
            'One movie, series or Lidarr artist id — `acquisition.id` on a get_library record. Omit with action: "scan" to scan the whole library. With action: "bookdrop", a Grimmory Bookdrop file id from get_queue: imports that file.'
        ),
    library: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Grimmory only: one library, by name or by id as stack_health and get_library show it. Omit to rescan every library.'
        ),
    download_id: z
        .string()
        .min(1)
        .optional()
        .describe(
            'The download client\'s own id, as `downloadId` on a get_queue row (or, for nzbget, on a get_history row). Required for action: "import" and action: "postprocess", ignored otherwise.'
        ),
    reassignments: z
        .array(
            z.object({
                path: z
                    .string()
                    .min(1)
                    .describe('The file, relative to the series folder as Sonarr names it ("Season 01/Show - S01E01 - Pilot.mkv"), or absolute.'),
                season: z.number().int().min(0),
                episode: z.number().int().min(1).describe('The episode this file really is.')
            })
        )
        .min(1)
        .optional()
        .describe(
            'Required for action: "remap", ignored otherwise. Include every file the change touches: a file moved onto an episode that already has one must say where that one goes too, or the call is refused.'
        ),
    mapping: z
        .array(
            z.object({
                path: z
                    .string()
                    .min(1)
                    .describe('A file in the download, as the import preview names it, or absolute.'),
                movie_id: IdSchema.optional().describe('Radarr: the movie this file is, `acquisition.id` on get_library.'),
                series_id: IdSchema.optional().describe('Sonarr: the series, `acquisition.id` on get_library.'),
                season: z.number().int().min(0).optional().describe('Sonarr: the season the episodes are in.'),
                episodes: z
                    .array(z.number().int().min(1))
                    .min(1)
                    .optional()
                    .describe('Sonarr: the episode numbers in this file, more than one for a multi-episode file.')
            })
        )
        .min(1)
        .optional()
        .describe(
            'For action: "import", ignored otherwise. What each named file really is, for a download the service matched wrongly or not at all. The service judges each mapped file again with that answer and imports it only if it then accepts it; files left out keep the service\'s own match.'
        )
});

export function registerTriggerScan(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'trigger_scan',
        title: 'Refresh and scan a library',
        description:
            'Asks a service to reconcile itself with what is on disk: the "it downloaded but will not play" fix, and the usual fix for a stale scan diagnose reports. No `id` rescans the whole library of Radarr, Sonarr, Whisparr, Lidarr, Jellyfin, Plex or Grimmory; on Prowlarr it pushes the indexer list to the apps. An `id` refreshes and rescans one item. On Jellyfin and Plex a scan only finds changed files; wrong metadata is fix_metadata. `action`: `rename` (files to the service\'s naming, needs `id`), `import` (a finished download stuck at importBlocked, with `mapping` to correct a wrong match; not on Lidarr), `remap` (which episode an imported Sonarr file really is), `postprocess` (rerun NZBGet post-processing by `downloadId`), `bookdrop` (Grimmory). [[sonarr: For an import refused over a "TBA" episode title, scan the series, wait, then import again.]] Most actions queue and return; follow them in stack_health `commands`. Previews first; confirm to run. Field reference: arr://docs/trigger_scan.',
        inputSchema: TriggerScanInput,
        // Resolved from the arguments, so the permission checked, the audit row
        // written and the token issued all name the same instance. Only the
        // instance is resolved here — which capability the call needs depends
        // on `action` and `id`, and `plan` is where that is decided.
        service: ({ service, instance }) => resolveInstance(adapters, service, instance).id,
        operation: 'trigger_scan',
        tier: 'safe',

        async plan({ service, instance, action, id, library, download_id, reassignments, mapping }): Promise<WritePlan> {
            const resolved = resolveInstance(adapters, service, instance);
            if (hasBookLibraryScan(resolved)) {
                return planBookScan(resolved, { service, instance, action, id, library });
            }
            refuseGrimmoryOnly(service, library, action);

            if (action === 'remap') {
                if (id === undefined || reassignments === undefined) {
                    throw new Error(
                        'remap needs an `id` — the Sonarr series, from `acquisition.id` on get_library — and `reassignments`, the files and the episodes they really are.'
                    );
                }

                const adapter = findRemapAdapter(adapters, service, instance);
                const { moves, emptied, rotation, chain } = await adapter.planEpisodeRemap(id, reassignments);
                const target = `${adapter.id}:${id}`;

                if (moves.length === 0) {
                    return {
                        target,
                        summary: `Every file is already on the episode asked for in ${adapter.id}.`,
                        effects: [],
                        noop: true
                    };
                }

                return {
                    target,
                    summary: `Reassign ${moves.length} file(s) to different episodes of series ${id} in ${adapter.id}.`,
                    effects: [
                        ...emptied.map(e => `Leaves ${e} with no file — nothing in reassignments takes its place.`),
                        ...moves.map(m => `${m.display}: ${m.from} → ${m.to}`),
                        // Scoped to the moved files, not the series: `rename`
                        // sends RenameSeries, which would also rename files in
                        // seasons this never touched.
                        rotation
                            ? `Renames only the files above afterwards — but they rotate, so every new name is another one's current name and no rename has a free destination. Getting through that **changes ${adapter.id}'s episode naming format for this series type, server-wide, for the length of two rename commands**, then puts it back. It is refused rather than started if ${adapter.id} is busy, and anything ${adapter.id} imports during those two commands is named by the temporary format and reported back to you.`
                            : chain
                              ? `Renames only the files above afterwards, but some want a name another moved file still holds, so on this pass they keep their old names. Running trigger_scan with action "rename" on this series afterwards finishes them, once per link in the chain.`
                              : `Renames only the files above afterwards, so the filenames match the episodes they have been moved to. Nothing else in the series is renamed. What ${adapter.id} will name each file is only known once the reassignment is applied, so this cannot promise the naming format stays put: if every name a moved file wants is already taken by some other file in the series, the series type's episode naming format is changed server-wide for two rename commands, then restored.`,
                        'Nothing moves between folders and nothing is deleted. Rescan your media server afterwards so it reads the corrected library.',
                        `${adapter.id} recreates each moved file's record, so episode file ids change — any id read before this is stale — and the file's date added resets to now.`,
                        `${adapter.id} records nothing in its own history for this; the audit log here is the only trace.`
                    ],
                    args: { service, action, id, reassignments, ...(instance === undefined ? {} : { instance }) }
                };
            }

            if (action === 'postprocess') {
                if (download_id === undefined) {
                    throw new Error(
                        'postprocess needs a `download_id`: the `downloadId` on the stuck get_queue row, or on the nzbget row in get_history.'
                    );
                }

                const adapter = findPostProcessAdapter(adapters, service, instance);
                const target = await adapter.findPostProcessTarget(download_id);
                const where =
                    target.folder === undefined
                        ? `in its download folder, which ${adapter.id} does not name`
                        : `in ${target.folder}`;

                return {
                    // The history item itself, not the id that found it: the
                    // same drone id can name a newer item by the time this is
                    // confirmed, and the token must not carry over to it.
                    target: `${adapter.id}:history/${target.historyId}`,
                    summary: `Run post-processing again on ${target.title} in ${adapter.id}.`,
                    effects: [
                        `Reruns ${adapter.id}'s post-processing on ${target.title} (now ${target.status}), ${where}: repair and unpack as ${adapter.id} is configured, then ${
                            target.scripts.length === 0
                                ? 'no scripts, because none are enabled for this download'
                                : `the scripts enabled for it: ${target.scripts.join(', ')}`
                        }. These are the same steps ${adapter.id} ran when the download first finished.`,
                        'Scripts can unpack, rename or delete files in that folder.',
                        `It needs that folder to still exist. If it has been moved or deleted, ${adapter.id} refuses, and this reports the refusal rather than success.`,
                        ...(target.finalFolder === undefined
                            ? []
                            : [`The finished files were moved on to ${target.finalFolder}; post-processing does not run there.`]),
                        'Radarr, Sonarr or Lidarr still has to import the result: on its next queue check, or straight away with action "import" on it.'
                    ],
                    args: {
                        service,
                        action,
                        downloadId: download_id,
                        historyId: target.historyId,
                        ...(target.historyTime === undefined ? {} : { historyTime: target.historyTime }),
                        ...(target.folder === undefined ? {} : { folder: target.folder }),
                        scripts: target.scripts,
                        ...(instance === undefined ? {} : { instance })
                    }
                };
            }

            if (action === 'import') {
                if (download_id === undefined) {
                    throw new Error(
                        'import needs a `download_id`: it imports one finished download, and the id comes from `downloadId` on a get_queue row.'
                    );
                }

                const adapter = findImportAdapter(adapters, service, instance);
                const candidates = await adapter.listImportCandidates(download_id, toImportMapping(mapping));
                const target = `${adapter.id}:${download_id}`;

                if (candidates.length === 0) {
                    return {
                        target,
                        summary: `${adapter.id} sees no files to import for download ${download_id}.`,
                        effects: [],
                        noop: true
                    };
                }

                const importable = candidates.filter(c => c.rejections.length === 0 && c.matchedId !== undefined);
                const rejected = candidates.filter(c => c.rejections.length > 0 || c.matchedId === undefined);

                // Every file rejected is a refusal, not a no-op: there *is*
                // something there, and it cannot be taken. Saying "nothing to
                // do" would read as "the download was already imported".
                if (importable.length === 0) {
                    throw new ServiceError(
                        'UpstreamError',
                        service,
                        `${adapter.id} will not import any of the ${candidates.length} file(s) in download ${download_id}`,
                        {
                            remedy: `It rejected: ${rejected
                                .map(c => `${c.display} (${c.rejections.join(', ') || 'matched nothing'})`)
                                .join('; ')}. Fix that in ${adapter.id} — this does not force a file the service refused.`
                        }
                    );
                }

                return {
                    target,
                    summary: `Import ${importable.length} file(s) from download ${download_id} into ${adapter.id}.`,
                    effects: [
                        ...importable.map(
                            c =>
                                `Imports ${c.display}${c.matchedTitle === undefined ? '' : ` as ${c.matchedTitle}`}${
                                    c.episodeLabels === undefined ? '' : ` ${c.episodeLabels.join(', ')}`
                                }${c.mapped === true ? ' (your mapping)' : ''} — the file is moved or hardlinked out of the download folder by ${adapter.id}.`
                        ),
                        ...rejected.map(
                            c => `Skips ${c.display}: ${c.rejections.join(', ') || 'the service matched it to nothing'}.`
                        )
                    ],
                    args: {
                        service,
                        action,
                        downloadId: download_id,
                        paths: importable.map(c => c.path).sort(),
                        ...(mapping === undefined ? {} : { mapping }),
                        ...(instance === undefined ? {} : { instance })
                    }
                };
            }

            if (action === 'rename' && id === undefined) {
                throw new Error(
                    'rename needs an `id`: it renames one item\'s files, and there is no "rename the whole library" here. Take the id from `acquisition.id` on a get_library record.'
                );
            }

            if (id !== undefined) {
                const adapter = findItemAdapter(adapters, service, instance);
                // Read first, so the preview names a title rather than a
                // number and a wrong id fails here rather than as a queued
                // command that runs against nothing.
                const details = hasMediaDetails(adapter)
                    ? await adapter.getMediaDetails(id, { includeEpisodes: false, episodeLimit: 1 })
                    : undefined;
                const label =
                    details === undefined
                        ? `${service} item ${id}`
                        : titled(details.title, details.year);

                // Lidarr's rescan after a one-artist refresh still reads every
                // root folder (`RefreshArtistService.RescanArtists` narrows it
                // only for a new artist), so "its folder" would be false there.
                const lidarr = adapter.type === 'lidarr';
                const rescanned = lidarr ? 'every root folder' : 'its folder';
                const rescanEffect = lidarr
                    ? "Then rescans every root folder for files added or moved since the last scan, as a whole-library scan does, unless Lidarr is set never to rescan after a refresh. Only this artist's metadata is re-read."
                    : 'Then rescans its folder for files added or moved since the last scan, unless the service is set never to rescan after a refresh. The rest of the library is not touched.';

                return {
                    target: `${adapter.id}:${id}`,
                    summary:
                        action === 'rename'
                            ? `Rename the files of ${label} in ${adapter.id}.`
                            : `Ask ${adapter.id} to refresh ${label} and rescan ${rescanned}.`,
                    effects:
                        action === 'rename'
                            ? [
                                  `Renames the files of ${label} on disk to ${adapter.id}'s own naming scheme. Nothing is deleted, and renaming again with a different scheme puts them back.`,
                                  'A media server that indexed the old paths will need its own rescan afterwards.'
                              ]
                            : [
                                  `Re-reads ${label}'s metadata from the provider, such as titles and air dates.`,
                                  rescanEffect
                              ],
                    args: { service, action, id, ...(instance === undefined ? {} : { instance }) }
                };
            }

            const adapter = findAdapter(adapters, service, instance);

            if (adapter.type === 'prowlarr') {
                return {
                    target: adapter.id,
                    summary: `Ask ${adapter.id} to sync its indexers to the apps connected to it.`,
                    effects: [
                        `Queues an indexer sync on ${adapter.id}, which pushes its indexer list to apps such as Radarr and Sonarr.`,
                        'Scans nothing: Prowlarr has no library.',
                        'Runs in the background.'
                    ],
                    args: { service, ...(instance === undefined ? {} : { instance }) }
                };
            }

            return {
                target: adapter.id,
                summary: `Ask ${adapter.id} to rescan its library.`,
                effects: [
                    adapter.type === 'plex'
                        ? 'Queues a scan of every library section on plex, music and photos included: Plex has no single-library scan here.'
                        : `Queues a library scan on ${adapter.id}.`,
                    ...(hasLibraryMaintenance(adapter)
                        ? ['Re-reads the metadata of every item from the provider, such as titles and air dates.']
                        : []),
                    'Finds media added or moved on disk since the last scan.',
                    'Can take minutes on a large library, and runs in the background.'
                ],
                args: { service, ...(instance === undefined ? {} : { instance }) }
            };
        },

        // Only a remap leaves a media server reading names that are no longer
        // right. Offered even when some filenames kept their old names: the
        // episodes the server shows are still the ones it has to relearn.
        followUps(_outcome, { action }): NextStep[] {
            if (action !== 'remap') return [];
            return scannableMediaServers(adapters).map(server => ({
                tool: 'trigger_scan',
                arguments: { ...instanceArgs(server.id), action: 'scan' },
                why: `Rescans ${server.id} so it picks up the corrected episodes and names.`
            }));
        },

        applied: outcomeText,

        async apply(plan, { service, instance, action, id, download_id, reassignments, mapping }) {
            const resolved = resolveInstance(adapters, service, instance);
            if (hasBookLibraryScan(resolved)) return applyBookScan(resolved, plan);

            if (action === 'remap' && id !== undefined && reassignments !== undefined) {
                const remapper = findRemapAdapter(adapters, service, instance);
                const { renamed, blocked, caughtInWindow } = await remapper.runEpisodeRemap(id, reassignments);

                // Unlike everything else here, this one has already finished:
                // the rename needs the ids the reassignment assigns, so it
                // waits for the first command before sending the second.
                const done = `${remapper.id} reassigned the files of series ${id} and renamed ${renamed} of them.`;
                const caught =
                    caughtInWindow === undefined || caughtInWindow.length === 0
                        ? ''
                        : ` ${caughtInWindow.length} file(s) were imported by ${remapper.id} while the temporary naming format was live, so they carry it in their names and need renaming back: ${caughtInWindow.join('; ')}.`;

                if (blocked.length === 0) {
                    // The rescan is a `next_steps` entry when there is a server to name it for.
                    const rescan = scannableMediaServers(adapters).length > 0 ? '' : ' — rescan your media server so it picks the new names up';
                    return `${done} The files and the episodes now agree${rescan}.${caught}`;
                }

                return (
                    `${done} ${blocked.length} kept the old name, because the name each one wants is still on disk, held by another file: ` +
                    `${blocked.map(b => `${b.path} wants ${b.wants}`).join('; ')}. ` +
                    `The reassignment is correct and complete either way — only those filenames are behind, and ${remapper.id} plays by the reassignment, not the name. ` +
                    `If the holder is a file this remap also moved, running trigger_scan with action "rename" and id ${id} again finishes it, once per link in the chain.${caught}`
                );
            }

            if (action === 'postprocess' && download_id !== undefined) {
                const processor = findPostProcessAdapter(adapters, service, instance);
                const outcome = await processor.runPostProcess(download_id, String(plan.args?.historyId));
                const { title } = outcome.target;
                if (outcome.state === 'running') {
                    return `${processor.id} is post-processing ${title} again, now ${outcome.status}. It keeps running in the background: get_queue shows it until it is back in history, and get_history then says how it finished. Radarr, Sonarr or Lidarr imports the result on its next queue check, or use action "import" on it then.`;
                }
                if (outcome.state === 'removed') {
                    return `${processor.id} ran post-processing again on ${title}, and it is no longer in ${processor.id}'s queue or history: Radarr, Sonarr or Lidarr usually imports a finished download and removes it from the client. Check get_queue and get_history on the *arr to see whether it was imported.`;
                }
                if (outcome.event === 'imported') {
                    return `${processor.id} ran post-processing again on ${title}, and it finished as ${outcome.status}. Radarr, Sonarr or Lidarr imports the result on its next queue check, or use action "import" on it now.`;
                }
                return `${processor.id} ran post-processing again on ${title}, and it finished as ${outcome.status}: it did not succeed this time either, so whatever broke it before still does. Nothing new is there to import. get_history has the stages that failed.`;
            }

            if (action === 'import' && download_id !== undefined) {
                const importer = findImportAdapter(adapters, service, instance);
                const queued = await importer.runManualImport(
                    download_id,
                    toImportMapping(mapping),
                    plan.args?.paths as string[] | undefined
                );
                return `${importer.id} queued ${queued.name} for download ${download_id}. Importing runs in the background — check get_queue and stack_health's \`commands\` rather than expecting it to be done now.`;
            }

            if (id !== undefined) {
                const item = findItemAdapter(adapters, service, instance);
                const queued = action === 'rename' ? await item.renameItem(id) : await item.refreshItem(id);
                return hasCommandStatus(item)
                    ? `${item.id} queued ${queued.name} for item ${id}. It runs in the background — stack_health's \`commands\` list says whether it has finished.`
                    : `${item.id} queued ${queued.name} for item ${id}. It runs in the background, and stack_health's \`commands\` list does not report ${item.id}, so its absence there says nothing.`;
            }

            const adapter = findAdapter(adapters, service, instance);
            const handle = await adapter.startLibraryScan();

            if (adapter.type === 'prowlarr') {
                return `${adapter.id} is syncing its indexers to the apps connected to it. It runs in the background — stack_health's \`commands\` list says whether it has finished.${
                    handle.commandId === 0 ? '' : ` Command id ${handle.commandId}.`
                }`;
            }

            return `${adapter.id} is ${hasLibraryMaintenance(adapter) ? 'refreshing and rescanning' : 'rescanning'} its library. It runs in the background — check get_media_details or stack_health in a few minutes rather than expecting it to be finished now.${
                handle.commandId === 0 ? '' : ` Command id ${handle.commandId}.`
            }${handle.detail === undefined ? '' : ` ${handle.detail}`}`;
        }
    });
}
