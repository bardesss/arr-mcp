import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DetailSchema, LimitSchema, type DetailLevel } from '../core/shape.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { buildSearchMedia, type GetSearchResult } from './searchMedia.ts';

/**
 * `search_media` with `source` fixed to `discover`.
 *
 * A separate tool rather than a parameter because the two answer different
 * questions, and design spec §12 lists them separately. The tool surface is
 * the public API, and a model choosing between "search my library" and "tell
 * me about this" should not have to reason about an enum to do it.
 */
export async function buildLookupMedia(
    adapters: readonly ServiceAdapter[],
    opts: { query: string; detail: DetailLevel; limit: number }
): Promise<GetSearchResult> {
    return buildSearchMedia(adapters, { ...opts, source: 'discover' });
}

export function registerLookupMedia(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'lookup_media',
        {
            description:
                'Metadata for something you may not have: title, year, and external ids, from Radarr, Sonarr and Seerr. Reads only — nothing is added, requested or monitored.',
            inputSchema: z.object({
                query: z.string().min(1).describe('What to look up.'),
                detail: DetailSchema,
                limit: LimitSchema
            })
        },
        async ({ query, detail, limit }) => {
            const result = await buildLookupMedia(adapters, { query, detail, limit });
            const summary =
                result.total === 0
                    ? `Nothing found for "${query}".`
                    : `${result.returned} of ${result.total} match(es) for "${query}".`;

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
