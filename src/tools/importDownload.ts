import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ServiceId, serviceOf } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { NextStep } from '../core/nextStep.ts';
import {
    hasBookLibraryScan,
    hasEpisodeRemap,
    hasLibraryScan,
    hasManualImport,
    hasPostProcess,
    hasUserLibrary,
    type BookLibraryScanCapable,
    type EpisodeRemapCapable,
    type ImportMapping,
    type ManualImportCapable,
    type PostProcessCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { libraryList, resolveBookLibrary } from './bookLibraries.ts';
import { INSTANCE_PARAM_DESCRIPTION, instanceArgs, resolveInstance } from './resolveInstance.ts';
import { outcomeText, registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Getting a finished download into a library, or a file onto the right
 * episode. These were `trigger_scan`'s `import`, `postprocess`, `remap` and
 * (Grimmory) `bookdrop` actions; they live here because none of them scans
 * anything and each works on only a few services.
 *
 * **Safe, not destructive.** An import moves or hardlinks a file the service
 * already refused to take on its own, and a remap only reassigns files the
 * service already holds. `trigger_scan` still accepts the old actions and runs
 * them through `planImportAction` and `applyImportAction`, so both tools show
 * the same preview.
 */

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
            remedy: 'postprocess is for nzbget: it reruns NZBGet\'s post-processing on a finished download. For a download Radarr, Sonarr or Lidarr never took, import_download on that *arr (action "import") does.'
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

type Reassignment = { path: string; season: number; episode: number };

type ImportArgs = {
    service: ServiceId;
    instance?: string | undefined;
    action: 'import' | 'postprocess' | 'remap';
    download_id?: string | undefined;
    mapping?: MappingInput[] | undefined;
    id?: string | undefined;
    reassignments?: Reassignment[] | undefined;
    library?: string | undefined;
};

const toImportMapping = (mapping: MappingInput[] | undefined): ImportMapping[] | undefined =>
    mapping?.map(m => ({
        path: m.path,
        ...(m.movie_id === undefined ? {} : { movieId: Number(m.movie_id) }),
        ...(m.series_id === undefined ? {} : { seriesId: Number(m.series_id) }),
        ...(m.season === undefined ? {} : { season: m.season }),
        ...(m.episodes === undefined ? {} : { episodes: m.episodes })
    }));

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
            remedy: 'Rescan the Bookdrop (trigger_scan with action "bookdrop", no `id`) and try again once Grimmory has read the file.'
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
            action: 'import',
            fileId: id,
            libraryId: chosen.id,
            pathId: chosen.pathIds[0]!,
            metadata: file.original,
            title,
            ...(instance === undefined ? {} : { instance })
        }
    };
}

async function applyBookdropImport(adapter: ServiceAdapter & BookLibraryScanCapable, plan: WritePlan): Promise<string> {
    const a = plan.args as { fileId: string; libraryId: string; pathId: string; metadata: Record<string, unknown>; title: string };
    const { bookId } = await adapter.finalizeBookdropFile(a);
    return bookId === undefined
        ? `${adapter.id} imported Bookdrop file ${a.fileId}. Its new book id could not be told apart; search_media finds it by title.`
        : `${adapter.id} imported Bookdrop file ${a.fileId} as book ${bookId} (grimmory:${bookId}).`;
}

export async function planImportAction(adapters: readonly ServiceAdapter[], args: ImportArgs): Promise<WritePlan> {
    const { service, instance, action, id, library, download_id, reassignments, mapping } = args;
    const resolved = resolveInstance(adapters, service, instance);

    if (hasBookLibraryScan(resolved)) {
        if (action !== 'import') {
            throw new ServiceError('NotFound', service, `${service} cannot ${action}`, {
                remedy: 'On grimmory import_download imports one Bookdrop file: action "import" with its `id` from get_queue.'
            });
        }
        if (id === undefined) {
            throw new Error('Importing on grimmory needs `id`: a Bookdrop file from get_queue. To rescan the Bookdrop, use trigger_scan with action "bookdrop".');
        }
        return planBookdropImport(resolved, { service, instance, id, library });
    }
    if (library !== undefined) {
        throw new ServiceError('NotFound', service, `${service} has no library to pick by name`, {
            remedy: '`library` is for grimmory, where a Bookdrop file is imported into a library by name. Other services import into the library that manages the item.'
        });
    }

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
                'Radarr, Sonarr or Lidarr still has to import the result: on its next queue check, or straight away with import_download on it.'
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
            ...rejected.map(c => `Skips ${c.display}: ${c.rejections.join(', ') || 'the service matched it to nothing'}.`)
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

export async function applyImportAction(adapters: readonly ServiceAdapter[], plan: WritePlan, args: ImportArgs): Promise<string> {
    const { service, instance, action, id, download_id, reassignments, mapping } = args;
    const resolved = resolveInstance(adapters, service, instance);
    if (hasBookLibraryScan(resolved)) return applyBookdropImport(resolved, plan);

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
            return `${processor.id} is post-processing ${title} again, now ${outcome.status}. It keeps running in the background: get_queue shows it until it is back in history, and get_history then says how it finished. Radarr, Sonarr or Lidarr imports the result on its next queue check, or use import_download on it then.`;
        }
        if (outcome.state === 'removed') {
            return `${processor.id} ran post-processing again on ${title}, and it is no longer in ${processor.id}'s queue or history: Radarr, Sonarr or Lidarr usually imports a finished download and removes it from the client. Check get_queue and get_history on the *arr to see whether it was imported.`;
        }
        if (outcome.event === 'imported') {
            return `${processor.id} ran post-processing again on ${title}, and it finished as ${outcome.status}. Radarr, Sonarr or Lidarr imports the result on its next queue check, or use import_download on it now.`;
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
        return `${importer.id} queued ${queued.name} for download ${download_id}. Importing runs in the background — check get_queue and get_stack_health's \`commands\` rather than expecting it to be done now.`;
    }

    throw new Error(`${action} is missing what it needs: preview it again.`);
}

/** Only a remap leaves a media server reading names that are no longer
 *  right. Offered even when some filenames kept their old names: the
 *  episodes the server shows are still the ones it has to relearn. */
export function importFollowUps(adapters: readonly ServiceAdapter[], args: Pick<ImportArgs, 'action'>): NextStep[] {
    if (args.action !== 'remap') return [];
    return scannableMediaServers(adapters).map(server => ({
        tool: 'trigger_scan',
        arguments: { ...instanceArgs(server.id), action: 'scan' },
        why: `Rescans ${server.id} so it picks up the corrected episodes and names.`
    }));
}

/** The remap and import fields. `trigger_scan` accepts them loosely, as deprecated, and checks them against these. */
export const reassignmentsField = z
    .array(
        z.object({
            path: z
                .string()
                .min(1)
                .describe('The file, relative to the series folder ("Season 01/Show - S01E01 - Pilot.mkv"), or absolute.'),
            season: z.number().int().min(0),
            episode: z.number().int().min(1).describe('The episode this file really is.')
        })
    )
    .min(1)
    .optional();

export const mappingField = z
    .array(
        z.object({
            path: z.string().min(1).describe('A file in the download, as the import preview names it, or absolute.'),
            movie_id: IdSchema.optional().describe('[[radarr: Radarr: the movie this file is, `acquisition.id` on get_library.]]'),
            series_id: IdSchema.optional().describe('[[sonarr: Sonarr: the series, `acquisition.id` on get_library.]]'),
            season: z.number().int().min(0).optional().describe('[[sonarr: Sonarr: the season the episodes are in.]]'),
            episodes: z
                .array(z.number().int().min(1))
                .min(1)
                .optional()
                .describe('[[sonarr: Sonarr: the episode numbers in this file, more than one for a multi-episode file.]]')
        })
    )
    .min(1)
    .optional();

const ImportDownloadInput = z.object({
    service: serviceOf(['radarr', 'sonarr', 'lidarr', 'nzbget', 'grimmory']),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    action: z
        .enum(['import', 'postprocess', 'remap'])
        .default('import')
        .describe(
            "import (default): a finished download, by `download_id`. [[nzbget: postprocess (NZBGet): reruns its post-processing, by `download_id`.]] [[sonarr: remap (Sonarr): moves imported files to the episodes they really are, with `id` and `reassignments`.]]"
        ),
    download_id: z
        .string()
        .min(1)
        .optional()
        .describe(
            "`downloadId` on the get_queue row (nzbget: or its get_history row)."
        ),
    id: z
        .string()
        .min(1)
        .optional()
        .describe(
            '[[sonarr: For remap, the Sonarr series: `acquisition.id` on a get_library record.]] [[grimmory: On grimmory, the Bookdrop file to import, from get_queue.]]'
        ),
    library: z
        .string()
        .min(1)
        .optional()
        .describe('[[grimmory: Grimmory only: the library to import the Bookdrop file into, by name or id. Omit when there is one.]]'),
    reassignments: reassignmentsField.describe(
        'Include every file the change touches: a file moved onto an episode that already has one must say where that one goes too, or the call is refused.'
    ),
    mapping: mappingField.describe(
        "What each file really is. The service judges each mapped file again and imports it only if it then accepts it; unmapped files keep its own match."
    )
});

export function registerImportDownload(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'import_download',
        title: 'Import a finished download',
        description:
            'Gets a finished download into the library when the *arr never took it: one stuck at `importBlocked` in get_queue, by its `download_id`; `mapping` fixes a wrong match[[lidarr:  (not on Lidarr)]]. Previews the files it will import and skip, and never forces one the service refuses. [[nzbget: `postprocess` first reruns NZBGet\'s post-processing, for a download a broken script left unimportable.]] [[sonarr: `remap` says which episode an imported file really is.]] [[grimmory: On Grimmory, `id` is a Bookdrop file from get_queue.]] Rescan or rename: trigger_scan. An import queues and returns (get_stack_health `commands`). Previews first; confirm to run. Field reference: arr://docs/import_download.',
        inputSchema: ImportDownloadInput,
        // Resolved from the arguments, so the permission checked, the audit row
        // written and the token issued all name the same instance.
        service: ({ service, instance }) => resolveInstance(adapters, service, instance).id,
        operation: 'import_download',
        tier: 'safe',

        plan: args => planImportAction(adapters, args),
        followUps: (_outcome, args) => importFollowUps(adapters, args),
        applied: outcomeText,
        apply: (plan, args) => applyImportAction(adapters, plan, args)
    });
}
