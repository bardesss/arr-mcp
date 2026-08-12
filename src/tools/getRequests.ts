import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { IdentityResolver } from '../core/identity.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import type { SeerrAdapter } from '../services/seerr.ts';
import type { MediaRequest, RequestStatus } from '../services/types.ts';
import { UserSchema } from './getPlayback.ts';

export type GetRequestsResult = {
    items: MediaRequest[];
    total: number;
    returned: number;
    truncated: boolean;
    degraded: string[];
};

const StatusSchema = z
    .enum(['pending', 'approved', 'declined'])
    .optional()
    .describe('Only requests in this state. Omit for all.');

const project = (r: MediaRequest, detail: DetailLevel): MediaRequest => {
    if (detail === 'full') return r;
    if (detail === 'minimal') {
        return { service: r.service, id: r.id, status: r.status, mediaType: r.mediaType, requestedBy: r.requestedBy };
    }
    return r;
};

export async function buildGetRequests(
    adapter: SeerrAdapter | undefined,
    resolver: IdentityResolver | undefined,
    opts: { detail: DetailLevel; limit: number; user?: string; status?: RequestStatus }
): Promise<GetRequestsResult> {
    if (adapter === undefined || resolver === undefined) {
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [] };
    }

    // Outside the try, for the same reason as get_playback: a refusal must
    // reach the model as a refusal, not as an outage.
    const user = await resolver.resolve(opts.user);

    let requests: MediaRequest[];
    try {
        requests = await adapter.getRequests({
            user,
            ...(opts.status === undefined ? {} : { status: opts.status })
        });
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'request read failed; degrading');
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [adapter.id] };
    }

    const shaped = applyLimit(requests, opts.limit);
    return { ...shaped, items: shaped.items.map(r => project(r, opts.detail)), degraded: [] };
}

export function registerGetRequests(
    server: McpServer,
    adapter: SeerrAdapter | undefined,
    resolver: IdentityResolver | undefined
): void {
    server.registerTool(
        'get_requests',
        {
            description:
                'Media requests in Seerr — pending, approved or declined — for one user. Defaults to the configured user; reading another requires allow_other_users.',
            inputSchema: toolInput({
                detail: DetailSchema,
                limit: LimitSchema,
                user: UserSchema,
                status: StatusSchema
            })
        },
        async ({ detail, limit, user, status }) => {
            const result = await buildGetRequests(adapter, resolver, {
                detail,
                limit,
                ...(user === undefined ? {} : { user }),
                ...(status === undefined ? {} : { status })
            });
            const pending = result.items.filter(r => r.status === 'pending').length;
            const summary =
                result.degraded.length > 0
                    ? 'Seerr could not be reached; no request information available.'
                    : `${result.returned} of ${result.total} request(s)${pending > 0 ? `, ${pending} pending` : ''}.`;

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
