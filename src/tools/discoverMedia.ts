import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
import type { SeerrAdapter } from '../services/seerr.ts';
import type { SearchHit } from '../services/types.ts';
import type { GetSearchResult } from './searchMedia.ts';

const project = (h: SearchHit, detail: DetailLevel): SearchHit => {
    if (detail === 'minimal') {
        return { service: h.service, source: h.source, kind: h.kind, id: h.id, title: h.title, ids: h.ids };
    }
    return h;
};

export async function buildDiscoverMedia(
    adapter: SeerrAdapter | undefined,
    opts: {
        mediaType: 'movie' | 'tv';
        genre?: string;
        year?: number;
        minRating?: number;
        detail: DetailLevel;
        limit: number;
    }
): Promise<GetSearchResult> {
    if (adapter === undefined) {
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [], counts: {} };
    }

    let hits: SearchHit[];
    try {
        hits = await adapter.discover({
            mediaType: opts.mediaType,
            ...(opts.genre === undefined ? {} : { genre: opts.genre }),
            ...(opts.year === undefined ? {} : { year: opts.year }),
            ...(opts.minRating === undefined ? {} : { minRating: opts.minRating })
        });
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'discover failed; degrading');
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [adapter.id], counts: {} };
    }

    const shaped = applyLimit(hits, opts.limit);
    return {
        ...shaped,
        items: shaped.items.map(h => project(h, opts.detail)),
        degraded: [],
        counts: { seerr: hits.length }
    };
}

export function registerDiscoverMedia(server: McpServer, adapter: SeerrAdapter | undefined): void {
    server.registerTool(
        'discover_media',
        {
            description:
                'Browse what exists rather than what you have, through Seerr: films or series by genre, year and minimum rating. TMDB-backed, so the rating is TMDB’s. Nothing is requested or added.',
            inputSchema: z.object({
                media_type: z.enum(['movie', 'tv']).default('movie').describe('Films or series.'),
                genre: z.string().optional().describe('TMDB genre id, e.g. 28 for Action.'),
                year: z.number().int().min(1900).max(2100).optional().describe('Restrict to one release year.'),
                min_rating: z.number().min(0).max(10).optional().describe('Minimum TMDB rating out of 10.'),
                detail: DetailSchema,
                limit: LimitSchema
            })
        },
        async ({ media_type, genre, year, min_rating, detail, limit }) => {
            const result = await buildDiscoverMedia(adapter, {
                mediaType: media_type,
                ...(genre === undefined ? {} : { genre }),
                ...(year === undefined ? {} : { year }),
                ...(min_rating === undefined ? {} : { minRating: min_rating }),
                detail,
                limit
            });
            const summary =
                result.degraded.length > 0
                    ? 'Seerr could not be reached; nothing to discover.'
                    : `${result.returned} of ${result.total} ${media_type === 'tv' ? 'series' : 'film(s)'} found.`;

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
