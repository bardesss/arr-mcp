import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import type { IdentityResolver } from '../core/identity.ts';
import { hasWatchState, type ServiceAdapter, type WatchStateCapable, type WatchTarget } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * "Mark season 2 watched" — the write half of `get_playback`.
 *
 * `safe` tier, with one caveat the preview states out loud: unmarking and
 * re-marking does not restore the original play date or resume position, so
 * the undo puts the flag back but not the history behind it.
 */

/**
 * `set_watched` is Jellyfin-only by design — Plex stays read-only in
 * arr-mcp — so the refusal itself is correct even for a Plex-only stack.
 * Only the remedy needs to stop assuming the reader has no media server at
 * all: a Plex user is told this is a Jellyfin-specific write, not "go add
 * a media server". And since jellyfin and plex cannot both be configured
 * (schema.ts refuses it), the remedy for a Plex user cannot be "add
 * services.jellyfin" — that config would fail to start. It has to be
 * "replace".
 */
const watchedRemedy = (adapters: readonly ServiceAdapter[]): string =>
    adapters.some(a => a.type === 'plex')
        ? 'set_watched needs Jellyfin — Plex is read-only in arr-mcp, and jellyfin/plex cannot both be configured. Replace the services.plex block with services.jellyfin and restart.'
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
    identity: IdentityResolver | undefined
): void {
    registerWriteTool(server, context, {
        name: 'set_watched',
        title: 'Mark watched or unwatched',
        description:
            'Marks a film, series, season or episode watched or unwatched in Jellyfin. `item_id` is a **Jellyfin** item id — take it from `playback.itemId` on a get_library or get_media_details record, from the `itemId` get_playback reports, or from a jellyfin hit in search_media. Radarr and Sonarr ids will not work here and are refused rather than guessed at. Pass a series id with `season` to mark one season; the preview says how many episodes that is. Safe tier, with one caveat: unmarking and re-marking restores the flag but not the original play date or resume position. `user` names whose watch state changes, and naming anyone but the configured default user needs services.jellyfin.allow_other_users. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            item_id: z
                .string()
                .min(1)
                .describe('The Jellyfin item id — 32 hex characters. `playback.itemId` on a get_library or get_media_details record, or the `itemId` get_playback reports. Not a Radarr or Sonarr id.'),
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
        service: 'jellyfin',
        operation: 'set_watched',
        tier: 'safe',

        async plan({ item_id, season, watched, user }): Promise<WritePlan> {
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
