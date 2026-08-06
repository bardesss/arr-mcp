import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasMediaDelete, hasMediaDetails, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The first destructive-tier write. Everything the harness does matters more
 * here than it did for `trigger_search`: this is the tool where a preview the
 * user did not read is a film they cannot get back.
 *
 * Which is why `plan` reads the item first and reports the size on disk. "Delete
 * radarr:412" is not something anyone can meaningfully approve; "Delete Alien
 * (1979) from Radarr, deleting 24.1 GB from disk" is.
 */

const GIB = 1024 ** 3;

/** Deliberately coarse. This number exists to make someone hesitate, not to
 *  balance a ledger, and false precision reads as machine noise. */
function humanSize(bytes: number | undefined): string | undefined {
    if (bytes === undefined || bytes <= 0) return undefined;
    return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId) => {
    const adapter = adapters.find(a => a.id === service);
    if (adapter === undefined) {
        throw new ServiceError('NotFound', service, `${service} is not configured`, {
            remedy: `Add a services.${service} block to config.yaml and restart, or name a configured service.`
        });
    }
    if (!hasMediaDelete(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no media to delete`, {
            remedy: 'Only radarr and sonarr manage media that delete_media can remove.'
        });
    }
    return adapter;
};

export function registerDeleteMedia(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'delete_media',
        description:
            'Removes a film from Radarr or a whole series from Sonarr, optionally deleting its files from disk. Destructive and not undoable — files are gone, not moved to a recycle bin unless the service itself is configured for one. Takes `service` and `id`, never a title: get those from get_media_details or get_library first. Sonarr deletes the entire series; there is no per-episode form. Previews by default — call again with the returned `confirm` token to actually delete.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr or sonarr.'),
            id: z.string().min(1).describe("The item's id within that service, as an integer string."),
            delete_files: z
                .boolean()
                .default(false)
                .describe(
                    'Also delete the files from disk. Defaults to false, which removes only the entry and leaves the media where it is.'
                ),
            add_import_exclusion: z
                .boolean()
                .default(false)
                .describe(
                    'Also add an import exclusion so it is never re-added automatically. Defaults to false.'
                )
        }),
        service: ({ service }) => service,
        operation: 'delete_media',
        tier: 'destructive',

        async plan({ service, id, delete_files, add_import_exclusion }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service);
            if (!hasMediaDetails(adapter)) {
                throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
            }

            // The read that makes the preview approvable, and that fails
            // legibly on a bad id rather than issuing a DELETE into the dark.
            const details = await adapter.getMediaDetails(id, { includeEpisodes: false, episodeLimit: 0 });
            const label = `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;
            const noun = service === 'sonarr' ? 'series' : 'film';

            const effects: string[] = [];
            const size = humanSize(details.sizeBytes);

            if (delete_files) {
                effects.push(
                    size === undefined
                        ? `Deletes this ${noun}'s files from disk. This cannot be undone.`
                        : `Deletes ${size} from disk. This cannot be undone.`
                );
                if (service === 'sonarr') {
                    effects.push('Deletes every episode of the series, not one season or one episode.');
                }
            } else {
                effects.push(`Leaves the files on disk — only the ${service} entry is removed.`);
            }

            effects.push(`Removes ${label} from ${service}, along with its monitoring and history.`);

            if (add_import_exclusion) {
                effects.push('Adds an import exclusion, so it will not be re-added automatically by a list or request.');
            }

            return {
                target: `${service}:${id}`,
                summary:
                    `Delete ${label} from ${service}` +
                    (delete_files
                        ? `, deleting ${size ?? 'its files'} from disk.`
                        : ', leaving its files on disk.'),
                effects,
                // Both flags are effect-bearing, so the confirmation token
                // commits to them: a token previewed for a database-only
                // removal must not be usable to also wipe the disk.
                args: { service, id, deleteFiles: delete_files, addImportExclusion: add_import_exclusion }
            };
        },

        async apply(_plan, { service, id, delete_files, add_import_exclusion }) {
            await findAdapter(adapters, service).deleteMedia(id, {
                deleteFiles: delete_files,
                addImportExclusion: add_import_exclusion
            });
            return { deleted: `${service}:${id}` };
        }
    });
}
