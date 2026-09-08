import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import type { IndexerCapable, IndexerRejection, IndexerSummary, ServiceAdapter } from '../services/types.ts';

export type GetIndexersResult = {
    items: IndexerSummary[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /** How many returned indexers are temporarily disabled. Counted before the
     *  detail projection, which drops `disabledUntil` at `minimal`. */
    disabledCount: number;
    /** the "recent rejections". Present only at detail: full. */
    recentRejections?: IndexerRejection[];
};

const project = (i: IndexerSummary, detail: DetailLevel): IndexerSummary => {
    if (detail === 'minimal') return { service: i.service, id: i.id, name: i.name, enabled: i.enabled } as IndexerSummary;
    if (detail === 'full') return i;

    const { queries: _q, grabs: _g, rejectedQueries: _rq, rejectedGrabs: _rg, ...rest } = i;
    return rest;
};

/**
 * Every configured Prowlarr, merged.
 *
 * A merged indexer list is the reason to run a second one, so this is a read
 * that spans instances rather than one that asks which to look in. One failing
 * degrades by name and the others still answer.
 */
export async function buildGetIndexers(
    adapters: readonly (ServiceAdapter & IndexerCapable)[],
    opts: { detail: DetailLevel; limit: number; offset?: number }
): Promise<GetIndexersResult> {
    if (adapters.length === 0) {
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [], disabledCount: 0 };
    }

    const indexers: IndexerSummary[] = [];
    const rejections: IndexerRejection[] = [];
    const degraded: string[] = [];
    let sawRejections = false;

    await Promise.all(
        adapters.map(async adapter => {
            try {
                indexers.push(...(await adapter.getIndexers()));
            } catch (err) {
                logger.warn({ service: adapter.id, err }, 'indexer read failed; degrading');
                degraded.push(adapter.id);
                return;
            }

            // Rejections only at full detail, and never allowed to fail the
            // call: a Prowlarr without a history endpoint still has indexers
            // worth reporting.
            if (opts.detail !== 'full') return;
            try {
                rejections.push(...(await adapter.getRecentRejections(opts.limit)));
                sawRejections = true;
            } catch (err) {
                logger.warn({ service: adapter.id, err }, 'rejection history unavailable; omitting');
            }
        })
    );

    // Sorted so two instances produce a stable order rather than whichever
    // answered first, which would make the output differ run to run.
    const shaped = applyLimit(
        indexers.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name)),
        opts.limit,
        opts.offset
    );

    // Counted before projecting: `minimal` strips `disabledUntil`, so counting
    // the projected items reported none disabled however many were.
    const disabledCount = shaped.items.filter(i => i.disabledUntil !== undefined).length;

    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        disabledCount,
        degraded: degraded.sort(),
        ...(sawRejections ? { recentRejections: rejections } : {})
    };
}

export function registerGetIndexers(
    server: McpServer,
    adapters: readonly (ServiceAdapter & IndexerCapable)[]
): void {
    server.registerTool(
        'get_indexers',
        {
            title: 'Indexers',
            annotations: READ_ONLY,
            description:
                'Prowlarr indexer health: which indexers are enabled, which are temporarily disabled and why, per-indexer query and grab counts, and — at detail: full — the queries indexers recently rejected and the reasons they gave. Failure messages and rejection reasons come from the indexer itself and are fenced as untrusted data.',
            outputSchema: PagedOutputSchema.extend({
                disabledCount: z
                    .number()
                    .describe(
                        'How many of the returned indexers are temporarily disabled. Counted before the detail projection, so it is right at every detail level.'
                    )
            }),
            inputSchema: toolInput({ detail: DetailSchema, limit: LimitSchema, offset: OffsetSchema })
        },
        async ({ detail, limit, offset }) => {
            const result = await buildGetIndexers(adapters, { detail, limit, offset });
            const disabled = result.disabledCount;
            const summary =
                result.degraded.length > 0 && result.total === 0
                    ? `${result.degraded.join(', ')} could not be reached; no indexer information available.`
                    : `${result.returned} of ${result.total} indexer(s)${disabled > 0 ? `, ${disabled} temporarily disabled` : ''}${result.degraded.length > 0 ? `. ${result.degraded.join(', ')} could not be reached` : ''}.`;

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
