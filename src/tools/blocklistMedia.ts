import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { unfence } from '../core/fence.ts';
import { titled } from '../core/labels.ts';
import { checkPermission, type PermissionSource, type WriteTier } from '../core/permissions.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Seerr's blocklist (#602): a title on it cannot be requested by anyone, so a
 * film deleted from Radarr is not sent straight back by the next request or
 * watchlist sync. `delete_media` adds to it in the same call as the delete;
 * this tool is the rest — blocklisting a title that was never in Radarr or
 * Sonarr, retrying one the delete could not finish, and lifting one.
 *
 * Adding is `safe`: it changes nothing Seerr has, only refuses what comes
 * next. Removing is `destructive`, which is Seerr's doing and not obvious from
 * the word: its route deletes the title's media record with the blocklist row,
 * and that record cascades to every request and issue for the title
 * (`server/routes/blocklist.ts`, `entity/Media.ts`). One tool with the tier
 * derived from `action`, as `manage_indexer` did for its delete, because the
 * two directions of one list are one thing to look for.
 */

const seerrOf = (adapters: readonly ServiceAdapter[]): SeerrAdapter | undefined =>
    adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

export function requireSeerr(adapters: readonly ServiceAdapter[]): SeerrAdapter {
    const seerr = seerrOf(adapters);
    if (seerr === undefined) {
        throw new ServiceError('NotFound', 'seerr', 'seerr is not configured', {
            remedy: 'The blocklist lives in Seerr. Add a services.seerr block to config.yaml and restart.'
        });
    }
    return seerr;
}

/**
 * For a write that reaches Seerr from another service's tool. The harness
 * checks the permissions of the service a tool is routed to, and nothing else,
 * so `delete_media` on Radarr would otherwise blocklist in Seerr on Radarr's
 * grant alone.
 */
export function requireSeerrWrite(permissions: PermissionSource, seerr: SeerrAdapter, tier: WriteTier, operation: string): void {
    const verdict = checkPermission(permissions, seerr.id, tier);
    if (!verdict.allowed) {
        throw new ServiceError('PermissionDenied', seerr.id, `${verdict.reason} (${tier} write ${operation} on ${seerr.id})`, {
            remedy: verdict.remedy
        });
    }
}

/** Seerr's word for a kind. */
export const seerrMediaType = (kind: 'movie' | 'series'): 'movie' | 'tv' => (kind === 'series' ? 'tv' : 'movie');

const BlocklistMediaInput = z.object({
    action: z.enum(['add', 'remove']).describe('add, or remove (destructive: Seerr also deletes its record of the title).'),
    tmdb_id: z.number().int().positive().describe("The title's TMDB id: `ids.tmdb` on a get_media_details or search_media record."),
    kind: z.enum(['movie', 'series'])
});

export function registerBlocklistMedia(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'blocklist_media',
        title: 'Blocklist a title in Seerr',
        description:
            "Adds a film or series to Seerr's blocklist so nobody can request it, or removes it. delete_media's `seerr_blocklist` adds while deleting. Removing is destructive: Seerr also deletes the title's requests and issues. Previews first; confirm to apply.",
        inputSchema: BlocklistMediaInput,
        service: 'seerr',
        operation: 'blocklist_media',
        tier: ({ action }) => (action === 'remove' ? 'destructive' : 'safe'),

        async plan({ action, tmdb_id, kind }): Promise<WritePlan> {
            const seerr = requireSeerr(adapters);
            const mediaType = seerrMediaType(kind);
            // Strict, so a wrong id or kind fails here as a 404 rather than
            // blocklisting a TMDB id nobody looked at.
            const media = await seerr.describeTitle(mediaType, tmdb_id, { strict: true });
            const label = media === undefined ? `TMDB ${kind} ${tmdb_id}` : titled(media.title, media.year);
            const listed = await seerr.isBlocklisted(tmdb_id, mediaType);
            const target = `seerr:${mediaType}:${tmdb_id}`;
            const args = { action, tmdbId: tmdb_id, mediaType, ...(media === undefined ? {} : { title: unfence(media.title) }) };

            if (action === 'add') {
                if (listed) return { target, summary: `${label} is already blocklisted in Seerr.`, effects: [], noop: true };
                return {
                    target,
                    summary: `Blocklist ${label} in Seerr.`,
                    effects: [
                        'Seerr refuses every new request for it, from any user or watchlist sync, until it is removed from the blocklist.',
                        'Leaves its existing requests, and anything Radarr or Sonarr already has, as they are.'
                    ],
                    args
                };
            }

            if (!listed) return { target, summary: `${label} is not blocklisted in Seerr.`, effects: [], noop: true };
            return {
                target,
                summary: `Remove ${label} from Seerr's blocklist.`,
                effects: [
                    "Deletes Seerr's record of it, with every request and issue for it. Seerr does this whenever a title leaves the blocklist, and it cannot be undone.",
                    'It can be requested again.'
                ],
                args
            };
        },

        async apply(plan, { action, tmdb_id, kind }) {
            const seerr = requireSeerr(adapters);
            const mediaType = seerrMediaType(kind);
            if (action === 'remove') {
                await seerr.removeFromBlocklist(tmdb_id, mediaType);
                return { removed: plan.target };
            }
            const title = plan.args?.['title'];
            const outcome = await seerr.addToBlocklist({ tmdbId: tmdb_id, mediaType, ...(typeof title === 'string' ? { title } : {}) });
            return { blocklisted: plan.target, outcome };
        }
    });
}
