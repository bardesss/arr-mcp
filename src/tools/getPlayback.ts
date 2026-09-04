import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { IdentityResolver } from '../core/identity.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import { NO_MEDIA_SERVER_NOTE, type MediaServerAdapter, type PlaybackEntry } from '../services/types.ts';

export type GetPlaybackResult = {
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
        'Whose playback to read. Defaults to the configured default_user; any other value requires allow_other_users.'
    );

export type PlaybackScope = 'active' | 'next_up' | 'history';

export const ScopeSchema = z
    .enum(['active', 'next_up', 'history'])
    .default('active')
    .describe(
        '`active` (default): now playing and what can be resumed. `next_up`: the next unwatched episode of every ' +
            "series this user has in progress — your media server's own answer to what to watch next. `history`: " +
            'recently watched movies and episodes, newest first.'
    );

const project = (e: PlaybackEntry, detail: DetailLevel): PlaybackEntry => {
    if (detail === 'full') return e;
    if (detail === 'minimal') {
        return { service: e.service, kind: e.kind, itemId: e.itemId, title: e.title, user: e.user };
    }
    const { device: _d, lastPlayed: _l, ...rest } = e;
    // `lastPlayed` is the one field `history` exists to answer, so a watched
    // entry keeps it even at standard detail. `active` and `next_up` entries
    // never carry `kind: 'watched'`, so this cannot move their output.
    return e.kind === 'watched' && e.lastPlayed !== undefined ? { ...rest, lastPlayed: e.lastPlayed } : rest;
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
    if (scope === 'history') return `${result.total} recently watched item(s).`;
    const playing = result.items.filter(i => i.kind === 'now_playing').length;
    return `${playing} item(s) playing now, ${result.total - playing} to continue.`;
};

export function registerGetPlayback(
    server: McpServer,
    adapter: MediaServerAdapter | undefined,
    resolver: IdentityResolver | undefined
): void {
    server.registerTool(
        'get_playback',
        {
            title: 'Playback activity',
            annotations: READ_ONLY,
            description:
                'What a media server user is watching, has queued up next, or has already watched. Watch state exists only in your media server — Radarr and Sonarr have no concept of it. `scope: "active"` (default) is now playing and what can be resumed, with position and completion. `scope: "next_up"` is the next unwatched episode of every series this user has in progress. `scope: "history"` is recently watched movies and episodes, newest first. Defaults to the configured user; reading another requires allow_other_users. If no media server is configured at all, every scope answers zero with an empty `degraded` list — because nothing was asked, not because nothing is playing. `note` says so when that is the case; report that reason rather than telling the user their library is idle.',
            outputSchema: PagedOutputSchema.extend({
                note: z
                    .string()
                    .optional()
                    .describe(
                        "Present when a fact about the stack's config, not this call, needs stating — for example no media server configured at all."
                    )
            }),
            inputSchema: toolInput({
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema,
                user: UserSchema,
                scope: ScopeSchema
            })
        },
        async ({ detail, limit, offset, user, scope }) => {
            const result = await buildGetPlayback(adapter, resolver, {
                detail,
                limit,
                offset,
                scope,
                ...(user === undefined ? {} : { user })
            });

            return { content: [{ type: 'text', text: summarize(scope, result) }], structuredContent: result };
        }
    );
}
