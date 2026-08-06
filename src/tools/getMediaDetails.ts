import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { MergedItem } from '../core/resolver.ts';
import { DetailSchema, LimitSchema, type DetailLevel } from '../core/shape.ts';
import { hasMediaDetails, type MediaDetails, type ServiceAdapter } from '../services/types.ts';
import type { LibraryLoader } from './library.ts';

/**
 * Unlike the list tools, this one **throws rather than degrades**. A request
 * for one specific item either produced that item or did not, and an empty
 * success would read as "the item does not exist".
 */
export async function buildGetMediaDetails(
    adapters: readonly ServiceAdapter[],
    opts: { service: ServiceId; id: string; detail: DetailLevel; limit: number }
): Promise<MediaDetails> {
    const adapter = adapters.find(a => a.id === opts.service);
    if (adapter === undefined || !hasMediaDetails(adapter)) {
        throw new ServiceError('NotFound', opts.service, `${opts.service} is not configured`, {
            remedy: `Add services.${opts.service} to config.yaml, or name a configured service.`
        });
    }

    return adapter.getMediaDetails(opts.id, {
        includeEpisodes: opts.detail === 'full',
        episodeLimit: opts.limit
    });
}

export type MediaDetailsQuery = {
    query?: string;
    service?: ServiceId;
    id?: string;
    detail: DetailLevel;
    limit: number;
};

/**
 * The resolved form (§5.3): the merged record the join §8 exists for.
 *
 * Like the explicit form, it **throws rather than degrading**. A request for
 * one specific item either produced that item or did not, and an empty success
 * would read as "the item does not exist".
 */
export async function buildResolvedMediaDetails(loader: LibraryLoader, query: string): Promise<MergedItem> {
    const { index, degraded } = await loader.load();
    const [best] = index.search(query);

    if (best === undefined) {
        // `diagnose` (via its own `resolve` step) and `get_library` both hedge
        // this exact claim across a degraded load; this is the third consumer
        // of the same `LibraryLoader` snapshot, and answering confidently
        // across the same hole is not a different situation. Named services,
        // not just "something failed" — a model deciding whether to retry
        // needs to know which ones.
        const hedge =
            degraded.length === 0
                ? ''
                : ` ${degraded.join(', ')} could not be reached, so this may be incomplete rather than a real absence.`;
        throw new Error(
            `Nothing in your library matches "${query}".${hedge} Try search_media, which also looks at what you do not have yet.`
        );
    }
    return best;
}

/**
 * Two forms, both deliberate (§5.3). `query` returns the merged record;
 * `service` + `id` returns one service's raw view, which is how you inspect a
 * join that looks wrong and what `diagnose` needs when `presence` says the two
 * halves disagree.
 */
export async function resolveMediaDetails(
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader,
    opts: MediaDetailsQuery
): Promise<MediaDetails | MergedItem> {
    // The explicit id wins when both are given: an id is unambiguous and a
    // title is not.
    if (opts.service !== undefined && opts.id !== undefined) {
        return buildGetMediaDetails(adapters, {
            service: opts.service,
            id: opts.id,
            detail: opts.detail,
            limit: opts.limit
        });
    }

    if (opts.query === undefined) {
        // Not a ServiceError: no service failed, and ServiceError needs a
        // ServiceId that would misattribute the fault to one.
        throw new Error('Name either a query (a title) or both service and id.');
    }

    return buildResolvedMediaDetails(loader, opts.query);
}

export function registerGetMediaDetails(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader
): void {
    server.registerTool(
        'get_media_details',
        {
            description:
                'Everything known about one item. Give a title as `query` for the merged record — acquisition, watch state, ratings and presence joined across services — or `service` plus `id` for one service’s raw view, which is how you inspect a join that looks wrong — the explicit id wins if both are given. A series at detail: full also returns its episodes.',
            inputSchema: z.object({
                query: z.string().min(1).optional().describe('A title. Resolved through the library index.'),
                service: ServiceIdSchema.optional().describe('With `id`: one service’s own view.'),
                id: z.string().min(1).optional().describe("The item's id within that service."),
                detail: DetailSchema,
                limit: LimitSchema
            })
        },
        async ({ query, service, id, detail, limit }) => {
            const result = await resolveMediaDetails(adapters, loader, {
                ...(query === undefined ? {} : { query }),
                ...(service === undefined ? {} : { service }),
                ...(id === undefined ? {} : { id }),
                detail,
                limit
            });

            // `unknown` is not a place something is "present in" — it is the
            // absence of a confident answer (item 1 of the whole-phase
            // review), so it gets its own phrasing rather than reading as
            // "present in: unknown."
            const summary =
                'presence' in result
                    ? result.presence === 'unknown'
                        ? `${result.kind}, presence could not be determined.`
                        : `${result.kind}, present in: ${result.presence}.`
                    : `${result.kind} from ${result.service}` +
                      (result.episodeCount === undefined
                          ? '.'
                          : `, ${result.episodes?.length ?? 0} of ${result.episodeCount} episode(s).`);

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
