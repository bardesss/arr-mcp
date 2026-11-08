import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import type { IdentityResolver } from '../core/identity.ts';
import { hasBookReadStatus, hasWatchState, type BookReadStatusCapable, type ServiceAdapter, type WatchStateCapable, type WatchTarget } from '../services/types.ts';
import { withBoth } from './mediaServers.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * "Mark season 2 watched" — the write half of `get_playback`.
 *
 * `safe` tier, with one caveat the preview states out loud: unmarking and
 * re-marking does not restore the original play date or resume position, so
 * the undo puts the flag back but not the history behind it.
 */

/**
 * Jellyfin-only by design: Plex watch state stays read-only in arr-mcp.
 * A Plex user is told to add Jellyfin alongside, not to replace Plex.
 */
const watchedRemedy = (adapters: readonly ServiceAdapter[]): string =>
    adapters.some(a => a.type === 'plex')
        ? 'set_watched needs Jellyfin — arr-mcp cannot write Plex watch state. Add a services.jellyfin block alongside Plex, set primary_media_server, and restart.'
        : 'Watch state lives in Jellyfin. Add a services.jellyfin block to config.yaml and restart.';

const jellyfinAdapter = (adapters: readonly ServiceAdapter[]): ServiceAdapter & WatchStateCapable => {
    const adapter = adapters.find(a => a.type === 'jellyfin');
    if (adapter === undefined || !hasWatchState(adapter)) {
        throw new ServiceError('NotFound', 'jellyfin', 'jellyfin is not configured', {
            remedy: watchedRemedy(adapters)
        });
    }
    return adapter;
};

const BOOK_PREFIX = 'grimmory:';
const isBookId = (itemId: string): boolean => itemId.startsWith(BOOK_PREFIX);

/** The adapter that holds books, found by capability so its id is whatever the config named it. */
const bookAdapter = (adapters: readonly ServiceAdapter[]): ServiceAdapter & BookReadStatusCapable => {
    const adapter = adapters.find(hasBookReadStatus);
    if (adapter === undefined) {
        throw new ServiceError('NotFound', 'grimmory', 'grimmory is not configured', {
            remedy: 'Book read status lives in Grimmory. Add a services.grimmory block to config.yaml and restart.'
        });
    }
    return adapter;
};

/** `grimmory:58` becomes `58`. Refuses anything after the prefix that is not a plain number, before any network call. */
const bookId = (itemId: string): string => {
    const id = itemId.slice(BOOK_PREFIX.length);
    if (!/^\d+$/.test(id)) {
        throw new ServiceError('NotFound', 'grimmory', `${itemId} is not a Grimmory book id`, {
            remedy: 'Use grimmory:<book id> with the numeric book id, the `acquisition.id` of a book row on get_library.'
        });
    }
    return id;
};

/** Books have one reader, the account arr-mcp signs in as, and no seasons. */
const refuseBookExtras = (args: { user?: string | undefined; season?: number | undefined }): void => {
    if (args.user !== undefined || args.season !== undefined) {
        throw new ServiceError('NotFound', 'grimmory', 'a book has one reader and no seasons, so user and season do not apply', {
            remedy: 'Drop user and season. Read status is for the Grimmory account arr-mcp signs in as.'
        });
    }
};

/** Already in the wanted state: READ for watched, UNREAD or never set for unwatched. */
const alreadyThere = (readStatus: string, watched: boolean): boolean =>
    watched ? readStatus === 'READ' : readStatus === 'UNREAD' || readStatus === 'UNSET';

const requireIdentity = (adapters: readonly ServiceAdapter[], identity: IdentityResolver | undefined): IdentityResolver => {
    if (identity === undefined) {
        throw new ServiceError('NotFound', 'jellyfin', 'jellyfin is not configured', {
            remedy: watchedRemedy(adapters)
        });
    }
    return identity;
};

/** What this call would actually change: the items not already in the wanted
 *  state. Empty means there is nothing to do. */
async function pending(
    adapter: ServiceAdapter & WatchStateCapable,
    user: { id: string; name: string },
    item: WatchTarget,
    season: number | undefined,
    watched: boolean
): Promise<{ targets: WatchTarget[]; total: number }> {
    if (item.kind !== 'series') {
        if (season !== undefined) {
            throw new ServiceError('NotFound', 'jellyfin', `${item.title} is not a series, so it has no seasons`, {
                remedy: 'Drop `season`, or pass the series item id instead of this one.'
            });
        }
        return { targets: item.watched === watched ? [] : [item], total: 1 };
    }

    const episodes = await adapter.listEpisodeItems(user, item.id, season);
    return { targets: episodes.filter(e => e.watched !== watched), total: episodes.length };
}

export function registerSetWatched(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    identity: IdentityResolver | undefined,
    mediaServerIds?: [string, string]
): void {
    registerWriteTool(server, context, {
        name: 'set_watched',
        title: 'Mark watched or unwatched',
        description:
            'Marks a film, series, season or episode watched or unwatched in Jellyfin. `item_id` is the Jellyfin id: `playback.itemId` from get_library or get_media_details, or `itemId` from get_playback. A Radarr or Sonarr id is refused. A series id with `season` marks one season. A Grimmory book is `grimmory:<book id>` (READ is watched; marking sets its finish date to now). Safe tier, but unmarking and re-marking loses the original play date and resume position. A `user` other than the default needs services.jellyfin.allow_other_users. Previews first; confirm to apply. Field reference: arr://docs/set_watched.' +
            withBoth(mediaServerIds, 'When Plex is the primary media server, take it from `media_servers.jellyfin.itemId` instead: `playback.itemId` is then a Plex id.'),
        inputSchema: z.object({
            item_id: z
                .string()
                .min(1)
                .describe(
                    'The Jellyfin item id — 32 hex characters. `playback.itemId` on a get_library or get_media_details record, or the `itemId` get_playback reports.' +
                        withBoth(mediaServerIds, 'Or `media_servers.jellyfin.itemId` when Plex is the primary media server.') +
                        ' Or `grimmory:<book id>` for a book. Not a Radarr or Sonarr id.'
                ),
            season: z
                .number()
                .int()
                .optional()
                .describe('One season of a series. Omit with a series id to mark the whole series. Refused on a film.'),
            watched: z.boolean().describe('true to mark watched, false to unmark.'),
            user: z
                .string()
                .optional()
                .describe(
                    'Whose watch state to change. Defaults to services.jellyfin.default_user; naming anyone else needs services.jellyfin.allow_other_users.'
                )
        }),
        service: ({ item_id }) => (isBookId(item_id) ? (adapters.find(hasBookReadStatus)?.id ?? 'grimmory') : 'jellyfin'),
        operation: 'set_watched',
        tier: 'safe',

        async plan({ item_id, season, watched, user }): Promise<WritePlan> {
            if (isBookId(item_id)) {
                refuseBookExtras({ user, season });
                const id = bookId(item_id);
                const book = await bookAdapter(adapters).readBookReadStatus(id);
                const target = `grimmory:${id}`;
                const status = watched ? 'READ' : 'UNREAD';
                if (alreadyThere(book.readStatus, watched)) {
                    return {
                        target,
                        summary: `${book.title} is already marked ${watched ? 'read' : 'unread'} for the Grimmory account.`,
                        effects: [],
                        noop: true
                    };
                }
                return {
                    target,
                    summary: `Mark ${book.title} ${status} for the Grimmory account arr-mcp signs in as.`,
                    effects: [
                        `Marks ${book.title} ${status} for the Grimmory account arr-mcp signs in as.`,
                        'Marking it read sets its finish date to now. Marking it unread clears the finish date, and an earlier one is not restored.'
                    ],
                    args: { itemId: target, watched }
                };
            }
            const adapter = jellyfinAdapter(adapters);
            // Configuration only, and before any network call — nothing
            // Jellyfin returns can widen whose state may be written.
            const viewer = await requireIdentity(adapters, identity).resolve(user);

            const item = await adapter.readWatchTarget(viewer, item_id);
            const { targets, total } = await pending(adapter, viewer, item, season, watched);

            const scope =
                item.kind === 'series'
                    ? season === undefined
                        ? `${item.title} (${total} episodes)`
                        : `${item.title} season ${season} (${total} episodes)`
                    : item.title;
            const target = `jellyfin:${item.id}${season === undefined ? '' : `:s${season}`}`;
            const verb = watched ? 'watched' : 'unwatched';

            if (targets.length === 0) {
                return {
                    target,
                    summary: `${scope} is already marked ${verb} for ${viewer.name}.`,
                    effects: [],
                    noop: true
                };
            }

            // The count, not the season number. "Marks season 2 watched" is
            // not something anyone can weigh.
            const amount =
                item.kind === 'series'
                    ? `${targets.length} episode${targets.length === 1 ? '' : 's'}`
                    : `1 ${item.kind === 'movie' ? 'film' : 'item'}`;

            return {
                target,
                summary: `Mark ${scope} ${verb} for ${viewer.name}.`,
                effects: [
                    `Marks ${amount} ${verb} for ${viewer.name} in Jellyfin.`,
                    watched
                        ? 'Anything marked watched drops out of Continue Watching and Next Up.'
                        : 'Anything unmarked comes back into Next Up.',
                    // The reason this is not a perfectly clean undo, said
                    // before the fact rather than discovered after.
                    'Re-marking later restores the flag but not the original play date or resume position — that history is not recoverable.'
                ],
                args: { itemId: item.id, watched, ...(season === undefined ? {} : { season }) }
            };
        },

        async apply(_plan, { item_id, season, watched, user }) {
            if (isBookId(item_id)) {
                refuseBookExtras({ user, season });
                const id = bookId(item_id);
                const adapter = bookAdapter(adapters);
                // Read again so a book that went READ since the preview is not written twice.
                const book = await adapter.readBookReadStatus(id);
                if (alreadyThere(book.readStatus, watched)) return { changed: 0 };
                await adapter.setBookReadStatus(id, watched ? 'READ' : 'UNREAD');
                return { changed: 1 };
            }
            const adapter = jellyfinAdapter(adapters);
            const viewer = await requireIdentity(adapters, identity).resolve(user);

            const item = await adapter.readWatchTarget(viewer, item_id);
            const { targets } = await pending(adapter, viewer, item, season, watched);

            // Sequentially rather than in parallel: this can be a whole
            // series, and a burst of a hundred concurrent writes at one
            // Jellyfin is how a rate limit turns into a half-applied change.
            for (const each of targets) {
                await adapter.setWatched(viewer, each.id, watched);
            }

            return { changed: targets.length };
        }
    });
}
