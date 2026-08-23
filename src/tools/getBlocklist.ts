import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { gather } from '../core/gather.ts';
import {
    DetailSchema,
    LimitSchema,
    OffsetSchema,
    PagedOutputSchema,
    READ_ONLY,
    applyLimit,
    toolInput,
    type DetailLevel
} from '../core/shape.ts';
import { hasBlocklist, type BlocklistCapable, type BlocklistEntry, type ServiceAdapter } from '../services/types.ts';

export type GetBlocklistResult = {
    items: BlocklistEntry[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    counts: Record<string, number>;
};

/** `minimal` keeps what a scan needs — which release, from where, and when.
 *  `reason` is the longest field and the one worth reading closely, so it is
 *  the first to go. */
const project = (b: BlocklistEntry, detail: DetailLevel): BlocklistEntry => {
    if (detail === 'minimal') {
        return { service: b.service, id: b.id, title: b.title, at: b.at, ...(b.indexer === undefined ? {} : { indexer: b.indexer }) };
    }
    if (detail === 'standard') {
        const { protocol: _protocol, ...rest } = b;
        return rest;
    }
    return b;
};

export async function buildGetBlocklist(
    adapters: readonly ServiceAdapter[],
    opts: { service?: ServiceId; instance?: string; detail: DetailLevel; limit: number; offset?: number }
): Promise<GetBlocklistResult> {
    let scoped: (ServiceAdapter & BlocklistCapable)[];
    if (opts.service === undefined) {
        scoped = adapters.filter(hasBlocklist);
    } else {
        const adapter = resolveInstance(adapters, opts.service, opts.instance);
        // Answering empty for a service that has no blocklist would read as
        // "nothing is blocklisted", which is a different claim.
        if (!hasBlocklist(adapter)) {
            throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no blocklist`, {
                remedy: 'Only radarr and sonarr keep a blocklist. The download clients have none — a release they refused was refused by the *arr that queued it.'
            });
        }
        scoped = [adapter];
    }

    const { items, degraded, counts } = await gather(scoped.map(a => ({ id: a.id, fetch: () => a.readBlocklist() })));

    // Newest first: a blocklist is read to explain something that just went
    // wrong, and the row that explains it is almost always the last one added.
    const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
    const shaped = applyLimit(sorted, opts.limit, opts.offset);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
}

export function registerGetBlocklist(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_blocklist',
        {
            title: 'Blocklisted releases',
            annotations: READ_ONLY,
            description:
                'Why a release keeps getting skipped. Lists what Radarr and Sonarr have blocklisted — releases they will not grab again — with the reason each was blocklisted, usually relayed from the download client. This is the answer to "it keeps finding the same thing and never downloading it", which `get_history` shows as a repeating grab-then-fail and nothing explains. Rows carry `mediaId` for get_media_details, and `id` for remove_blocklist_item. Newest first. Radarr and Sonarr only — the download clients have no blocklist of their own.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                service: ServiceIdSchema.optional().describe('Scope to one service. Omit to merge Radarr and Sonarr.'),
                instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ service, instance, detail, limit, offset }) => {
            const result = await buildGetBlocklist(adapters, {
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                detail,
                limit,
                offset
            });

            const summary =
                `${result.returned} of ${result.total} blocklisted release${result.returned === 1 ? '' : 's'}` +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
