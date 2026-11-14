import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasBookDelete, hasMediaDelete, hasMediaDetails, type BookDeleteCapable, type MediaDeleteCapable, type ServiceAdapter } from '../services/types.ts';
import { arrSubject } from './crossChecks.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';
import { unfence } from '../core/fence.ts';
import { requireSeerr, requireSeerrWrite, seerrMediaType } from './blocklistMedia.ts';

/**
 * The first destructive-tier write. Everything the harness does matters more
 * here than it did for `trigger_search`: this is the tool where a preview the
 * user did not read is a film they cannot get back.
 *
 * Which is why `plan` reads the item first and reports the size on disk. "Delete
 * radarr:412" is not something anyone can meaningfully approve; "Delete Alien
 * (1979) from radarr, deleting 24.1 GB from disk" is.
 */

const GIB = 1024 ** 3;

/** What each *arr calls the item it deletes; Sonarr's is the fallback. */
const ITEM_NOUN: Readonly<Partial<Record<ServiceId, string>>> = { radarr: 'film', whisparr: 'site', lidarr: 'artist' };

/** Deliberately coarse. This number exists to make someone hesitate, not to
 *  balance a ledger, and false precision reads as machine noise. */
function humanSize(bytes: number | undefined): string | undefined {
    if (bytes === undefined || bytes <= 0) return undefined;
    return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'lidarr', 'grimmory'],
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

/** What the Seerr half of a delete sends, bound to the token with the rest. */
type SeerrBlocklistStep = { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; already?: true };

/**
 * The Seerr half of `seerr_blocklist` (#602), checked in the preview so a
 * delete is never confirmed on a blocklist that was going to be refused:
 * Seerr configured, permitted to take a safe write, and a TMDB id to key on.
 */
async function planSeerrBlocklist(
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    details: { kind: string; title: string; ids: { tmdb?: number } },
    effects: string[]
): Promise<SeerrBlocklistStep> {
    const seerr = requireSeerr(adapters);
    requireSeerrWrite(context.permissions, seerr, 'safe', 'blocklist_media');
    const tmdbId = details.ids.tmdb;
    if (tmdbId === undefined) {
        throw new ServiceError('NotFound', seerr.id, 'it has no TMDB id, which Seerr keys its blocklist on', {
            remedy: 'Refresh it in Radarr or Sonarr so it picks up a TMDB id, or delete it without seerr_blocklist.'
        });
    }
    const mediaType = seerrMediaType(details.kind === 'series' ? 'series' : 'movie');
    const step: SeerrBlocklistStep = { tmdbId, mediaType, title: unfence(details.title) };
    if (await seerr.isBlocklisted(tmdbId, mediaType)) {
        effects.push('Already blocklisted in Seerr, so that is left as it is.');
        return { ...step, already: true };
    }
    effects.push('Blocklists it in Seerr afterwards, so nobody can request it again; blocklist_media removes it.');
    return step;
}

const DeleteMediaInput = z.object({
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
        ),
    seerr_blocklist: z
        .boolean()
        .default(false)
        .describe('[[seerr: {{and: radarr=Radarr; sonarr=Sonarr}}: also blocklist it in Seerr, so it cannot be requested again. Defaults to false.]]')
});

export function registerDeleteMedia(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'delete_media',
        title: 'Delete a film, series, artist or book',
        description:
            'Removes {{or: radarr=a film from Radarr; sonarr=a whole series from Sonarr; whisparr=a whole site from Whisparr; lidarr=a whole artist from Lidarr (by artist id, never an album id); grimmory=a book from Grimmory}}, optionally deleting its files from disk. [[grimmory: Grimmory always deletes the files of a book, so it needs `delete_files: true` and takes no import exclusion.]] Destructive and not undoable: files are gone, not moved to a recycle bin unless the service itself is configured for one. Takes `service` and `id`, never a title: take `id` from `acquisition.id` on a get_library or get_media_details record. [[sonarr|whisparr: On {{or: sonarr=Sonarr; whisparr=Whisparr}} it deletes the whole series; to remove one season\'s files or specific episodes, use delete_episode_files instead.]] Previews first; confirm to delete.',
        inputSchema: DeleteMediaInput,
        target: { adapters, to: TARGET },
        operation: 'delete_media',
        tier: 'destructive',
        crossCheck: 'delete',

        async plan({ service, id, delete_files, add_import_exclusion, seerr_blocklist }, adapter): Promise<WritePlan> {
            if (seerr_blocklist && adapter.type !== 'radarr' && adapter.type !== 'sonarr') {
                throw new ServiceError('PermissionDenied', adapter.id, `seerr_blocklist is for a Radarr film or a Sonarr series, not ${service}`, {
                    remedy: 'Leave seerr_blocklist off.'
                });
            }
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
            const noun = ITEM_NOUN[service] ?? 'series';

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
                } else if (service === 'lidarr') {
                    effects.push('Deletes every album of the artist.');
                }
            } else {
                effects.push(`Leaves the files on disk. Only the ${service} entry is removed.`);
            }

            effects.push(`Removes ${label} from ${service}, along with its monitoring and history.`);

            // Lidarr's exclusion keeps its import lists from adding the artist
            // (`ImportListSyncService`); nothing checks it when an artist is added
            // through the API. Adding one of the artist's albums, by hand or
            // through the API, deletes it (`AddAlbumService`).
            if (add_import_exclusion) {
                effects.push(
                    service === 'lidarr'
                        ? "Adds an import list exclusion, so Lidarr's import lists will not add it again until one of its albums is added, by hand or through Lidarr's API."
                        : 'Adds an import exclusion, so it will not be re-added automatically by a list or request.'
                );
            }

            const blocklist = seerr_blocklist ? await planSeerrBlocklist(context, adapters, details, effects) : undefined;

            return {
                target: `${adapter.id}:${id}`,
                summary:
                    `Delete ${label} from ${adapter.id}` +
                    (delete_files
                        ? `, deleting ${size ?? 'its files'} from disk.`
                        : ', leaving its files on disk.'),
                effects,
                // Both flags are effect-bearing, so the confirmation token
                // commits to them: a token previewed for a database-only
                // removal must not be usable to also wipe the disk.
                args: {
                    service,
                    id,
                    deleteFiles: delete_files,
                    addImportExclusion: add_import_exclusion,
                    ...(blocklist === undefined ? {} : { seerrBlocklist: blocklist })
                },
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

        async apply(plan, { id, delete_files, add_import_exclusion }, adapter) {
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
            const deleted = `${adapter.id}:${id}`;
            const blocklist = plan.args?.['seerrBlocklist'] as SeerrBlocklistStep | undefined;
            if (blocklist === undefined || blocklist.already) return { deleted };
            // After the delete, never before: Seerr's sync would read a film
            // Radarr still has as available again. A failure here is reported,
            // not thrown, because the delete above has already happened.
            try {
                await requireSeerr(adapters).addToBlocklist(blocklist);
                return { deleted, seerrBlocklisted: true };
            } catch (err) {
                return { deleted, seerrBlocklistFailed: err instanceof Error ? err.message : String(err) };
            }
        },

        applied(outcome, plan) {
            const failed = (outcome as { seerrBlocklistFailed?: string }).seerrBlocklistFailed;
            if (failed !== undefined) {
                const step = plan.args?.['seerrBlocklist'] as SeerrBlocklistStep;
                const kind = step.mediaType === 'tv' ? 'series' : 'movie';
                return `Applied. ${plan.summary} But Seerr did not blocklist it: ${failed} To retry, call blocklist_media with action: "add", id: ${step.tmdbId}, kind: "${kind}".`;
            }
            if ((outcome as { filesLeft?: boolean }).filesLeft !== true) return undefined;
            const title = plan.summary.replace(/^Delete (.*) from Grimmory, deleting .*$/, '$1');
            return `Applied, but Grimmory could not delete its files from disk; they are still in the library folder. Book removed: ${title}.`;
        }
    });
}
