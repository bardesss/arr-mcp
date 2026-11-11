import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ServiceId, serviceOf } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { NextStep } from '../core/nextStep.ts';
import {
    hasCommandStatus,
    hasBookLibraryScan,
    hasLibraryMaintenance,
    hasLibraryScan,
    hasMediaDetails,
    type BookLibraryScanCapable,
    type LibraryMaintenanceCapable,
    type LibraryScanCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { resolveBookLibrary } from './bookLibraries.ts';
import { applyImportAction, importFollowUps, mappingField, planImportAction, reassignmentsField } from './importDownload.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { outcomeText, registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';

/**
 * The other half of the answer `diagnose_media` gives most often.
 *
 * `diagnose_media` names a stale library scan as the usual reason something that
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

/** `library` and `action: "bookdrop"` are Grimmory's; on any other service they are refused, not ignored. */
const refuseGrimmoryOnly = (service: ServiceId, library: string | undefined, action: string): void => {
    if (library === undefined && action !== 'bookdrop') return;
    throw new ServiceError('NotFound', service, `${service} has no ${library === undefined ? 'Bookdrop' : 'library to pick by name'}`, {
        remedy: '`library` and action "bookdrop" are for grimmory. Other services scan their whole library, or one item with `id`.'
    });
};

async function planBookScan(
    adapter: ServiceAdapter & BookLibraryScanCapable,
    args: { service: ServiceId; instance: string | undefined; action: string; id: string | undefined; library: string | undefined }
): Promise<WritePlan> {
    const { service, instance, action, id, library } = args;
    const bound = (libraryIds: string[]) => ({ service, action, libraryIds, ...(instance === undefined ? {} : { instance }) });

    if (id !== undefined) {
        throw new ServiceError('NotFound', service, `${service} cannot scan one item by id`, {
            remedy: 'On grimmory `id` is a book. To rescan one library pass `library`, with its name or id. To approve a Bookdrop file, use import_download with service "grimmory" and its `id`.'
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

async function applyBookScan(adapter: ServiceAdapter & BookLibraryScanCapable, plan: WritePlan): Promise<string> {
    if (plan.args?.action === 'bookdrop') {
        await adapter.rescanBookdrop();
        return `${adapter.id} is rescanning its Bookdrop folder. It runs in the background: new files show under the Bookdrop in Grimmory, and get_stack_health reports any left waiting.`;
    }

    const ids = (plan.args?.libraryIds as string[] | undefined) ?? [];
    for (const id of ids) await adapter.refreshBookLibrary(id);

    return `${adapter.id} is rescanning ${ids.length === 1 ? '1 library' : `${ids.length} libraries`}. It runs in the background: check get_library in a few minutes rather than expecting the books to be there now.`;
}

/** The deprecated import fields, held to import_download's own schema. */
const importFields = (reassignments: unknown, mapping: unknown) => {
    const r = reassignmentsField.safeParse(reassignments);
    const m = mappingField.safeParse(mapping);
    if (!r.success || !m.success) {
        const bad = r.success ? 'mapping' : 'reassignments';
        const why = (r.success ? m.error : r.error)?.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`\`${bad}\` is not valid (${why}). import_download takes the same field and describes its shape.`);
    }
    return { reassignments: r.data, mapping: m.data };
};

const TriggerScanInput = z.object({
    service: serviceOf(['radarr', 'sonarr', 'whisparr', 'lidarr', 'jellyfin', 'plex', 'grimmory', 'prowlarr', 'nzbget']).describe(
        'prowlarr syncs its indexers to the apps. nzbget takes only the deprecated postprocess.'
    ),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    action: z
        .enum(['scan', 'rename', 'import', 'remap', 'postprocess', 'bookdrop'])
        .default('scan')
        .describe(
            "scan rescans the library, or just one item when `id` is given[[lidarr:  (on Lidarr only the refresh narrows to one artist: the rescan still reads every root folder)]]; on an *arr it refreshes metadata from the provider first. rename renames one item's files to the service's own naming scheme, and requires `id`. [[grimmory: bookdrop rescans Grimmory's Bookdrop folder for new files.]] Deprecated: use import_download for import, remap, postprocess, and bookdrop with `id`."
        ),
    id: z
        .string()
        .min(1)
        .optional()
        .describe(
            'One {{or: radarr=movie; sonarr|whisparr=series; lidarr=Lidarr artist; grimmory=book; jellyfin|plex=media-server item}} id — `acquisition.id` on a get_library record. Omit with action: "scan" to scan the whole library.'
        ),
    library: z
        .string()
        .min(1)
        .optional()
        .describe(
            '[[grimmory: Grimmory only: one library, by name or by id as get_stack_health and get_library show it. Omit to rescan every library.]]'
        ),
    download_id: z.string().min(1).optional().describe('Deprecated: use import_download.'),
    // Checked against import_download's own schema when the call is planned: a second copy of it here would cost every client its tokens.
    reassignments: z.array(z.looseObject({})).min(1).optional().describe('Deprecated: use import_download.'),
    mapping: z.array(z.looseObject({})).min(1).optional().describe('Deprecated: use import_download.')
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
            "Asks a service to reconcile itself with what is on disk: the \"it downloaded but will not play\" fix, and the usual fix for a stale scan diagnose_media reports. No `id` rescans the whole library[[prowlarr: ; on Prowlarr it pushes the indexer list to the apps]]. An `id` refreshes and rescans one item. [[jellyfin|plex: On {{and: jellyfin=Jellyfin; plex=Plex}} a scan only finds changed files; wrong metadata is fix_metadata.]] `action`: `rename` (files to the service's naming, needs `id`), [[grimmory: `bookdrop` (rescan Grimmory's Bookdrop).]] Importing a download: import_download. Most actions queue and return; follow them in get_stack_health `commands`. Previews first; confirm to run. Field reference: arr://docs/trigger_scan.",
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
                // Approving a Bookdrop file is an import: the same plan import_download shows.
                if (action === 'bookdrop' && id !== undefined) {
                    return planImportAction(adapters, { service, instance, action: 'import', id, library });
                }
                return planBookScan(resolved, { service, instance, action, id, library });
            }
            refuseGrimmoryOnly(service, library, action);

            if (action === 'import' || action === 'postprocess' || action === 'remap') {
                return planImportAction(adapters, { service, instance, action, id, download_id, ...importFields(reassignments, mapping) });
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

        followUps(_outcome, { action }): NextStep[] {
            return action === 'remap' ? importFollowUps(adapters, { action }) : [];
        },

        applied: outcomeText,

        async apply(plan, { service, instance, action, id, download_id, reassignments, mapping }) {
            const resolved = resolveInstance(adapters, service, instance);
            if (hasBookLibraryScan(resolved)) {
                if (typeof plan.args?.fileId === 'string') {
                    return applyImportAction(adapters, plan, { service, instance, action: 'import' });
                }
                return applyBookScan(resolved, plan);
            }

            if (action === 'import' || action === 'postprocess' || action === 'remap') {
                return applyImportAction(adapters, plan, { service, instance, action, id, download_id, ...importFields(reassignments, mapping) });
            }

            if (id !== undefined) {
                const item = findItemAdapter(adapters, service, instance);
                const queued = action === 'rename' ? await item.renameItem(id) : await item.refreshItem(id);
                return hasCommandStatus(item)
                    ? `${item.id} queued ${queued.name} for item ${id}. It runs in the background — get_stack_health's \`commands\` list says whether it has finished.`
                    : `${item.id} queued ${queued.name} for item ${id}. It runs in the background, and get_stack_health's \`commands\` list does not report ${item.id}, so its absence there says nothing.`;
            }

            const adapter = findAdapter(adapters, service, instance);
            const handle = await adapter.startLibraryScan();

            if (adapter.type === 'prowlarr') {
                return `${adapter.id} is syncing its indexers to the apps connected to it. It runs in the background — get_stack_health's \`commands\` list says whether it has finished.${
                    handle.commandId === 0 ? '' : ` Command id ${handle.commandId}.`
                }`;
            }

            return `${adapter.id} is ${hasLibraryMaintenance(adapter) ? 'refreshing and rescanning' : 'rescanning'} its library. It runs in the background — check get_media_details or get_stack_health in a few minutes rather than expecting it to be finished now.${
                handle.commandId === 0 ? '' : ` Command id ${handle.commandId}.`
            }${handle.detail === undefined ? '' : ` ${handle.detail}`}`;
        }
    });
}
