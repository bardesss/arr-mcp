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
    /**
     * Instances whose rejection history could not be read, while their
     * indexers could.
     *
     * Not `degraded`: the indexers themselves answered, so the instance is not
     * degraded. But with two Prowlarrs, one failing here leaves
     * `recentRejections` present, plausible and missing half the stack, which
     * reads exactly like a complete history. #200 put `service` on every
     * rejection so a merged list could say which Prowlarr refused a query; this
     * is the same argument for saying which one never answered.
     *
     * Present only at detail: full, and only when something actually failed.
     */
    rejectionsUnavailable?: string[];
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
    const rejectionsUnavailable: string[] = [];
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
                rejectionsUnavailable.push(adapter.id);
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

    // Rejections are time-ordered; each instance answers its own newest-first,
    // but as they settle in whatever order the promises resolve. Re-sort the
    // merge, and re-apply the limit that bounded each instance alone.
    const mergedRejections = rejections
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, opts.limit);

    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        disabledCount,
        degraded: degraded.sort(),
        ...(sawRejections ? { recentRejections: mergedRejections } : {}),
        ...(rejectionsUnavailable.length === 0 ? {} : { rejectionsUnavailable: rejectionsUnavailable.sort() })
    };
}

/**
 * Total failure is claimed only when every configured instance degraded —
 * `degraded.length === instanceCount`, not `result.total === 0`. A healthy
 * instance with no indexers configured also has `total === 0`, and pairing it
 * with one degraded instance must not read as "nothing could be reached."
 */
export const summarizeIndexers = (result: GetIndexersResult, instanceCount: number): string => {
    const disabled = result.disabledCount;
    if (result.degraded.length > 0 && result.degraded.length === instanceCount)
        return `${result.degraded.join(', ')} could not be reached; no indexer information available.`;
    // The unavailable-history note rides on the sentence rather than only in
    // the structure, because the failure it describes is invisible: a short
    // rejection list looks like a quiet week.
    const partial =
        result.rejectionsUnavailable === undefined
            ? ''
            : result.recentRejections === undefined
              ? ` Rejection history could not be read for ${result.rejectionsUnavailable.join(', ')}, so none is reported.`
              : ` Rejection history is missing for ${result.rejectionsUnavailable.join(', ')}, so the list below is partial.`;
    return `${result.returned} of ${result.total} indexer(s)${disabled > 0 ? `, ${disabled} temporarily disabled` : ''}${result.degraded.length > 0 ? `. ${result.degraded.join(', ')} could not be reached` : ''}.${partial}`;
};

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
            const summary = summarizeIndexers(result, adapters.length);

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
