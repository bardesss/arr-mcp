import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { IdentityResolver } from '../core/identity.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import type { JellyfinAdapter } from '../services/jellyfin.ts';
import type { PlaybackEntry } from '../services/types.ts';

export type GetPlaybackResult = {
    items: PlaybackEntry[];
    total: number;
    returned: number;
    truncated: boolean;
    degraded: string[];
};

export const UserSchema = z
    .string()
    .min(1)
    .optional()
    .describe(
        'Whose playback to read. Defaults to the configured default_user; any other value requires allow_other_users.'
    );

const project = (e: PlaybackEntry, detail: DetailLevel): PlaybackEntry => {
    if (detail === 'full') return e;
    if (detail === 'minimal') {
        return { service: e.service, kind: e.kind, itemId: e.itemId, title: e.title, user: e.user };
    }
    const { device: _d, lastPlayed: _l, ...rest } = e;
    return rest;
};

export async function buildGetPlayback(
    adapter: JellyfinAdapter | undefined,
    resolver: IdentityResolver | undefined,
    opts: { detail: DetailLevel; limit: number; offset?: number; user?: string }
): Promise<GetPlaybackResult> {
    if (adapter === undefined || resolver === undefined) {
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [] };
    }

    // Deliberately outside the try: an authorization or configuration failure
    // must reach the caller as an error, not be flattened into `degraded`.
    // A model told "Jellyfin is down" when it was actually refused will retry
    // forever; one told it was refused will not.
    const user = await resolver.resolve(opts.user);

    let entries: PlaybackEntry[];
    try {
        entries = await adapter.getPlayback(user);
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'playback read failed; degrading');
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [adapter.id] };
    }

    const shaped = applyLimit(entries, opts.limit, opts.offset);
    return { ...shaped, items: shaped.items.map(e => project(e, opts.detail)), degraded: [] };
}

export function registerGetPlayback(
    server: McpServer,
    adapter: JellyfinAdapter | undefined,
    resolver: IdentityResolver | undefined
): void {
    server.registerTool(
        'get_playback',
        {
            description:
                'What a Jellyfin user is watching now and what they can continue watching, with position and completion. Watch state exists only in Jellyfin — Radarr and Sonarr have no concept of it. Defaults to the configured user; reading another requires allow_other_users.',
            inputSchema: toolInput({ detail: DetailSchema, limit: LimitSchema, offset: OffsetSchema, user: UserSchema })
        },
        async ({ detail, limit, offset, user }) => {
            const result = await buildGetPlayback(adapter, resolver, {
                detail,
                limit,
                offset,
                ...(user === undefined ? {} : { user })
            });
            const playing = result.items.filter(i => i.kind === 'now_playing').length;
            const summary =
                result.degraded.length > 0
                    ? 'Jellyfin could not be reached; no playback information available.'
                    : `${playing} item(s) playing now, ${result.total - playing} to continue.`;

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
