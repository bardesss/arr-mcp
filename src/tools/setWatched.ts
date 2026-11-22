import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MEDIA_SERVER_NAMES, type MediaServerId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { IdentityResolver } from '../core/identity.ts';
import { EMBY } from '../services/emby.ts';
import { JELLYFIN } from '../services/jellyfin.ts';
import { hasBookReadStatus, hasWatchState, type BookReadStatusCapable, type ServiceAdapter, type WatchStateCapable, type WatchTarget } from '../services/types.ts';
import { serverItemIdByTitle } from './byTitle.ts';
import type { LibraryLoader } from './library.ts';
import { byMediaServers, withBoth } from './mediaServers.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * "Mark season 2 watched"; the write half of `get_playback`.
 *
 * `safe` tier, with one caveat the preview states out loud: unmarking and
 * re-marking does not restore the original play date or resume position, so
 * the undo puts the flag back but not the history behind it.
 */

/**
 * Jellyfin or Emby by design: Plex watch state stays read-only in arr-mcp.
 * A Plex user is told to add one of them alongside, not to replace Plex.
 */
const watchedRemedy = (adapters: readonly ServiceAdapter[]): string =>
    adapters.some(a => a.type === 'plex')
        ? 'set_watched needs Jellyfin or Emby; arr-mcp cannot write Plex watch state. Add a services.jellyfin or services.emby block alongside Plex, set primary_media_server, and restart.'
        : 'Watch state lives in Jellyfin or Emby. Add a services.jellyfin or services.emby block to config.yaml and restart.';

/**
 * The media server whose users `identity` resolves, which register.ts picks
 * as the first of primary and secondary that writes watch state. Found
 * through it, so the server written to and the user directory are always the
 * same one.
 */
const watchServer = (
    adapters: readonly ServiceAdapter[],
    identity: IdentityResolver | undefined
): { adapter: ServiceAdapter & WatchStateCapable; identity: IdentityResolver } => {
    const adapter = identity === undefined ? undefined : adapters.find(a => a.id === identity.serviceId);
    if (identity === undefined || adapter === undefined || !hasWatchState(adapter)) {
        // Named for neither: it is the absence of both that is being reported.
        throw new ServiceError('NotFound', 'media server', 'neither jellyfin nor emby is configured', {
            remedy: watchedRemedy(adapters)
        });
    }
    return { adapter, identity };
};

/**
 * The media servers whose watch state set_watched writes, by their dialect,
 * which says how their item ids look; Plex's is never written. A test holds
 * this to the adapters.
 */
export const WATCH_STATE_SERVERS = { jellyfin: JELLYFIN, emby: EMBY } as const;
type Writer = keyof typeof WATCH_STATE_SERVERS;
const isWriter = (id: string): id is Writer => Object.hasOwn(WATCH_STATE_SERVERS, id);

/**
 * The writers a description names. With Jellyfin and Emby both configured
 * only the primary is written to (register.ts), so only it is named; with
 * one of them, the `[[…]]` scopes drop the other.
 */
const writersOf = (ids: [string, string] | undefined): Writer[] => (ids === undefined ? [] : ids.filter(isWriter));
const named = (ids: [string, string] | undefined): Writer[] => {
    const writers = writersOf(ids);
    return writers.length === 2 ? writers.slice(0, 1) : (Object.keys(WATCH_STATE_SERVERS) as Writer[]);
};
const scopeOf = (ids: [string, string] | undefined): string => named(ids).join('|');
/** `{{or: …}}` entries, one per writer named. */
const entries = (ids: [string, string] | undefined, text: (id: Writer, name: string) => string): string =>
    named(ids)
        .map(id => `${id}=${text(id, MEDIA_SERVER_NAMES[id])}`)
        .join('; ');

/**
 * Said where Radarr or Sonarr is configured. A writer whose ids have their
 * shape (Emby's 12 was a film on the test server) cannot refuse one, so the
 * preview is the check.
 */
const arrIdNote = (writer: Writer | undefined): string =>
    writer !== undefined && WATCH_STATE_SERVERS[writer].itemId.likeArrIds
        ? `[[radarr|sonarr: ${MEDIA_SERVER_NAMES[writer]} ids are ${WATCH_STATE_SERVERS[writer].itemId.described}, as {{or: radarr=Radarr's; sonarr=Sonarr's}} are, so check that the preview names the right item.]] `
        : '[[radarr|sonarr: A {{or: radarr=Radarr; sonarr=Sonarr}} id is refused.]] ';

/** With Plex as the other server: where the writer's own id is, since `playback.itemId` is then Plex's whenever Plex is the primary. */
const writerBesidePlex = (ids: [string, string] | undefined): { writer: Writer; other: string } | undefined => {
    const writers = writersOf(ids);
    const [writer] = writers;
    const other = ids?.find(id => id !== writer) as MediaServerId | undefined;
    return writers.length === 1 && writer !== undefined && other !== undefined ? { writer, other: MEDIA_SERVER_NAMES[other] } : undefined;
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

/** What this call would actually change: the items not already in the wanted
 *  state. Empty means there is nothing to do. */
async function pending(
    adapter: ServiceAdapter & WatchStateCapable,
    user: { id: string; name: string },
    item: WatchTarget,
    season: number | undefined,
    watched: boolean
): Promise<{ targets: WatchTarget[]; total: number }> {
    if (item.kind === 'folder') {
        // Jellyfin marks a folder's children recursively, so one write here
        // would change far more than the "1 item" a preview could show.
        throw new ServiceError('NotFound', adapter.id, `${item.title} is a folder, and marking it would mark every item inside it`, {
            remedy:
                item.seriesId !== undefined && item.season !== undefined
                    ? `Pass the series id ${item.seriesId} with \`season: ${item.season}\`.`
                    : 'Pass a film, series or episode id; for one season, the series id plus `season`.'
        });
    }
    if (item.kind !== 'series') {
        if (season !== undefined) {
            throw new ServiceError('NotFound', adapter.id, `${item.title} is not a series, so it has no seasons`, {
                remedy: 'Drop `season`, or pass the series item id instead of this one.'
            });
        }
        return { targets: item.watched === watched ? [] : [item], total: 1 };
    }

    const episodes = await adapter.listEpisodeItems(user, item.id, season);
    if (season !== undefined && episodes.length === 0) {
        // An empty season reads as "already marked" otherwise. The second
        // read only happens on this refusal path.
        const seasons = [...new Set((await adapter.listEpisodeItems(user, item.id)).flatMap(e => (e.season === undefined ? [] : [e.season])))].sort(
            (a, b) => a - b
        );
        throw new ServiceError('NotFound', adapter.id, `${item.title} has no season ${season} in ${adapter.name}`, {
            remedy: seasons.length === 0 ? `${adapter.name} lists no episodes for this series.` : `Seasons it has: ${seasons.join(', ')}.`
        });
    }
    return { targets: episodes.filter(e => e.watched !== watched), total: episodes.length };
}

const setWatchedInput = byMediaServers(ids => z.object({
    title: z
        .string()
        .min(1)
        .optional()
        .describe('A film or series title, in place of `item_id`. Resolved as get_media_details does; a title two items match equally is refused with both ids.'),
    item_id: z
        .string()
        .min(1)
        .optional()
        .describe(
            named(ids)
                .map(id => `[[${id}: The ${MEDIA_SERVER_NAMES[id]} item id: ${WATCH_STATE_SERVERS[id].itemId.described}.]] `)
                .join('') +
                `[[${scopeOf(ids)}: \`playback.itemId\` on a get_library or get_media_details record, or the \`itemId\` get_playback reports.]]` +
                ((w => withBoth(ids, w === undefined ? '' : `Or \`media_servers.${w.writer}.itemId\` when ${w.other} is the primary media server.`))(writerBesidePlex(ids))) +
                ' [[grimmory: A book is `grimmory:<book id>`.]] [[radarr|sonarr: Not a {{or: radarr=Radarr; sonarr=Sonarr}} id.]]'
        ),
    season: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('One season of a series. Omit with a series id to mark the whole series. Refused on a film.'),
    watched: z.boolean().describe('true to mark watched, false to unmark.'),
    user: z
        .string()
        .optional()
        .describe(
            `Whose watch state to change. Defaults to {{or: ${entries(ids, id => `services.${id}.default_user`)}; else=services.jellyfin.default_user}}; ` +
                `naming anyone else needs {{or: ${entries(ids, id => `services.${id}.allow_other_users`)}; else=services.jellyfin.allow_other_users}}.`
        )
}));

export function registerSetWatched(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    identity: IdentityResolver | undefined,
    mediaServerIds?: [string, string],
    /** Resolves `title`. Absent in tests that only ever pass an id. */
    loader?: LibraryLoader
): void {
    // One of the two, and a title is turned into the Jellyfin id the rest
    // works with. Both preview and confirm run this, and the confirm token is
    // bound to the resolved id, so a title that resolves differently between
    // the two is refused rather than written.
    const itemIdOf = async (item_id: string | undefined, title: string | undefined): Promise<string> => {
        if ((item_id === undefined) === (title === undefined)) {
            throw new Error('Pass either `item_id` or `title`, not both.');
        }
        if (item_id !== undefined) return item_id;
        if (loader === undefined) throw new Error('`title` cannot be resolved here; pass `item_id`.');
        return serverItemIdByTitle(adapters, loader, title as string, watchServer(adapters, identity).adapter);
    };

    registerWriteTool(server, context, {
        name: 'set_watched',
        title: 'Mark watched or unwatched',
        description:
            `Marks {{or: ${entries(mediaServerIds, (_, name) => `a film, series, season or episode watched or unwatched in ${name}`)}; grimmory=a Grimmory book read or unread}}. ` +
            `Give a \`title\`, or \`item_id\`[[${scopeOf(mediaServerIds)}: , the {{or: ${entries(mediaServerIds, (_, name) => name)}}} id: \`playback.itemId\` from get_library or get_media_details, or \`itemId\` from get_playback]]. ` +
            arrIdNote(identity !== undefined && isWriter(identity.serviceId) ? identity.serviceId : undefined) +
            `[[${scopeOf(mediaServerIds)}: A series id with \`season\` marks one season.]] [[grimmory: A book is \`grimmory:<book id>\`; READ is watched, and marking sets its finish date to now.]] ` +
            'Safe tier, but unmarking and re-marking loses the original play date and resume position. ' +
            `[[${scopeOf(mediaServerIds)}: A \`user\` other than the default needs {{or: ${entries(mediaServerIds, id => `services.${id}.allow_other_users`)}}}.]] ` +
            'Previews first; confirm to apply. Field reference: arr://docs/set_watched.' +
            ((w => withBoth(mediaServerIds, w === undefined ? '' : `When ${w.other} is the primary media server, take it from \`media_servers.${w.writer}.itemId\` instead: \`playback.itemId\` is then a ${w.other} id.`))(writerBesidePlex(mediaServerIds))),
        inputSchema: setWatchedInput(mediaServerIds),
        service: ({ item_id }) => (item_id !== undefined && isBookId(item_id) ? (adapters.find(hasBookReadStatus)?.id ?? 'grimmory') : (identity?.serviceId ?? 'jellyfin')),
        operation: 'set_watched',
        tier: 'safe',

        async plan({ item_id: given, title, season, watched, user }): Promise<WritePlan> {
            const item_id = await itemIdOf(given, title);
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
            const { adapter, identity: who } = watchServer(adapters, identity);
            // Configuration only, and before any network call; nothing
            // the server returns can widen whose state may be written.
            const viewer = await who.resolve(user);

            const item = await adapter.readWatchTarget(viewer, item_id);
            const { targets, total } = await pending(adapter, viewer, item, season, watched);

            const scope =
                item.kind === 'series'
                    ? season === undefined
                        ? `${item.title} (${total} episodes)`
                        : `${item.title} season ${season} (${total} episodes)`
                    : item.title;
            const target = `${adapter.id}:${item.id}${season === undefined ? '' : `:s${season}`}`;
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
                    `Marks ${amount} ${verb} for ${viewer.name} in ${adapter.name}.`,
                    watched
                        ? 'Anything marked watched drops out of Continue Watching and Next Up.'
                        : 'Anything unmarked comes back into Next Up.',
                    // The reason this is not a perfectly clean undo, said
                    // before the fact rather than discovered after.
                    'Re-marking later restores the flag but not the original play date or resume position. That history is not recoverable.'
                ],
                args: { itemId: item.id, viewer: viewer.id, watched, ...(season === undefined ? {} : { season }) }
            };
        },

        async apply(_plan, { item_id: given, title, season, watched, user }) {
            const item_id = await itemIdOf(given, title);
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
            const { adapter, identity: who } = watchServer(adapters, identity);
            const viewer = await who.resolve(user);

            const item = await adapter.readWatchTarget(viewer, item_id);
            const { targets } = await pending(adapter, viewer, item, season, watched);

            // Sequentially rather than in parallel: this can be a whole
            // series, and a burst of a hundred concurrent writes at one
            // server is how a rate limit turns into a half-applied change.
            // It stops at the first failure, and what was marked before it is
            // reported as applied: thrown, a series half marked would read as
            // nothing changed, and the library cache would keep the old state.
            let changed = 0;
            for (const each of targets) {
                try {
                    await adapter.setWatched(viewer, each.id, watched);
                } catch (err) {
                    if (changed === 0) throw err;
                    return {
                        changed,
                        failed: `${each.title}: ${err instanceof Error ? err.message : String(err)}`,
                        notTried: targets.length - changed - 1,
                        server: adapter.name
                    };
                }
                changed += 1;
            }

            return { changed };
        },

        applied(outcome, plan) {
            const result = outcome as { changed: number; failed?: undefined } | { changed: number; failed: string; notTried: number; server: string };
            if (result.failed === undefined) return undefined;
            const { changed, failed, notTried, server } = result;
            return `Partly applied. ${plan.summary} Marked ${changed}, then ${server} failed on ${failed}${
                notTried === 0 ? '' : `, and ${notTried} more ${notTried === 1 ? 'was' : 'were'} not tried`
            }. Call set_watched again to finish: it only marks what is still left.`;
        }
    });
}
