import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import type { IdentityResolver } from '../core/identity.ts';
import {
    hasRequestCreate,
    hasRequestManage,
    hasRequests,
    type RequestCreateCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * "Can you request the new season?" — the polite half of adding something.
 *
 * The line against `add_media` is the point of having both. This goes through
 * Seerr, so it lands in whoever's approval queue and quota the household has
 * configured; `add_media` writes straight into Radarr or Sonarr and bypasses
 * all of that. A model asked to *request* something should reach for this one.
 *
 * `safe` tier: a request is a record, and Seerr can delete it again.
 */

/** The identity gate is not optional here — a request always lands in
 *  somebody's name — so an unconfigured resolver is a refusal, not a default. */
const requireIdentity = (identity: IdentityResolver | undefined): IdentityResolver => {
    if (identity === undefined) {
        throw new ServiceError('NotFound', 'seerr', 'seerr is not configured', {
            remedy: 'Add a services.seerr block to config.yaml and restart.'
        });
    }
    return identity;
};

const seerrAdapter = (adapters: readonly ServiceAdapter[]): ServiceAdapter & RequestCreateCapable => {
    const adapter = adapters.find(a => a.type === 'seerr');
    if (adapter === undefined) {
        throw new ServiceError('NotFound', 'seerr', 'seerr is not configured', {
            remedy: 'Add a services.seerr block to config.yaml and restart. Requests live in Seerr — to add a title straight to Radarr or Sonarr instead, use add_media.'
        });
    }
    if (!hasRequestCreate(adapter)) {
        throw new ServiceError('NotFound', 'seerr', 'this seerr adapter cannot create requests');
    }
    return adapter;
};

export function registerRequestMedia(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    identity: IdentityResolver | undefined
): void {
    registerWriteTool(server, context, {
        name: 'request_media',
        title: 'Request a film or series',
        description:
            'Asks Seerr for a film or series, the way a household member would through its web UI — it enters the approval queue and counts against that user\'s quota. This is the tool for "request X". It is not add_media: add_media writes straight into Radarr or Sonarr, skipping approval and quota entirely, and needs that service\'s own write permission. `media_id` is a TMDB id — take one from search_media, lookup_media or discover_media; Seerr resolves the TVDB id itself. For a series, `seasons` defaults to every season. `user` names whose quota and approval trail it lands in, and requesting as anyone but the configured default user needs services.seerr.allow_other_users. Previews by default — call again with the returned `confirm` token to create the request.',
        inputSchema: z.object({
            media_type: z.enum(['movie', 'tv']).describe('movie or tv.'),
            media_id: z.number().int().describe('The TMDB id. Not a Radarr, Sonarr or Jellyfin id — those will not resolve.'),
            seasons: z
                .array(z.number().int().min(0))
                .optional()
                .describe(
                    'Which seasons to request, for a series. Omit to request every season. Refused on a movie rather than ignored.'
                ),
            user: z
                .string()
                .optional()
                .describe(
                    'Whose request this is. Defaults to services.seerr.default_user; naming anyone else needs services.seerr.allow_other_users.'
                )
        }),
        service: 'seerr',
        operation: 'request_media',
        tier: 'safe',

        async plan({ media_type, media_id, seasons, user }): Promise<WritePlan> {
            const adapter = seerrAdapter(adapters);

            // Films have no seasons. Accepting the argument and dropping it is
            // how someone believes they requested one season of something.
            if (media_type === 'movie' && seasons !== undefined) {
                throw new ServiceError('NotFound', 'seerr', 'a movie has no seasons', {
                    remedy: 'Drop `seasons` for a film, or set media_type to tv.'
                });
            }

            // The gate runs before anything is created, and reads
            // configuration only — no value Seerr returns can widen it.
            const requester = await requireIdentity(identity).resolve(user);

            // Seerr does not refuse a duplicate: a second request for the same
            // media creates a second row. So "already requested" is answered
            // here, and answered as a no-op — a confirmation prompt for a
            // no-op trains a model to confirm reflexively.
            if (!hasRequests(adapter)) {
                throw new ServiceError('NotFound', 'seerr', 'this seerr adapter cannot list requests');
            }
            const existing = (await adapter.getRequests({})).find(
                r => r.tmdbId === media_id && r.mediaType === media_type
            );

            // Seerr's request payload carries no title, so naming the media
            // takes a second lookup — the same one the other request previews
            // pay for, and for the same reason: "request 438631" is not
            // something anyone can approve.
            const media = hasRequestManage(adapter)
                ? await adapter.describeRequestMedia({
                      service: adapter.id,
                      id: 0,
                      status: 'unknown',
                      mediaType: media_type,
                      tmdbId: media_id,
                      requestedBy: requester.name
                  })
                : undefined;
            const label =
                media === undefined
                    ? `${media_type === 'movie' ? 'movie' : 'series'} ${media_id} (title unavailable)`
                    : `${media.title}${media.year === undefined ? '' : ` (${media.year})`}`;

            if (existing !== undefined) {
                return {
                    target: `seerr:${media_type}:${media_id}`,
                    summary: `${label} has already been requested by ${existing.requestedBy} (currently ${existing.status}).`,
                    effects: [],
                    noop: true
                };
            }

            const scope =
                media_type === 'movie'
                    ? ''
                    : seasons === undefined
                      ? ' (every season)'
                      : ` (season${seasons.length === 1 ? '' : 's'} ${seasons.join(', ')})`;

            return {
                target: `seerr:${media_type}:${media_id}`,
                summary: `Request ${label}${scope} from Seerr as ${requester.name}.`,
                effects: [
                    `Creates a Seerr request in ${requester.name}'s name, counting against their quota and appearing in their request history.`,
                    'If Seerr auto-approves it, Radarr or Sonarr starts searching immediately — that uses disk space and bandwidth.',
                    'The request can be withdrawn again with delete_request.'
                ],
                // `seasons` is effect-bearing, so it is bound: a token issued
                // for one season must not apply to the whole series.
                args: {
                    mediaType: media_type,
                    mediaId: media_id,
                    userId: requester.id,
                    ...(seasons === undefined ? {} : { seasons })
                }
            };
        },

        async apply(_plan, { media_type, media_id, seasons, user }) {
            const adapter = seerrAdapter(adapters);
            const requester = await requireIdentity(identity).resolve(user);

            const created = await adapter.createRequest({
                mediaType: media_type,
                mediaId: media_id,
                // `'all'` rather than omitted: a live Seerr answers HTTP 500
                // for a tv request with no seasons at all.
                ...(media_type === 'tv' ? { seasons: seasons ?? 'all' } : {}),
                userId: Number(requester.id)
            });

            return { id: created.id, status: created.status };
        }
    });
}
