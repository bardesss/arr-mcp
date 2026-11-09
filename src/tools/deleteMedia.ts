import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { hasBookDelete, hasMediaDelete, hasMediaDetails, type BookDeleteCapable, type MediaDeleteCapable, type ServiceAdapter } from '../services/types.ts';
import { arrSubject } from './crossChecks.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';
import { targetInput, writeTarget } from './writeTarget.ts';

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

const TARGET = writeTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'grimmory'],
    can: (a): a is ServiceAdapter & (MediaDeleteCapable | BookDeleteCapable) => hasMediaDelete(a) || hasBookDelete(a),
    cannot: 'has no media to delete'
});

/** `58` or `grimmory:58`; a book is addressed by its integer id and nothing else. */
function bookIdOf(id: string): string {
    const bare = id.replace(/^grimmory:/, '');
    if (!/^\d+$/.test(bare)) {
        throw new ServiceError('NotFound', 'grimmory', `"${id}" is not a Grimmory book id`, {
            remedy: 'Pass the book id as digits, as in 58 or grimmory:58: `acquisition.id` on a get_library record.'
        });
    }
    return bare;
}

async function planBook(
    adapter: ServiceAdapter & BookDeleteCapable,
    id: string,
    deleteFiles: boolean,
    addImportExclusion: boolean
): Promise<WritePlan> {
    const bookId = bookIdOf(id);
    if (!deleteFiles) {
        throw new ServiceError('PermissionDenied', adapter.id, 'Grimmory has no keep-files option: deleting a book always deletes its files', {
            remedy: 'Pass delete_files: true to delete it.'
        });
    }
    if (addImportExclusion) {
        throw new ServiceError('PermissionDenied', adapter.id, 'Grimmory has no import exclusions to add', {
            remedy: 'Leave add_import_exclusion off for a book.'
        });
    }
    if (!hasMediaDetails(adapter)) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot describe its own items`);
    }
    // Read first, so a bad id fails legibly and the preview names what goes.
    const details = await adapter.getMediaDetails(bookId, { includeEpisodes: false, episodeLimit: 0 });
    const formats = details.book?.formats ?? [];
    const sized = formats.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
    const size = humanSize(sized > 0 ? sized : details.sizeBytes);
    const kinds = [...new Set(formats.map(f => f.format))].join(', ');
    return {
        target: `${adapter.id}:${bookId}`,
        summary: `Delete ${details.title} from Grimmory, deleting ${size ?? 'its files'} from disk.`,
        effects: [
            `Deletes ${size ?? 'its files'} from disk${kinds === '' ? '' : `: ${kinds}`}. This cannot be undone.`,
            `Removes ${details.title} from Grimmory with its metadata, shelves and reading progress.`
        ],
        args: { service: 'grimmory', id: bookId, deleteFiles: true }
    };
}

export function registerDeleteMedia(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'delete_media',
        title: 'Delete a film, series or book',
        description:
            'Removes a film from Radarr, a whole series (or Whisparr site) from Sonarr or Whisparr, or a book from Grimmory, optionally deleting its files from disk. Grimmory always deletes the files of a book, so it needs `delete_files: true` and takes no import exclusion. Destructive and not undoable — files are gone, not moved to a recycle bin unless the service itself is configured for one. Takes `service` and `id`, never a title: take `id` from `acquisition.id` on a get_library or get_media_details record. Sonarr and Whisparr delete the entire series/site; to remove one season\'s files or specific episodes, use delete_episode_files instead. Previews first; confirm to delete.',
        inputSchema: z.object({
            ...targetInput(TARGET),
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
        target: { adapters, to: TARGET },
        operation: 'delete_media',
        tier: 'destructive',
        crossCheck: 'delete',

        async plan({ service, id, delete_files, add_import_exclusion }, adapter): Promise<WritePlan> {
            if (!hasMediaDelete(adapter)) {
                return planBook(adapter, id, delete_files, add_import_exclusion);
            }
            if (!hasMediaDetails(adapter)) {
                throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
            }

            // The read that makes the preview approvable, and that fails
            // legibly on a bad id rather than issuing a DELETE into the dark.
            const details = await adapter.getMediaDetails(id, { includeEpisodes: false, episodeLimit: 0 });
            const label = titled(details.title, details.year);
            const noun = service === 'radarr' ? 'film' : service === 'whisparr' ? 'site' : 'series';

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
                } else if (service === 'whisparr') {
                    effects.push('Deletes every scene of the site, not one season or one scene.');
                }
            } else {
                effects.push(`Leaves the files on disk — only the ${service} entry is removed.`);
            }

            effects.push(`Removes ${label} from ${service}, along with its monitoring and history.`);

            if (add_import_exclusion) {
                effects.push('Adds an import exclusion, so it will not be re-added automatically by a list or request.');
            }

            return {
                target: `${adapter.id}:${id}`,
                summary:
                    `Delete ${label} from ${service}` +
                    (delete_files
                        ? `, deleting ${size ?? 'its files'} from disk.`
                        : ', leaving its files on disk.'),
                effects,
                // Both flags are effect-bearing, so the confirmation token
                // commits to them: a token previewed for a database-only
                // removal must not be usable to also wipe the disk.
                args: { service, id, deleteFiles: delete_files, addImportExclusion: add_import_exclusion },
                // Not in `args`: what the checks find must not change which
                // write a token commits to.
                ...arrSubject(adapter, {
                    label,
                    ids: details.ids,
                    acquisition: { service: adapter.id, id },
                    // Bound to the token already as `deleteFiles`; this only tells the checks.
                    ...(delete_files ? {} : { filesStay: true })
                })
            };
        },

        async apply(_plan, { id, delete_files, add_import_exclusion }, adapter) {
            if (!hasMediaDelete(adapter)) {
                const bookId = bookIdOf(id);
                const outcome = await adapter.deleteBook(bookId);
                if (!outcome.deleted) {
                    throw new ServiceError('UpstreamError', adapter.id, `Grimmory did not delete book ${bookId}`, {
                        remedy: 'It answered without listing the book as deleted. Check the book still exists, then try again.'
                    });
                }
                return { deleted: `${adapter.id}:${bookId}`, filesLeft: outcome.filesLeft };
            }
            await adapter.deleteMedia(id, {
                deleteFiles: delete_files,
                addImportExclusion: add_import_exclusion
            });
            return { deleted: `${adapter.id}:${id}` };
        },

        applied(outcome, plan) {
            if ((outcome as { filesLeft?: boolean }).filesLeft !== true) return undefined;
            const title = plan.summary.replace(/^Delete (.*) from Grimmory, deleting .*$/, '$1');
            return `Applied, but Grimmory could not delete its files from disk; they are still in the library folder. Book removed: ${title}.`;
        }
    });
}
