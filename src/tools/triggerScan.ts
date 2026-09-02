import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import {
    hasLibraryMaintenance,
    hasLibraryScan,
    hasManualImport,
    hasMediaDetails,
    type LibraryMaintenanceCapable,
    type LibraryScanCapable,
    type ManualImportCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

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
            remedy: 'Only radarr, sonarr and jellyfin manage a library. For "it downloaded but will not play", jellyfin is almost always the one you want.'
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
            remedy: 'Only radarr and sonarr manage individual items. For a media server, scan the whole library — omit `id`.'
        });
    }

    return adapter;
};

/** Importing a finished download is Radarr's and Sonarr's alone: a media
 *  server never had the file in a download folder to begin with. */
const findImportAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & ManualImportCapable => {
    const adapter = resolveInstance(adapters, service, instance);

    if (!hasManualImport(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot import a download`, {
            remedy: 'Only radarr and sonarr import downloads. Pick the one that was supposed to manage the item.'
        });
    }

    return adapter;
};

export function registerTriggerScan(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'trigger_scan',
        title: 'Scan for new files',
        description:
            'Asks a service to reconcile itself with what is on disk — the "it downloaded but still will not play" family of actions, and the usual fix for what `diagnose` reports as a stale scan. With no `id`, it rescans the whole library of Radarr, Sonarr or Jellyfin; Jellyfin is the one that matters when something is missing from what you can actually watch. With an `id`, it rescans just that Radarr/Sonarr item, which is far cheaper on a big library. `action: "rename"` renames one item\'s files to the service\'s own naming scheme and needs an `id`. Everything here queues a command and returns immediately; `stack_health` lists what is still running under `commands`, so check there rather than assuming it is done. Previews by default — call again with the returned `confirm` token to actually run it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr, sonarr or jellyfin.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            action: z
                .enum(['scan', 'rename', 'import'])
                .default('scan')
                .describe(
                    'scan rescans the library, or just one item when `id` is given. rename renames one item\'s files to the service\'s own naming scheme, and requires `id`. import takes a finished download the service never picked up, and requires `download_id`.'
                ),
            id: z
                .string()
                .min(1)
                .optional()
                .describe(
                    'One movie or series id — `acquisition.id` on a get_library record. Omit with action: "scan" to rescan the whole library.'
                ),
            download_id: z
                .string()
                .min(1)
                .optional()
                .describe(
                    'The download client\'s own id, as `downloadId` on a get_queue row. Required for action: "import", ignored otherwise.'
                )
        }),
        // Resolved from the arguments, so the permission checked, the audit row
        // written and the token issued all name the same instance. Only the
        // instance is resolved here — which capability the call needs depends
        // on `action` and `id`, and `plan` is where that is decided.
        service: ({ service, instance }) => resolveInstance(adapters, service, instance).id,
        operation: 'trigger_scan',
        tier: 'safe',

        async plan({ service, instance, action, id, download_id }): Promise<WritePlan> {
            if (action === 'import') {
                if (download_id === undefined) {
                    throw new Error(
                        'import needs a `download_id`: it imports one finished download, and the id comes from `downloadId` on a get_queue row.'
                    );
                }

                const adapter = findImportAdapter(adapters, service, instance);
                const candidates = await adapter.listImportCandidates(download_id);
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
                                `Imports ${c.display}${c.matchedTitle === undefined ? '' : ` as ${c.matchedTitle}`} — the file is moved or hardlinked out of the download folder by ${adapter.id}.`
                        ),
                        ...rejected.map(
                            c => `Skips ${c.display}: ${c.rejections.join(', ') || 'the service matched it to nothing'}.`
                        )
                    ],
                    args: { service, action, downloadId: download_id, ...(instance === undefined ? {} : { instance }) }
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
                        : `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;

                return {
                    target: `${adapter.id}:${id}`,
                    summary:
                        action === 'rename'
                            ? `Rename the files of ${label} in ${adapter.id}.`
                            : `Ask ${adapter.id} to re-read ${label} from disk.`,
                    effects:
                        action === 'rename'
                            ? [
                                  `Renames the files of ${label} on disk to ${adapter.id}'s own naming scheme. Nothing is deleted, and renaming again with a different scheme puts them back.`,
                                  'A media server that indexed the old paths will need its own rescan afterwards.'
                              ]
                            : [
                                  `Rescans ${label}'s folder and re-reads its metadata.`,
                                  'Finds files added or moved on disk since the last scan, without touching the rest of the library.'
                              ],
                    args: { service, action, id, ...(instance === undefined ? {} : { instance }) }
                };
            }

            const adapter = findAdapter(adapters, service, instance);

            return {
                target: adapter.id,
                summary: `Ask ${adapter.id} to rescan its library.`,
                effects: [
                    `Queues a library scan on ${adapter.id}.`,
                    'Finds media added or moved on disk since the last scan.',
                    'Can take minutes on a large library, and runs in the background.'
                ],
                args: { service, ...(instance === undefined ? {} : { instance }) }
            };
        },

        async apply(_plan, { service, instance, action, id, download_id }) {
            if (action === 'import' && download_id !== undefined) {
                const importer = findImportAdapter(adapters, service, instance);
                const queued = await importer.runManualImport(download_id);
                return `${importer.id} queued ${queued.name} for download ${download_id}. Importing runs in the background — check get_queue and stack_health's \`commands\` rather than expecting it to be done now.`;
            }

            if (id !== undefined) {
                const item = findItemAdapter(adapters, service, instance);
                const queued = action === 'rename' ? await item.renameItem(id) : await item.refreshItem(id);
                return `${item.id} queued ${queued.name} for item ${id}. It runs in the background — stack_health's \`commands\` list says whether it has finished.`;
            }

            const adapter = findAdapter(adapters, service, instance);
            const handle = await adapter.startLibraryScan();

            return `${adapter.id} is rescanning its library. It runs in the background — check get_media_details or stack_health in a few minutes rather than expecting it to be finished now.${
                handle.commandId === 0 ? '' : ` Command id ${handle.commandId}.`
            }`;
        }
    });
}
