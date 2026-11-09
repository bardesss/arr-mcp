import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, listText, toolInput, type DetailLevel, unreachableTail } from '../core/shape.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import type { LibraryKind } from '../core/resolver.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { MediaKindSchema } from './mediaKind.ts';
import { mediaCardsToolMeta, wantsCards, withCards } from '../mcp/apps.ts';
import { buildSearchMedia, buildSearchMediaWithCards, searchLine, type GetSearchResult } from './searchMedia.ts';

export function lookupSummary(result: Pick<GetSearchResult, 'total' | 'returned' | 'degraded'>, query: string): string {
    return (
        (result.total === 0 ? `Nothing found for "${query}"` : `${result.returned} of ${result.total} match(es) for "${query}"`) +
        unreachableTail(result.degraded)
    );
}

/**
 * `search_media` with `source` fixed to `discover`.
 *
 * A separate tool rather than a parameter because the two answer different
 * questions, and lists them separately. The tool surface is
 * the public API, and a model choosing between "search my library" and "tell
 * me about this" should not have to reason about an enum to do it.
 */
export async function buildLookupMedia(
    adapters: readonly ServiceAdapter[],
    opts: { query: string; detail: DetailLevel; limit: number; offset?: number; kinds?: readonly LibraryKind[] },
    dataset?: ImdbDataset
): Promise<GetSearchResult> {
    return buildSearchMedia(adapters, { ...opts, source: 'discover' }, dataset);
}

export function registerLookupMedia(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    dataset?: ImdbDataset,
    /** `tools.media_cards`. */
    mediaCards = true
): void {
    server.registerTool(
        'lookup_media',
        {
            title: 'Look up a title externally',
            annotations: READ_ONLY,
            ...(mediaCards ? { _meta: mediaCardsToolMeta() } : {}),
            description:
                'Metadata for something you may not have: title, year, and external ids, from Radarr, Sonarr, Whisparr, Lidarr and Seerr, plus books from Shelfmark (`kind: book`, whose id get_releases takes). A Lidarr hit is an artist, keyed by its MusicBrainz id under `ids.mbid`, which is what add_media takes for Lidarr. Query imdb:tt… to turn an IMDb id into a TMDB id; a bare tt… misses Seerr. Nothing is added; that is add_media or request_media. To browse without a title, use discover_media.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                query: z.string().min(1).describe('What to look up. A trailing year ("Title 2027") ranks that year first.'),
                kind: MediaKindSchema,
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ query, kind, detail, limit, offset }, ctx) => {
            const { result, cards } = await buildSearchMediaWithCards(
                adapters,
                { query, detail, limit, offset, source: 'discover', ...(kind === undefined ? {} : { kinds: [kind] }) },
                dataset,
                wantsCards(mediaCards, server, ctx)
            );
            const summary = lookupSummary(result, query);

            return withCards({ content: [{ type: 'text' as const, text: listText(summary, result.items, searchLine) }], structuredContent: result }, cards);
        }
    );
}
