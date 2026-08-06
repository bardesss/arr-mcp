import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import type { MergedItem } from '../core/resolver.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
import { unfenced } from '../core/titleMatch.ts';
import { UserSchema } from './getPlayback.ts';
import type { LibraryLoader } from './library.ts';

/** The five §4.1 names a film can carry, plus the one a series can. */
export const RATING_SOURCES = ['imdb', 'tmdb', 'trakt', 'metacritic', 'rottenTomatoes', 'tvdb'] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

/** Films only. `tvdb` is Sonarr's flat value and belongs to series alone (§21.2). */
const FILM_SOURCES: readonly RatingSource[] = ['imdb', 'tmdb', 'trakt', 'metacritic', 'rottenTomatoes'];

/**
 * The scale each source's raw value arrives on. `min_rating` is documented as
 * 0–10 for every source, but Radarr/Sonarr pass Metacritic and Rotten Tomatoes
 * through on their own site's native 0–100 scale, and nothing upstream of
 * this filter rescales them — `flattenRatings`/`toMergedRatings`
 * (`src/services/arrRatings.ts`) store exactly what the *arr reported.
 *
 * Comparing a raw 64 or 82 against an 0–10 `min_rating` threshold makes
 * "rated at all" read as "rated 8+" for those two sources: measured against a
 * real library, an 8+ filter matched 136 of 136 metacritic-rated films and
 * 121 of 121 rottenTomatoes-rated ones. The next source to add here needs to
 * see this decision, which is why it is a named table rather than a `/ 10` at
 * the comparison site below.
 */
const RATING_SCALE_MAX: Record<RatingSource, number> = {
    imdb: 10,
    tmdb: 10,
    trakt: 10,
    tvdb: 10,
    metacritic: 100,
    rottenTomatoes: 100
};

/**
 * `value`, as reported on `source`'s native scale, rescaled to the 0–10 scale
 * `min_rating` is documented in — for comparison only. The stored/returned
 * rating keeps its native scale (a displayed `6.4` would read worse than `64`
 * for a site whose own UI has always shown out of 100), so this is called at
 * the filter comparison, never at the point a rating is read into a response.
 */
const toTenPointScale = (source: RatingSource, value: number): number => (value / RATING_SCALE_MAX[source]) * 10;

export type LibraryQuery = {
    detail: DetailLevel;
    limit: number;
    kind?: 'movie' | 'series';
    year?: number;
    genre?: string;
    monitored?: boolean;
    watched?: boolean;
    watched_by?: string;
    quality?: string;
    min_rating?: number;
    rating_source?: RatingSource;
    presence?: MergedItem['presence'];
};

export type GetLibraryResult = {
    items: MergedItem[];
    total: number;
    returned: number;
    truncated: boolean;
    degraded: ServiceId[];
    counts: Partial<Record<ServiceId, number>>;
    ratingCoverage?: { source: RatingSource; rated: number; unrated: number };
};

const ratingOf = (item: MergedItem, source: RatingSource): number | undefined => item.ratings?.[source];

/**
 * §5: "whichever source covers the most of the library". Ties break in the
 * declared order, so the same library always answers the same way.
 */
function bestCoveredSource(items: readonly MergedItem[], kind: LibraryQuery['kind']): RatingSource {
    if (kind === 'series') return 'tvdb';

    let best: RatingSource = 'imdb';
    let bestCount = -1;
    for (const source of FILM_SOURCES) {
        const count = items.filter(i => ratingOf(i, source) !== undefined).length;
        if (count > bestCount) {
            best = source;
            bestCount = count;
        }
    }
    return best;
}

/**
 * §5.2's two documented limits, enforced rather than left to produce an empty
 * list. A filter that quietly matches nothing is worse than a stated gap: the
 * model reports "you have no such series" and the user believes it.
 *
 * A plain Error, not a ServiceError: no service failed, and ServiceError
 * requires a ServiceId that would misattribute the fault to one.
 */
function rejectImpossibleFilters(opts: LibraryQuery): void {
    if (opts.kind === 'series' && opts.quality !== undefined) {
        throw new Error(
            'quality applies to films only — a series’ quality is per-episode, so a series-level value would be a fiction. Filter get_media_details at detail: full instead.'
        );
    }
    if (opts.kind === 'series' && opts.rating_source !== undefined && opts.rating_source !== 'tvdb') {
        throw new Error(
            `rating_source "${opts.rating_source}" applies to films only — Sonarr holds one flat TVDB rating per series. Use rating_source: "tvdb", or drop it.`
        );
    }
}

const project = (item: MergedItem, detail: DetailLevel): MergedItem => {
    if (detail === 'full') return item;
    if (detail === 'minimal') {
        return {
            kind: item.kind,
            title: item.title,
            ...(item.year === undefined ? {} : { year: item.year }),
            ids: item.ids,
            presence: item.presence
        };
    }
    const { genres: _g, ...rest } = item;
    return rest;
};

export async function buildGetLibrary(loader: LibraryLoader, opts: LibraryQuery): Promise<GetLibraryResult> {
    rejectImpossibleFilters(opts);

    const { index, degraded, counts } = await loader.load(opts.watched_by);

    const genre = opts.genre?.toLowerCase();
    const quality = opts.quality?.toLowerCase();

    const filtered = index.all().filter(item => {
        if (opts.kind !== undefined && item.kind !== opts.kind) return false;
        if (opts.year !== undefined && item.year !== opts.year) return false;
        if (genre !== undefined && !(item.genres ?? []).some(g => unfenced(g).toLowerCase() === genre)) return false;
        if (opts.monitored !== undefined && (item.acquisition?.monitored ?? false) !== opts.monitored) return false;
        // Absent playback is "not watched", never "excluded": an item Jellyfin
        // has never seen is exactly what `watched: false` should surface.
        if (opts.watched !== undefined && (item.playback?.watched ?? false) !== opts.watched) return false;
        if (opts.presence !== undefined && item.presence !== opts.presence) return false;
        if (quality !== undefined) {
            // Series are excluded rather than compared: they have no
            // series-level quality to compare against.
            if (item.kind !== 'movie') return false;
            if ((item.acquisition?.quality ?? '').toLowerCase() !== quality) return false;
        }
        return true;
    });

    if (opts.min_rating === undefined) {
        const shaped = applyLimit(filtered, opts.limit);
        return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
    }

    // §5.1: coverage is measured over everything the other filters kept, before
    // the rating filter removes anything — that is what makes "184 rated, 66
    // unrated" answer the question the caller actually asked.
    const source = opts.rating_source ?? bestCoveredSource(filtered, opts.kind);
    const rated = filtered.filter(i => ratingOf(i, source) !== undefined);
    const matching = rated.filter(
        i => toTenPointScale(source, ratingOf(i, source) as number) >= (opts.min_rating as number)
    );

    const shaped = applyLimit(matching, opts.limit);
    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        degraded,
        counts,
        ratingCoverage: { source, rated: rated.length, unrated: filtered.length - rated.length }
    };
}

export function registerGetLibrary(server: McpServer, loader: LibraryLoader): void {
    server.registerTool(
        'get_library',
        {
            description:
                'Your library, joined across Radarr, Sonarr and Jellyfin on shared external ids. `presence` is what no single service can tell you: `arr_only` with a file means Jellyfin cannot see a file the *arr believes is on disk, and `jellyfin_only` means media nothing is managing. Two limits: `quality` applies to films only (a series’ quality is per-episode), and series carry one flat TVDB rating rather than per-source ratings. A rating filter also reports how much of the library that source actually covers.',
            inputSchema: z.object({
                kind: z.enum(['movie', 'series']).optional().describe('Films or series. Omit for both.'),
                year: z.number().int().optional(),
                genre: z.string().min(1).optional().describe('Matched case-insensitively against the *arr genres.'),
                monitored: z.boolean().optional(),
                watched: z.boolean().optional().describe('Jellyfin watch state. Items Jellyfin has never seen count as unwatched.'),
                watched_by: UserSchema,
                quality: z.string().min(1).optional().describe('Films only.'),
                min_rating: z
                    .number()
                    .min(0)
                    .max(10)
                    .optional()
                    .describe(
                        'Always 0-10, regardless of source. Metacritic and Rotten Tomatoes are reported in the response on their native 0-100 scale, but rescaled to 0-10 for this comparison.'
                    ),
                rating_source: z
                    .enum(RATING_SOURCES)
                    .optional()
                    .describe('Defaults to whichever source covers the most of your library. `tvdb` is series-only.'),
                presence: z
                    .enum(['both', 'arr_only', 'jellyfin_only'])
                    .optional()
                    .describe('both / arr_only (possible broken import) / jellyfin_only (unmanaged media).'),
                detail: DetailSchema,
                limit: LimitSchema
            })
        },
        async input => {
            const result = await buildGetLibrary(loader, input as LibraryQuery);

            const coverage =
                result.ratingCoverage === undefined
                    ? ''
                    : ` ${result.ratingCoverage.unrated} item(s) carry no ${result.ratingCoverage.source} rating and could not be judged.`;
            const missing =
                result.degraded.length === 0 ? '' : ` ${result.degraded.join(', ')} could not be reached.`;

            return {
                content: [{ type: 'text', text: `${result.returned} of ${result.total} item(s).${coverage}${missing}` }],
                structuredContent: result
            };
        }
    );
}
