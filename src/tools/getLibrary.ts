import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { MergedItem } from '../core/resolver.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, applyLimit, preferred, toolInput, type DetailLevel } from '../core/shape.ts';
import { unfenced } from '../core/titleMatch.ts';
import { UserSchema } from './getPlayback.ts';
import type { LibraryLoader } from './library.ts';

/** The five names a film can carry, plus the one a series can. */
export const RATING_SOURCES = ['imdb', 'tmdb', 'trakt', 'metacritic', 'rottenTomatoes', 'tvdb'] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

/** Films only. `tvdb` is Sonarr's flat value and belongs to series alone. */
const FILM_SOURCES: readonly RatingSource[] = ['imdb', 'tmdb', 'trakt', 'metacritic', 'rottenTomatoes'];

/**
 * What a series can carry. `tvdb` is Sonarr's own flat value; `imdb` comes
 * only from the IMDb dataset, since Sonarr never reports one.
 *
 * With the dataset off, asking for `imdb` is accepted and finds nothing rated,
 * which `ratingCoverage` states. "Not built yet" is a different answer from
 * "impossible", and only the second deserves a refusal.
 */
const SERIES_SOURCES: readonly RatingSource[] = ['tvdb', 'imdb'];

/**
 * The native scale each source arrives on. `min_rating` is documented as 0–10,
 * but Metacritic and Rotten Tomatoes come through on 0–100 and nothing
 * upstream rescales them.
 *
 * Comparing a raw 64 against an 0–10 threshold makes "rated at all" read as
 * "rated 8+": measured on a real library, an 8+ filter matched 136 of 136
 * metacritic-rated films. A named table rather than a `/ 10` at the comparison
 * site, so the next source added has to see this.
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

/**
 *  A superlative cannot be answered by a filter: with more items than
 * `limit`, the best-rated may simply not be in the window, and the model then
 * answers confidently from whatever fifty it was handed.
 *
 * `added` was absent through 0.8 because nothing carried an added date. 0.9
 * put one on `acquisition`, which is what makes "what arrived this week"
 * answerable rather than approximated.
 */
export const SORT_FIELDS = ['rating', 'year', 'title', 'added'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export type LibraryQuery = {
    detail: DetailLevel;
    limit: number;
    offset?: number;
    sort?: SortField;
    kind?: 'movie' | 'series';
    year?: number;
    genre?: string;
    monitored?: boolean;
    has_file?: boolean;
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
    offset: number;
    truncated: boolean;
    degraded: string[];
    /** Keyed by source — see `LibrarySnapshot.counts`. */
    counts: Record<string, number>;
    /**
     * `note` is set only when the count needs defending — see
     * `imdbUnavailableNote`. Additive and optional, so a caller reading
     * `source`/`rated`/`unrated` is unaffected.
     */
    ratingCoverage?: { source: RatingSource; rated: number; unrated: number; note?: string };
};

const ratingOf = (item: MergedItem, source: RatingSource): number | undefined => item.ratings?.[source];

/**
 * "whichever source covers the most of the library". Ties break in the
 * declared order, so the same library always answers the same way.
 *
 * A series query stays on `tvdb` by default even though the IMDb dataset can
 * now supply `imdb`, and the reason is compatibility rather than coverage:
 * changing the default would silently re-scale every saved prompt's
 * `min_rating` against a different source, which is exactly the kind of quiet
 * break CONTRIBUTING calls out about the tool surface. `imdb` is one explicit
 * `rating_source` away.
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
 * the two documented limits, enforced rather than left to produce an empty
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
    // Was: a series may only ask for `tvdb`, because Sonarr's flat value was
    // the only rating one could carry. The IMDb dataset (0.8) makes `imdb`
    // reachable for a series too, so the refusal narrows to the sources that
    // still have no path to one — and gains its mirror image, `tvdb` on a
    // film, which Radarr never reports and which therefore used to match
    // nothing at all, silently.
    if (opts.kind === 'series' && opts.rating_source !== undefined && !SERIES_SOURCES.includes(opts.rating_source)) {
        throw new Error(
            `rating_source "${opts.rating_source}" applies to films only — a series carries Sonarr's flat TVDB rating, and an IMDb rating when the IMDb dataset is enabled. Use "tvdb" or "imdb", or drop it.`
        );
    }
    if (opts.kind === 'movie' && opts.rating_source === 'tvdb') {
        throw new Error(
            'rating_source "tvdb" applies to series only — Radarr does not report a TVDB rating, so this would match nothing. Drop it, or use one of the per-source film ratings.'
        );
    }
}

/**
 * Applied **before** `applyLimit` — ordering after truncation is the same bug
 * wearing a parameter.
 *
 * A rating sort relies on `needsRating` below having already removed unrated
 * items. Excluded rather than ranked zero: at the bottom of a list, an item
 * nobody rated is indistinguishable from one rated 0.4, and
 * `ratingCoverage.unrated` states how many were set aside.
 *
 * `localeCompare` so "Ålesund" sorts where a reader expects, and `unfenced`
 * because a title here still carries its untrusted-value fence.
 */
function applySort(items: readonly MergedItem[], sort: SortField, source: RatingSource): MergedItem[] {
    const sorted = [...items];

    if (sort === 'title') return sorted.sort((a, b) => unfenced(a.title).localeCompare(unfenced(b.title)));

    if (sort === 'added') {
        // Excluded, not defaulted. An item nobody can date is not an item from
        // 1970, and answering "we do not know" with the epoch is the same
        // failure as ranking an unrated title zero.
        //
        // Compared as strings: ISO 8601 sorts lexicographically in the order it
        // sorts chronologically, so no parsing is needed — and `new Date()` on
        // a malformed value yields NaN, which compares false against everything
        // and would scramble the order silently.
        return sorted
            .filter(i => i.acquisition?.addedAt !== undefined)
            .sort((a, b) => (b.acquisition?.addedAt ?? '').localeCompare(a.acquisition?.addedAt ?? ''));
    }
    // Descending: the newest and the best rated are what a superlative asks
    // for, and nobody asks for their worst film first.
    if (sort === 'year') return sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

    return sorted.sort((a, b) => (ratingOf(b, source) ?? 0) - (ratingOf(a, source) ?? 0));
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
    // `seasons` joins `genres` here rather than riding along: it is the largest
    // optional field an item can carry, and `standard` is the default every
    // caller gets who did not ask for season arithmetic. `minimal` already
    // excludes it by naming its fields explicitly.
    const { genres: _g, seasons: _s, ...rest } = item;
    return rest;
};

/**
 * Why an IMDb query found nothing — when the reason is this server rather than
 * the library.
 *
 * "0 rated, 40 unrated" is true and useless on its own. It reads as *your
 * series are unrated*, and a model handed that number reasonably tells the user
 * their question cannot be answered — which is how someone came to be told that
 * IMDb scores for their own shows were impossible, when the answer was one
 * config line away.
 *
 * Only ever attached to a **zero**. A partial count speaks for itself, and
 * qualifying a real answer with an excuse would be worse than saying nothing.
 * `ready` returns nothing for the same reason: a loaded dataset that does not
 * cover these titles is a genuine fact about the library.
 */
function imdbUnavailableNote(state: 'off' | 'ingesting' | 'ready'): string | undefined {
    if (state === 'off') {
        return 'No IMDb rating was available for anything here, because the IMDb dataset is not enabled — set `metadata.imdb.enabled: true` (Configuration → IMDb dataset). For a series this is the only source there is: Sonarr reports one flat TVDB number, and Seerr’s /tv ratings are Rotten Tomatoes only. This is a gap in what this server can look up, not a verdict on the library.';
    }
    if (state === 'ingesting') {
        return 'The IMDb dataset is enabled but has not finished its first ingest, so no IMDb rating is available yet — it takes a few minutes and the dashboard reports when it lands. Nothing needs changing; ask again shortly. This is not a verdict on the library.';
    }
    return undefined;
}

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
        /**
         * Strict, and deliberately **unlike** `monitored` directly above.
         *
         * `monitored ?? false` is right for monitoring: media no *arr manages
         * genuinely is not monitored, because nothing is monitoring it. The
         * same coalesce would be wrong here — Jellyfin-only media plainly does
         * have a file, Jellyfin found it, and reporting `hasFile: false` for
         * something demonstrably on disk would put it on a list of things to
         * chase a download for.
         *
         * So an item with no acquisition half matches neither `true` nor
         * `false`. It is the `presence: unknown` distinction again: absent
         * evidence is not evidence of absence.
         */
        if (opts.has_file !== undefined && item.acquisition?.hasFile !== opts.has_file) return false;
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

    /**
     * A rating is in play for a `min_rating` filter *or* a `sort: 'rating'` —
     * and the second is why this is not simply `min_rating !== undefined`.
     * Sorting by rating drops unrated items, so it owes the caller the same
     * coverage count a filter does. Without this, "the ten best rated" would
     * quietly leave out everything unrated and report nothing about it, which
     * is the exact silent omission `ratingCoverage` was built to prevent.
     */
    const needsRating = opts.min_rating !== undefined || opts.sort === 'rating';

    if (!needsRating) {
        // `bestCoveredSource` is never consulted here: no rating is read, so
        // computing one would be work whose result is discarded.
        const ordered = opts.sort === undefined ? filtered : applySort(filtered, opts.sort, 'imdb');
        const shaped = applyLimit(ordered, opts.limit, opts.offset);
        return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
    }

    // coverage is measured over everything the other filters kept, before
    // the rating filter removes anything — that is what makes "184 rated, 66
    // unrated" answer the question the caller actually asked.
    const source = opts.rating_source ?? bestCoveredSource(filtered, opts.kind);
    const rated = filtered.filter(i => ratingOf(i, source) !== undefined);
    // Bound to a local so the narrowing survives into the closure — inside the
    // callback, `opts.min_rating` is a property read TypeScript cannot prove
    // has not changed.
    const floor = opts.min_rating;
    const matching =
        floor === undefined
            ? rated
            : rated.filter(i => toTenPointScale(source, ratingOf(i, source) as number) >= floor);

    const ordered = opts.sort === undefined ? matching : applySort(matching, opts.sort, source);
    const shaped = applyLimit(ordered, opts.limit, opts.offset);

    // Only for `imdb`, and only for a zero: every other source is supplied by a
    // service that either answered or is already named in `degraded`.
    const note =
        source === 'imdb' && rated.length === 0 ? imdbUnavailableNote(loader.imdbDatasetState) : undefined;

    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        degraded,
        counts,
        ratingCoverage: {
            source,
            rated: rated.length,
            unrated: filtered.length - rated.length,
            ...(note === undefined ? {} : { note })
        }
    };
}

export function registerGetLibrary(server: McpServer, loader: LibraryLoader): void {
    server.registerTool(
        'get_library',
        {
            description:
                'Your library, joined across Radarr, Sonarr and Jellyfin on shared external ids. `presence` is what no single service can tell you — but only when the absent half’s service actually answered: `arr_only` with a file means Jellyfin *was reachable and* cannot see a file the *arr believes is on disk (a likely broken import); `jellyfin_only` means nothing here is managing it, read the same way — it assumes Radarr/Sonarr answered too, and (unlike `arr_only`) is not yet hedged against their own outage. If Jellyfin is degraded, an item Radarr/Sonarr manages reports `unknown` instead of `arr_only`, and the top-level `degraded` list names it. If Jellyfin is not configured at all, `unknown` fires the same way but `degraded` stays empty — there is nothing to name as degraded — so check whether `jellyfin` even appears in your config instead. `has_file: false` with `monitored: true` is "what am I still waiting for". Two limits: `quality` applies to films only (a series’ quality is per-episode), and a series carries Sonarr’s one flat TVDB rating plus an IMDb rating **only when the IMDb dataset is enabled** — nothing else in this stack has a series’ IMDb number, so with the dataset off `rating_source: "imdb"` on a series matches nothing. `rating_source` still defaults to `tvdb` for a series, so ask for `imdb` explicitly. A rating filter also reports how much of the library that source actually covers; if that count is zero because the dataset is off or still ingesting, `ratingCoverage.note` says so — report that reason rather than telling the user their library is unrated or that the question cannot be answered. A series at `detail: "full"` also carries `seasons`: per season, how many episodes you have watched (`watched`), how many are on disk (`onDisk`), how many have aired (`aired`), and how many exist in total (`total`, which is TVDB\'s count via Sonarr). `complete` is true only when every episode of the season has been watched — and is **absent, not false**, when either half is unknown: a series no *arr manages has no `total`, and one Jellyfin has never seen has no `watched`. Season 0 is specials and is reported like any other season. `seasons` is omitted below `detail: "full"`. Each season row also carries `monitored`, Sonarr’s own per-season flag — the same field `get_media_details` reports — absent rather than false when no Sonarr manages the series.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                kind: z.enum(['movie', 'series']).optional().describe('Films or series. Omit for both.'),
                year: z.number().int().optional(),
                genre: z.string().min(1).optional().describe('Matched case-insensitively against the *arr genres.'),
                monitored: z.boolean().optional(),
                has_file: z
                    .boolean()
                    .optional()
                    .describe(
                        'Whether a file is actually on disk. `false` with `monitored: true` is "what am I still waiting for"; `true` is "what can I watch now". Media no *arr manages is excluded from both answers rather than counted as missing — nothing is going to fetch it.'
                    ),
                watched: z.boolean().optional().describe('Jellyfin watch state. Items Jellyfin has never seen count as unwatched. Pair with `user` to ask about someone else.'),
                user: UserSchema,
                // Undocumented on purpose: the spelling this tool had when the
                // surface froze at 1.0, where `get_playback` and `get_requests`
                // already called the same thing `user`. Kept working forever —
                // removing it would break a saved prompt silently — but
                // described nowhere.
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
                    .enum(['both', 'arr_only', 'jellyfin_only', 'unknown'])
                    .optional()
                    .describe(
                        'both / arr_only (possible broken import) / jellyfin_only (unmanaged media) / unknown (Jellyfin degraded or unconfigured — arr_only cannot be asserted).'
                    ),
                sort: z
                    .enum(SORT_FIELDS)
                    .optional()
                    .describe(
                        'Order the results *before* `limit` is applied — which is what makes "the best rated" or "most recently added" answerable at all, since a filter alone would leave the top item outside the returned window. `rating` is descending and uses `rating_source`, excluding items that source has no rating for and reporting them in `ratingCoverage`; `added` is newest first and excludes media no *arr manages, which has no added date; `year` is descending; `title` ascending. Omit to keep the library\'s own order.'
                    ),
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            }, { undocumented: ['watched_by'] })
        },
        async input => {
            const { user, watched_by, ...rest } = input as LibraryQuery & { user?: string };
            const watchedBy = preferred({ name: 'user', value: user, alias: 'watched_by', aliasValue: watched_by });

            const result = await buildGetLibrary(loader, {
                ...rest,
                ...(watchedBy === undefined ? {} : { watched_by: watchedBy })
            } as LibraryQuery);

            const coverage =
                result.ratingCoverage === undefined
                    ? ''
                    : ` ${result.ratingCoverage.unrated} item(s) carry no ${result.ratingCoverage.source} rating and could not be judged.` +
                      // In the text too, not only the structured half: this is
                      // the sentence that stops "0 rated" being read as a fact
                      // about the library, and it has to reach a reader who
                      // only ever sees the summary line.
                      (result.ratingCoverage.note === undefined ? '' : ` ${result.ratingCoverage.note}`);
            const missing =
                result.degraded.length === 0 ? '' : ` ${result.degraded.join(', ')} could not be reached.`;

            return {
                content: [{ type: 'text', text: `${result.returned} of ${result.total} item(s).${coverage}${missing}` }],
                structuredContent: result
            };
        }
    );
}
