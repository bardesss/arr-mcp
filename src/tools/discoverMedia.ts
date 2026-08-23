import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, preferred, toolInput, type DetailLevel } from '../core/shape.ts';
import type { SeerrAdapter } from '../services/seerr.ts';
import { fenceText } from '../core/fence.ts';
import { enrichWithImdb } from '../metadata/enrich.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
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
        kind: 'movie' | 'series';
        genre?: string;
        year?: number;
        minRating?: number;
        detail: DetailLevel;
        limit: number;
        offset?: number;
    },
    dataset?: ImdbDataset
): Promise<GetSearchResult> {
    if (adapter === undefined) {
        // Without Seerr this used to return an empty result, which reads as
        // "nothing matched" rather than "nobody could answer". The IMDb
        // dataset can answer it: genre, year and a minimum rating are a join
        // over two of its tables.
        return fromDataset(opts, dataset);
    }

    let hits: SearchHit[];
    try {
        hits = await adapter.discover({
            // Translated here, at the boundary that needs it: Seerr is
            // TMDB-backed and TMDB says `tv`. Everything on our side of this
            // call says `series`, including the items Seerr hands back.
            mediaType: opts.kind === 'series' ? 'tv' : 'movie',
            ...(opts.genre === undefined ? {} : { genre: opts.genre }),
            ...(opts.year === undefined ? {} : { year: opts.year }),
            ...(opts.minRating === undefined ? {} : { minRating: opts.minRating })
        });
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'discover failed; degrading');
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [adapter.id], counts: {} };
    }

    // Enrichment applies whatever the source. Seerr's discover is
    // TMDB-backed, so a hit carrying an imdb id gains an IMDb rating beside
    // the TMDB one it already had — source selection and enrichment are
    // independent decisions.
    const shaped = applyLimit(hits, opts.limit, opts.offset);
    const rated = enrichWithImdb(shaped.items, dataset);

    return {
        ...shaped,
        items: rated.map(h => project(h, opts.detail)),
        degraded: [],
        counts: { seerr: hits.length }
    };
}

/**
 * Discovery from the local dataset, for a stack with no Seerr.
 *
 * **Seerr wins whenever it is configured** (spec ). It knows what is
 * trending, what is requestable and what you have already asked for; the
 * dataset knows a year column. Merging two orderings that mean different
 * things would produce a ranking that means neither.
 *
 * `genre` is a name on both paths now — Seerr translates it to a TMDB id
 * internally. This path has no id table to translate against, so a numeric id
 * would match no IMDb genre and is rejected here rather than silently
 * returning nothing.
 */
function fromDataset(
    opts: { kind: 'movie' | 'series'; genre?: string; year?: number; minRating?: number; detail: DetailLevel; limit: number; offset?: number },
    dataset: ImdbDataset | undefined
): GetSearchResult {
    const empty = { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [], counts: {} };

    // An empty envelope with nothing degraded reads as "nothing matched", so a
    // model reported that nothing is trending when the truth is that this
    // stack has nothing configured that can answer at all. Said in a note
    // rather than thrown, matching get_library's ratingCoverage.note: an
    // unconfigured optional source is a fact about the stack, not a failure of
    // the call.
    if (dataset === undefined) {
        return {
            ...empty,
            note: 'Discovery is answered by Seerr or the IMDb dataset, and neither is configured — this is not a statement about what exists. Add a Seerr instance, or set metadata.imdb.enabled in config.yaml.'
        };
    }

    if (opts.genre !== undefined && /^\d+$/.test(opts.genre)) {
        throw new Error(
            `genre "${opts.genre}" is a TMDB id, which only Seerr understands. Seerr is not configured, so discovery is answered from the IMDb dataset — pass a genre name such as "Crime" instead.`
        );
    }

    const hits = dataset
        .discover({
            kind: opts.kind,
            ...(opts.genre === undefined ? {} : { genre: opts.genre }),
            ...(opts.year === undefined ? {} : { year: opts.year }),
            ...(opts.minRating === undefined ? {} : { minRating: opts.minRating }),
            limit: opts.limit,
            ...(opts.offset === undefined ? {} : { offset: opts.offset })
        })
        .map(
            (t): SearchHit => ({
                service: 'imdb',
                source: 'discover',
                kind: opts.kind,
                id: t.tconst,
                // Fenced like every other external string. A dataset row is no
                // more trusted than an indexer's release name.
                title: fenceText(t.title, { service: 'imdb', field: 'title' }),
                ...(t.year === undefined ? {} : { year: t.year }),
                ids: { imdb: t.tconst },
                ...(t.rating === undefined ? {} : { ratings: { imdb: t.rating } })
            })
        );

    // Not `applyLimit`: `discover` applied both the limit and the offset in
    // SQL, so these rows *are* the requested page and slicing them again would
    // cut page two down to nothing. `total` is a real count rather than "what
    // came back", which is what makes `offset + returned < total` — the
    // documented way to ask for another page — mean anything here.
    const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
    const total = dataset.countDiscover({
        kind: opts.kind,
        ...(opts.genre === undefined ? {} : { genre: opts.genre }),
        ...(opts.year === undefined ? {} : { year: opts.year }),
        ...(opts.minRating === undefined ? {} : { minRating: opts.minRating })
    });

    return {
        items: hits.map(h => project(h, opts.detail)),
        total,
        returned: hits.length,
        offset,
        truncated: hits.length < total,
        degraded: [],
        counts: {}
    };
}

export function registerDiscoverMedia(
    server: McpServer,
    adapter: SeerrAdapter | undefined,
    dataset?: ImdbDataset
): void {
    server.registerTool(
        'discover_media',
        {
            title: 'Discover trending media',
            annotations: READ_ONLY,
            description:
                'Browse what exists rather than what you have: films or series by genre, year and minimum rating. Nothing is requested or added. Answered by Seerr when it is configured — TMDB-backed, so the rating is TMDB’s. With no Seerr it is answered from the local IMDb dataset instead, where the rating is IMDb’s.',
            outputSchema: PagedOutputSchema.extend({
                note: z
                    .string()
                    .optional()
                    .describe(
                        'Present when an empty list needs defending — for example when neither Seerr nor the IMDb dataset is configured, so nothing could answer. Report the reason rather than saying nothing matched.'
                    )
            }),
            inputSchema: toolInput({
                kind: z.enum(['movie', 'series']).optional().describe('Films or series. Defaults to films.'),
                // Undocumented on purpose: the spelling this tool had when the
                // surface froze at 1.0. Kept working forever — removing it
                // would break a saved prompt silently — but described nowhere,
                // so nothing new is written against it.
                media_type: z.enum(['movie', 'tv']).optional(),
                genre: z.string().optional().describe('Genre name, e.g. "Crime" or "Action". A TMDB numeric id is also accepted.'),
                year: z.number().int().min(1900).max(2100).optional().describe('Restrict to one release year.'),
                min_rating: z.number().min(0).max(10).optional().describe('Minimum TMDB rating out of 10.'),
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            }, { undocumented: ['media_type'] })
        },
        async ({ kind, media_type, genre, year, min_rating, detail, limit, offset }) => {
            const resolved =
                preferred({
                    name: 'kind',
                    value: kind,
                    alias: 'media_type',
                    aliasValue: media_type,
                    translate: v => (v === 'tv' ? 'series' : v)
                }) ?? 'movie';

            const result = await buildDiscoverMedia(adapter, {
                kind: resolved as 'movie' | 'series',
                ...(genre === undefined ? {} : { genre }),
                ...(year === undefined ? {} : { year }),
                ...(min_rating === undefined ? {} : { minRating: min_rating }),
                detail,
                limit,
                offset
            }, dataset);
            const summary =
                result.degraded.length > 0
                    ? 'Seerr could not be reached; nothing to discover.'
                    : result.note !== undefined
                      ? result.note
                      : `${result.returned} of ${result.total} ${resolved === 'series' ? 'series' : 'film(s)'} found.`;

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
