import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceIdSchema } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { gather } from '../core/gather.ts';
import { LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput } from '../core/shape.ts';
import { hasWanted, type ServiceAdapter, type WantedCapable, type WantedItem, type WantedScope } from '../services/types.ts';

export type GetWantedResult = {
    items: WantedItem[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    counts: Record<string, number>;
};

const WantedScopeSchema = z
    .enum(['missing', 'upgradable'])
    .describe(
        '`missing`: monitored items with no file at all. `upgradable`: monitored items that have a file but not yet at the quality profile\'s cutoff. Required — the two answer different questions, and a default would silently hide one of them.'
    );

export async function buildGetWanted(
    adapters: readonly ServiceAdapter[],
    opts: {
        service?: ServiceId;
        instance?: string;
        scope: WantedScope;
        limit: number;
        offset?: number;
    }
): Promise<GetWantedResult> {
    let scoped: (ServiceAdapter & WantedCapable)[];
    if (opts.service === undefined) {
        scoped = adapters.filter(hasWanted);
    } else {
        const adapter = resolveInstance(adapters, opts.service, opts.instance);
        // A valid, configured service with no wanted list (e.g. Jellyfin) must
        // refuse rather than silently answer empty — an empty result reads as
        // "nothing is wanted", which is a different and more misleading claim
        // than "this service cannot answer that".
        if (!hasWanted(adapter)) {
            throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no wanted list to return`, {
                remedy: 'Only radarr and sonarr can answer get_wanted.'
            });
        }
        scoped = [adapter];
    }

    const { items, degraded, counts } = await gather(
        scoped.map(a => ({ id: a.id, fetch: () => a.readWanted(opts.scope) }))
    );

    const shaped = applyLimit(items, opts.limit, opts.offset);
    return { ...shaped, degraded, counts };
}

export function registerGetWanted(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_wanted',
        {
            title: 'Missing and upgradable',
            annotations: READ_ONLY,
            description:
                '`get_library` can say a movie is missing (`monitored` with no file), but not which episodes of a show are missing, and neither tool can say what already has a file but not yet the wanted quality. `get_wanted` answers both, from Radarr and Sonarr\'s own wanted lists. `scope: "missing"` is monitored items with no file; `scope: "upgradable"` is monitored items with a file below the quality profile\'s cutoff — both required, since a default would hide one. Sonarr rows carry `season`, `episode` and the episode\'s own `episodeTitle`, with `title` naming the show; Radarr rows are movies, and only ever set `title`. Sonarr\'s missing list is monitored-only, matching what "wanted" means here — an unmonitored gap will not appear.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                scope: WantedScopeSchema,
                service: ServiceIdSchema.optional().describe('Scope to one service.'),
                instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ scope, service, instance, limit, offset }) => {
            const result = await buildGetWanted(adapters, {
                scope,
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                limit,
                offset
            });
            const summary =
                `${result.returned} of ${result.total} ${scope} item${result.returned === 1 ? '' : 's'}` +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
