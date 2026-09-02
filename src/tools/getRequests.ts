import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { IdentityResolver } from '../core/identity.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import type { SeerrAdapter } from '../services/seerr.ts';
import type { MediaIssue, MediaRequest, RequestStatus } from '../services/types.ts';
import { UserSchema } from './getPlayback.ts';

export type GetRequestsResult = {
    items: MediaRequest[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /**
     * What the household has reported as broken. A sibling list rather than a
     * second kind of `items` — the pattern `get_indexers` uses for its
     * rejections, and it leaves `items` meaning exactly what it always has.
     * Only at `detail: "full"`, and never a reason for the call to fail.
     */
    issues?: MediaIssue[];
};

const StatusSchema = z
    .enum(['pending', 'approved', 'declined'])
    .optional()
    .describe('Only requests in this state. Omit for all.');

/**
 * `standard` and `full` are deliberately the same shape: a request is five
 * short fields and a date, so there is nothing at `standard` worth trimming
 * that `minimal` does not already trim. The `full` guard that used to sit here
 * was identical to the fall-through and only made it look as though three
 * levels differed.
 */
const project = (r: MediaRequest, detail: DetailLevel): MediaRequest =>
    detail === 'minimal'
        ? { service: r.service, id: r.id, status: r.status, mediaType: r.mediaType, requestedBy: r.requestedBy }
        : r;

export async function buildGetRequests(
    adapter: SeerrAdapter | undefined,
    resolver: IdentityResolver | undefined,
    opts: { detail: DetailLevel; limit: number; offset?: number; user?: string; status?: RequestStatus }
): Promise<GetRequestsResult> {
    if (adapter === undefined || resolver === undefined) {
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [] };
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
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [adapter.id] };
    }

    // Only at `full`, and never allowed to fail the call: a Seerr without the
    // issues endpoint still has requests worth reporting, and "your requests
    // could not be read" would be the wrong thing to say about it.
    let issues: MediaIssue[] | undefined;
    if (opts.detail === 'full') {
        try {
            issues = await adapter.getIssues({ limit: opts.limit });
        } catch (err) {
            logger.warn({ service: adapter.id, err }, 'issue read failed; omitting');
        }
    }

    const shaped = applyLimit(requests, opts.limit, opts.offset);
    return {
        ...shaped,
        items: shaped.items.map(r => project(r, opts.detail)),
        degraded: [],
        ...(issues === undefined ? {} : { issues })
    };
}

export function registerGetRequests(
    server: McpServer,
    adapter: SeerrAdapter | undefined,
    resolver: IdentityResolver | undefined
): void {
    server.registerTool(
        'get_requests',
        {
            title: 'Requests',
            annotations: READ_ONLY,
            description:
                'Media requests in Seerr — pending, approved or declined — for one user. Defaults to the configured user; reading another requires allow_other_users. At `detail: "full"` it also returns `issues`: what your users have reported as broken (video, audio, subtitle), each with its newest comments. Issues are everyone\'s, not just this user\'s, and a Seerr that cannot answer for them still answers for the requests.',
            outputSchema: PagedOutputSchema.extend({
                issues: z
                    .array(z.unknown())
                    .optional()
                    .describe('What users reported as broken. Only at `detail: "full"`.')
            }),
            inputSchema: toolInput({
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema,
                user: UserSchema,
                status: StatusSchema
            })
        },
        async ({ detail, limit, offset, user, status }) => {
            const result = await buildGetRequests(adapter, resolver, {
                detail,
                limit,
                offset,
                ...(user === undefined ? {} : { user }),
                ...(status === undefined ? {} : { status })
            });
            const pending = result.items.filter(r => r.status === 'pending').length;
            const open = (result.issues ?? []).filter(i => i.status === 'open').length;
            const summary =
                result.degraded.length > 0
                    ? 'Seerr could not be reached; no request information available.'
                    : `${result.returned} of ${result.total} request(s)${pending > 0 ? `, ${pending} pending` : ''}.` +
                      (open > 0 ? ` ${open} open issue(s) reported.` : '');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
