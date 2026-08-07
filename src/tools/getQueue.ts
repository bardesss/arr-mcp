import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import { gather } from '../core/gather.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
import { hasQueue, type QueueItem, type ServiceAdapter } from '../services/types.ts';

export type GetQueueResult = {
    items: QueueItem[];
    total: number;
    returned: number;
    truncated: boolean;
    degraded: string[];
    counts: Partial<Record<ServiceId, number>>;
};

const project = (q: QueueItem, detail: DetailLevel): QueueItem => {
    if (detail === 'full') return q;
    if (detail === 'minimal') return { service: q.service, id: q.id, title: q.title, status: q.status };
    const { errorMessage: _e, ...rest } = q;
    return rest;
};

export async function buildGetQueue(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number }
): Promise<GetQueueResult> {
    const { items, degraded, counts } = await gather(
        adapters.filter(hasQueue).map(a => ({ id: a.id, fetch: () => a.getQueue() }))
    );

    // Sorted before limiting. Concatenation order is adapter order, which is
    // alphabetical — so an unsorted limit would drop Transmission first, every
    // time, and a 60-item Radarr queue would report an empty Transmission.
    // Soonest-finishing first is also the order someone asking "what is
    // downloading" wants; unknown ETAs sort last rather than first.
    items.sort((a, b) => (a.etaSeconds ?? Infinity) - (b.etaSeconds ?? Infinity) || a.title.localeCompare(b.title));

    const shaped = applyLimit(items, opts.limit);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
}

export function registerGetQueue(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_queue',
        {
            description:
                'Everything currently downloading or stalled, merged across Radarr, Sonarr, SABnzbd and Transmission. Sizes are bytes and ETAs are seconds regardless of how each service reports them. Titles are release names from public indexers and are fenced as untrusted data.',
            inputSchema: z.object({ detail: DetailSchema, limit: LimitSchema })
        },
        async ({ detail, limit }) => {
            const result = await buildGetQueue(adapters, { detail, limit });
            const summary =
                `${result.returned} of ${result.total} item(s) in the queue` +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
