import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION } from './resolveInstance.ts';
import { type ServiceId, serviceOf } from '../config/schema.ts';
import { gather } from '../core/gather.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, listText, toolInput, windowEnd, type DetailLevel, unreachableTail } from '../core/shape.ts';
import { hasBlocklist, type BlocklistEntry, type ServiceAdapter } from '../services/types.ts';
import { readTargets, serviceTarget } from './serviceTarget.ts';

type GetBlocklistResult = {
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

/**
 * One blocklist row as a line. `service:id` is what `remove_blocklist_item`
 * takes, and the reason is the whole point of the row — a blocklist without
 * reasons is a list of things that failed for no stated cause.
 */
export function blocklistLine(entry: BlocklistEntry): string {
    const facts = [`${entry.service}:${entry.id}`, entry.at];
    if (entry.indexer !== undefined && entry.indexer !== '') facts.push(entry.indexer);
    if (entry.reason !== undefined && entry.reason !== '') facts.push(entry.reason);

    return `${entry.title} — ${facts.join(', ')}`;
}

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    can: hasBlocklist,
    cannot: 'has no blocklist',
    hint: 'The download clients have none — a release they refused was refused by the *arr that queued it.'
});

export async function buildGetBlocklist(
    adapters: readonly ServiceAdapter[],
    opts: { service?: ServiceId; instance?: string; detail: DetailLevel; limit: number; offset?: number }
): Promise<GetBlocklistResult> {
    // Each service hands over its newest `want` rows and says how many it has,
    // so a small window is not the whole list read and thrown away.
    const want = windowEnd(opts.limit, opts.offset);
    const { items, degraded, counts } = await gather(
        readTargets(adapters, TARGET, opts.service, opts.instance).map(a => ({ id: a.id, fetch: () => a.readBlocklist(want) }))
    );
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

    // Newest first: a blocklist is read to explain something that just went
    // wrong, and the row that explains it is almost always the last one added.
    const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
    const shaped = applyLimit(sorted, opts.limit, opts.offset, total);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
}

const GetBlocklistInput = toolInput({
    service: serviceOf(TARGET.services).optional().describe('Scope to one service. Omit to merge them all.'),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    detail: DetailSchema,
    limit: LimitSchema,
    offset: OffsetSchema
});

export function registerGetBlocklist(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_blocklist',
        {
            title: 'Blocklisted releases',
            annotations: READ_ONLY,
            description:
                'Why a release keeps getting skipped. Lists what each *arr has blocklisted — releases they will not grab again — with the reason each was blocklisted, usually relayed from the download client. This is the answer to "it keeps finding the same thing and never downloading it", which `get_history` shows as a repeating grab-then-fail and nothing explains. Rows carry `mediaId` for get_media_details[[lidarr:  (an artist id on a Lidarr row)]], and `id` for remove_blocklist_item. Newest first. *arrs only — the download clients have no blocklist of their own.',
            outputSchema: PagedOutputSchema,
            inputSchema: GetBlocklistInput
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
                unreachableTail(result.degraded);

            return { content: [{ type: 'text', text: listText(summary, result.items, blocklistLine) }], structuredContent: result };
        }
    );
}
