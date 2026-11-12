import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { IdentityResolver } from '../core/identity.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, listText, toolInput, type DetailLevel } from '../core/shape.ts';
import { NO_MEDIA_SERVER_NOTE, type MediaServerAdapter, type PlaybackEntry } from '../services/types.ts';
import { bothIds, byMediaServers, pickMediaServer, serviceInput, withBoth, type MediaServers } from './mediaServers.ts';
import { episodeCode } from '../core/labels.ts';

type GetPlaybackResult = {
    items: PlaybackEntry[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /** A fact about the stack's config, not this call — see `NO_MEDIA_SERVER_NOTE`. */
    note?: string;
};

export const UserSchema = z
    .string()
    .min(1)
    .optional()
    .describe(
        'Whose playback to read; defaults to the configured default_user, any other needs allow_other_users.'
    );

type PlaybackScope = 'active' | 'next_up' | 'history';

const ScopeSchema = z
    .enum(['active', 'next_up', 'history'])
    .default('active')
    .describe(
        '`active` (default): now playing and what can be resumed. `next_up`: the next unwatched episode of every ' +
            "series this user has in progress, your media server's own answer to what to watch next. `history`: " +
            'recently watched movies and episodes, newest first, on Jellyfin including plays its activity log holds ' +
            'that never got marked played, such as an offline client syncing back.'
    );

const project = (e: PlaybackEntry, detail: DetailLevel): PlaybackEntry => {
    if (detail === 'full') return e;
    if (detail === 'minimal') {
        return { service: e.service, kind: e.kind, itemId: e.itemId, title: e.title, user: e.user };
    }
    const { device: _d, lastPlayed: _l, ...rest } = e;
    // `lastPlayed` is the one field `history` exists to answer, so a history
    // entry keeps it even at standard detail. `active` and `next_up` entries
    // never carry either history kind, so this cannot move their output.
    return (e.kind === 'watched' || e.kind === 'partially_watched') && e.lastPlayed !== undefined
        ? { ...rest, lastPlayed: e.lastPlayed }
        : rest;
};

export async function buildGetPlayback(
    adapter: MediaServerAdapter | undefined,
    resolver: IdentityResolver | undefined,
    opts: { detail: DetailLevel; limit: number; offset?: number; user?: string; scope?: PlaybackScope }
): Promise<GetPlaybackResult> {
    if (adapter === undefined || resolver === undefined) {
        return {
            items: [],
            total: 0,
            returned: 0,
            offset: 0,
            truncated: false,
            degraded: [],
            note: NO_MEDIA_SERVER_NOTE
        };
    }

    // Deliberately outside the try: an authorization or configuration failure
    // must reach the caller as an error, not be flattened into `degraded`.
    // A model told "Jellyfin is down" when it was actually refused will retry
    // forever; one told it was refused will not.
    const user = await resolver.resolve(opts.user);

    const scope = opts.scope ?? 'active';
    const read =
        scope === 'next_up'
            ? () => adapter.getNextUp(user)
            : scope === 'history'
              ? () => adapter.getWatchHistory(user)
              : () => adapter.getPlayback(user);

    let entries: PlaybackEntry[];
    try {
        entries = await read();
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'playback read failed; degrading');
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [adapter.id] };
    }

    const shaped = applyLimit(entries, opts.limit, opts.offset);
    return { ...shaped, items: shaped.items.map(e => project(e, opts.detail)), degraded: [] };
}

/**
 * `note` replaces the counts rather than being appended to them: a correction
 * printed behind "0 item(s) playing now" leaves the claim standing, which is
 * the reading it exists to prevent. `degraded` already works this way.
 */
export const summarize = (scope: PlaybackScope, result: GetPlaybackResult): string => {
    if (result.note !== undefined) return result.note;
    if (result.degraded.length > 0)
        return `${result.degraded.join(', ')} could not be reached; no playback information available.`;
    if (scope === 'next_up') return `${result.total} series with a next episode to watch.`;
    if (scope === 'history') {
        const partial = result.items.filter(i => i.kind === 'partially_watched').length;
        return partial === 0
            ? `${result.total} recently watched item(s).`
            : `${result.total} recently watched item(s); ${partial} of those shown stopped partway.`;
    }
    const playing = result.items.filter(i => i.kind === 'now_playing').length;
    return `${playing} item(s) playing now, ${result.total - playing} to continue.`;
};

/**
 * One playback row as a line. `kind` leads because a `now_playing` row and a
 * `resume` row mean quite different things and the scope alone does not
 * separate them — `scope: "active"` returns both.
 *
 * `user` is named on every row: `allow_other_users` lets one call span a
 * household, and a progress figure with no name against it invites the model
 * to attribute it to whoever asked.
 */
export function playbackLine(entry: PlaybackEntry): string {
    const numbering =
        entry.season === undefined || entry.episode === undefined
            ? ''
            : ` ${episodeCode(entry.season, entry.episode)}`;
    const name =
        entry.seriesTitle === undefined ? entry.title : `${entry.seriesTitle}${numbering} ${entry.title}`;

    const facts = [entry.kind, entry.user];
    if (entry.percentComplete !== undefined) facts.push(`${Math.round(entry.percentComplete)}%`);
    if (entry.device !== undefined && entry.device !== '') facts.push(entry.device);
    // Said on the row: an `activity_log` play is the server's log, not its
    // played flag, and a cleanup tool keyed on that flag will not see it.
    if (entry.source === 'activity_log')
        facts.push(entry.removedFromLibrary === true ? 'from activity log, since removed from library' : 'from activity log, not marked played');

    return `${name} — ${facts.join(', ')}`;
}

const getPlaybackInput = byMediaServers(ids => toolInput({
    detail: DetailSchema,
    limit: LimitSchema,
    offset: OffsetSchema,
    user: UserSchema,
    scope: ScopeSchema,
    ...serviceInput(ids)
}));

const GetPlaybackOutput = PagedOutputSchema.extend({
    note: z
        .string()
        .optional()
        .describe(
            "Present when a fact about the stack's config, not this call, needs stating: for example no media server configured at all."
        )
});

export function registerGetPlayback(server: McpServer, servers: MediaServers): void {
    server.registerTool(
        'get_playback',
        {
            title: 'Playback activity',
            annotations: READ_ONLY,
            description:
                'What a media-server user is watching, has next, or has watched; watch state exists only on the media server. `scope: "active"` (default): now playing and resumable, with position. `"next_up"`: the next unwatched episode of each series in progress. `"history"`: recent plays, newest first; [[jellyfin: on Jellyfin it includes plays from its activity log that were never marked played (an offline client syncing back), tagged `source: "activity_log"`, as far back as Jellyfin keeps the log (30 days by default).]] Defaults to the configured user; another needs allow_other_users. With no media server configured every scope is empty and `note` says why: report that rather than saying nothing is playing. Field reference: arr://docs/get_playback.' +
                withBoth(
                    bothIds(servers),
                    'With two media servers configured, `service` picks one; it defaults to the primary. Call once per server for everything playing everywhere.'
                ),
            outputSchema: GetPlaybackOutput,
            inputSchema: getPlaybackInput(bothIds(servers))
        },
        async ({ detail, limit, offset, user, scope, service }) => {
            const chosen = pickMediaServer(servers, service);
            const result = await buildGetPlayback(chosen?.adapter, chosen?.identity, {
                detail,
                limit,
                offset,
                scope,
                ...(user === undefined ? {} : { user })
            });

            return {
                content: [{ type: 'text', text: listText(summarize(scope, result), result.items, playbackLine) }],
                structuredContent: result
            };
        }
    );
}
