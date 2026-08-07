import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import {
    hasRequestManage,
    hasRequests,
    type MediaRequest,
    type RequestManageCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Seerr request management, as **two** tools rather than one with an `action`
 * of three values.
 *
 * The split is the permission tier. Approving and declining move a request
 * between states it can be moved back out of — including by this same tool —
 * so they are `safe`. Deleting destroys the record, so it is `destructive`.
 * A single tool spanning both would have to derive its tier from an argument,
 * which means the tier stops being a statically reviewable property of the
 * tool and becomes something you have to trace an enum to work out. The tier
 * boundary is the tool boundary.
 */

const seerrAdapter = (adapters: readonly ServiceAdapter[]): ServiceAdapter & RequestManageCapable => {
    const adapter = adapters.find(a => a.type === 'seerr');
    if (adapter === undefined) {
        throw new ServiceError('NotFound', 'seerr', 'seerr is not configured', {
            remedy: 'Add a services.seerr block to config.yaml and restart. Requests live in Seerr, not in Radarr or Sonarr.'
        });
    }
    if (!hasRequestManage(adapter)) {
        throw new ServiceError('NotFound', 'seerr', 'this seerr adapter cannot manage requests');
    }
    return adapter;
};

/**
 * Requests are read back by id from the live list rather than trusted from the
 * argument, for the same reason every other write tool reads first: so the
 * preview names a film and a person, and so a stale id fails here rather than
 * as a bare 404.
 */
async function findRequest(adapters: readonly ServiceAdapter[], id: string): Promise<MediaRequest> {
    const adapter = adapters.find(a => a.type === 'seerr');
    if (adapter === undefined || !hasRequests(adapter)) {
        throw new ServiceError('NotFound', 'seerr', 'seerr is not configured', {
            remedy: 'Add a services.seerr block to config.yaml and restart.'
        });
    }

    const found = (await adapter.getRequests({})).find(r => String(r.id) === id);
    if (found === undefined) {
        throw new ServiceError('NotFound', 'seerr', `no Seerr request has id "${id}"`, {
            remedy: 'It may already have been deleted. Call get_requests for a current list.'
        });
    }
    return found;
}

/**
 * Seerr's request payload carries no title (see `describeRequestMedia`), so
 * naming the media takes a second lookup. Worth it here and nowhere else: this
 * string is what someone approves or refuses, and "request 19, requested by
 * Sam" does not tell them whether they are about to delete a request for a
 * children's film or a box set.
 *
 * Falls back to the id when the lookup cannot answer, and says so, rather than
 * quietly presenting a bare id as though that were the whole story.
 */
async function describe(adapters: readonly ServiceAdapter[], request: MediaRequest): Promise<string> {
    const adapter = adapters.find(a => a.type === 'seerr');
    const media =
        adapter !== undefined && hasRequestManage(adapter)
            ? await adapter.describeRequestMedia(request)
            : undefined;

    if (media === undefined) {
        const kind = request.mediaType === 'unknown' ? 'media' : request.mediaType;
        return `request ${request.id} (${kind}, title unavailable), requested by ${request.requestedBy}`;
    }
    return `${media.title}${media.year === undefined ? '' : ` (${media.year})`}, requested by ${request.requestedBy}`;
}

export function registerRespondToRequest(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'respond_to_request',
        description:
            'Approves or declines a pending Seerr request. Approving hands it to Radarr or Sonarr, which will search for it and download it — so it costs disk space and bandwidth even though the decision itself is reversible. Take `id` from get_requests. Previews by default — call again with the returned `confirm` token to actually apply the verdict.',
        inputSchema: z.object({
            id: z.string().min(1).describe('The Seerr request id, as get_requests reported it.'),
            verdict: z.enum(['approve', 'decline']).describe('approve or decline.')
        }),
        service: 'seerr',
        operation: 'respond_to_request',
        tier: 'safe',

        async plan({ id, verdict }): Promise<WritePlan> {
            const request = await findRequest(adapters, id);
            const label = await describe(adapters, request);
            const target = verdict === 'approve' ? 'approved' : 'declined';

            // Re-approving an approved request is not an error, but it is not
            // an action either — and asking someone to confirm a no-op teaches
            // them to confirm without reading.
            if (request.status === target) {
                return {
                    target: `seerr:${id}`,
                    summary: `${label} is already ${target}.`,
                    effects: [],
                    noop: true
                };
            }

            const effects =
                verdict === 'approve'
                    ? [
                          'Hands the request to Radarr or Sonarr, which will search for it and start downloading — this uses disk space and bandwidth.',
                          `Marks the request approved. ${request.requestedBy} will see it as accepted.`
                      ]
                    : [
                          `Marks the request declined. ${request.requestedBy} will see it as rejected.`,
                          'Downloads nothing. Anything already downloaded for it is left alone.'
                      ];

            return {
                target: `seerr:${id}`,
                summary: `${verdict === 'approve' ? 'Approve' : 'Decline'} ${label} (currently ${request.status}).`,
                effects,
                args: { id, verdict }
            };
        },

        async apply(_plan, { id, verdict }) {
            // Reports what the request *became*, read back from Seerr's own
            // response, rather than echoing what was asked for.
            const updated = await seerrAdapter(adapters).respondToRequest(id, verdict);
            return { id: updated.id, status: updated.status };
        }
    });
}

export function registerDeleteRequest(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'delete_request',
        description:
            'Deletes a Seerr request record entirely. This removes the request, not the media — anything already downloaded stays on disk and in Radarr or Sonarr. Use respond_to_request with `decline` to refuse a request while keeping the record. Take `id` from get_requests. Previews by default — call again with the returned `confirm` token to actually delete it.',
        inputSchema: z.object({
            id: z.string().min(1).describe('The Seerr request id, as get_requests reported it.')
        }),
        service: 'seerr',
        operation: 'delete_request',
        tier: 'destructive',

        async plan({ id }): Promise<WritePlan> {
            const request = await findRequest(adapters, id);
            const label = await describe(adapters, request);

            return {
                target: `seerr:${id}`,
                summary: `Delete the Seerr request for ${label} (currently ${request.status}).`,
                effects: [
                    'Removes the request record from Seerr. This cannot be undone — the request would have to be made again.',
                    // The distinction people get wrong, stated before they act
                    // rather than discovered after: this is not delete_media.
                    'Does NOT delete any media. Anything already downloaded stays on disk and in Radarr or Sonarr — use delete_media for that.',
                    `${request.requestedBy} will no longer see this request at all.`
                ],
                args: { id }
            };
        },

        async apply(_plan, { id }) {
            await seerrAdapter(adapters).deleteRequest(id);
            return { deleted: `seerr:${id}` };
        }
    });
}
