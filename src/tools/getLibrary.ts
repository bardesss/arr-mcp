import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { KINDS_KEY } from '../config/schema.ts';
import type { LibraryKind, MergedItem } from '../core/resolver.ts';
import {
    DetailSchema,
    LimitSchema,
    OffsetSchema,
    PagedOutputSchema,
    READ_ONLY,
    applyLimit,
    listText,
    preferred,
    toolInput,
    type DetailLevel
} from '../core/shape.ts';
import { unfenced } from '../core/titleMatch.ts';
import { UserSchema } from './getPlayback.ts';
import type { LibraryLoader } from './library.ts';
import { byMediaServers, withBoth } from './mediaServers.ts';
import { titled } from '../core/labels.ts';
import { mediaCardsToolMeta, wantsCards, withCards } from '../mcp/apps.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { cardsFromLibrary } from '../ui/mediaCards.ts';

/** Every rating source a title can carry. */
const RATING_SOURCES = ['imdb', 'tmdb', 'trakt', 'metacritic', 'rottenTomatoes', 'tvdb'] as const;
type RatingSource = (typeof RATING_SOURCES)[number];

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
 * answerable rather than approximated. `sort: 'added'` still leaves out media
 * no *arr manages, which has no added date to sort on. A Lidarr artist carries
 * one, so music sorts here.
 */
const SORT_FIELDS = ['rating', 'year', 'title', 'added'] as const;
type SortField = (typeof SORT_FIELDS)[number];

type LibraryQuery = {
    detail: DetailLevel;
    limit: number;
    offset?: number;
    sort?: SortField;
    kind?: LibraryKind;
    year?: number;
    genre?: string;
    monitored?: boolean;
    has_file?: boolean;
    watched?: boolean;
    watched_by?: string;
    quality?: string;
    library?: string;
    added_since?: string;
    min_rating?: number;
    rating_source?: RatingSource;
    presence?: MergedItem['presence'];
    missing_from?: string;
};

type GetLibraryResult = {
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
    /** Carried from `LibrarySnapshot.note` — a fact about the stack's config, not this call. */
    note?: string;
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
    if (opts.library !== undefined && opts.kind !== undefined && opts.kind !== 'book') {
        throw new Error('library applies to books only — it names a Grimmory library, and no other kind sits in one. Drop it, or ask with kind: "book".');
    }
    if (opts.added_since !== undefined && !Number.isFinite(Date.parse(opts.added_since))) {
        throw new Error(`added_since "${opts.added_since}" is not an ISO 8601 date. Use YYYY-MM-DD, e.g. "2026-08-01", or a full timestamp.`);
    }
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
    rejectFilmFiltersOnMusic(opts);
    rejectFilmFiltersOnBooks(opts);
}

/**
 * The same refusal for music, asked only when the caller named `kind: "artist"`.
 *
 * With a kind, the caller has said the question is about artists, so a filter no
 * artist can satisfy is a stated gap rather than an answer — the lesson
 * `rejectImpossibleFilters` exists for. Without a kind these filters drop music
 * through the normal absent-field path, and `watched`/`watched_by` drop it the
 * same way, because an artist has no watch state to compare.
 *
 * `presence` is deliberately absent from this list. An artist joins to a media
 * server on the MusicBrainz artist id, so it holds a real presence value.
 */
function rejectFilmFiltersOnMusic(opts: LibraryQuery): void {
    if (opts.kind !== 'artist') return;

    if (
        opts.quality !== undefined ||
        opts.rating_source !== undefined ||
        opts.min_rating !== undefined ||
        opts.sort === 'rating'
    ) {
        throw new Error(
            'An artist carries no rating here and no item-level quality, only the quality profile Lidarr grabs against. Drop quality, min_rating, rating_source and sort: "rating".'
        );
    }
    if (opts.watched !== undefined || opts.watched_by !== undefined) {
        throw new Error(
            'No watch state is read for music, so `watched` would report every artist as unwatched. Drop it, or ask without kind: "artist".'
        );
    }
}

/**
 * The same refusal for books, asked only when the caller named `kind: "book"`.
 *
 * Unlike an artist, a book also refuses `presence`: no media server reads
 * books, so every book reads `unknown` and the filter could only ever answer
 * all of them or none. `monitored` the same way: Grimmory has no monitoring,
 * so every book reads `false`. Without a kind, all of these drop books through the
 * normal path in `buildGetLibrary`.
 */
function rejectFilmFiltersOnBooks(opts: LibraryQuery): void {
    if (opts.kind !== 'book') return;

    if (
        opts.rating_source !== undefined ||
        opts.min_rating !== undefined ||
        opts.sort === 'rating' ||
        opts.watched_by !== undefined ||
        opts.presence !== undefined ||
        opts.monitored !== undefined
    ) {
        throw new Error(
            'A Grimmory book carries no rating, no monitoring and no media-server presence, only the read status of the one account arr-mcp signs in as. Drop min_rating, rating_source, sort: "rating", watched_by, presence and monitored.'
        );
    }
}

/** A book's size, small enough that a whole-megabyte figure would read as nothing. */
const bookSize = (bytes: number): string =>
    bytes >= 1024 ** 3
        ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
        : bytes >= 1024 ** 2
          ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
          : `${Math.max(1, Math.round(bytes / 1024))} KB`;

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

/** `playback.empty` only where it decides something: on media nothing manages, whether there is anything to adopt. */
export const withoutEmpty = (item: MergedItem): MergedItem => {
    if (item.playback?.empty === undefined || item.presence === 'jellyfin_only') return item;
    const { empty: _e, ...playback } = item.playback;
    return { ...item, playback };
};

const project = (whole: MergedItem, detail: DetailLevel): MergedItem => {
    const item = withoutEmpty(whole);
    if (detail === 'full') return item;
    if (detail === 'minimal') {
        return {
            kind: item.kind,
            title: item.title,
            ...(item.year === undefined ? {} : { year: item.year }),
            ...(item.albumCount === undefined ? {} : { albumCount: item.albumCount }),
            ids: item.ids,
            presence: item.presence,
            ...(item.media_servers === undefined ? {} : { media_servers: item.media_servers })
        };
    }
    // `seasons` joins `genres` here rather than riding along: it is the largest
    // optional field an item can carry, and `standard` is the default every
    // caller gets who did not ask for season arithmetic. `minimal` already
    // excludes it by naming its fields explicitly.
    // `acquisition.path` goes the same way (#518): a fenced folder path on
    // every row was a sixth of a standard page, and a question that needs the
    // folder is about one title, which get_media_details answers.
    const { genres: _g, seasons: _s, ...rest } = item;
    if (rest.acquisition?.path === undefined) return rest;
    const { path: _p, ...acquisition } = rest.acquisition;
    return { ...rest, acquisition };
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

/**
 * One library item as a line of text, for the summary block `listText` builds.
 *
 * The title keeps its fence. Unfencing for display would strip the "this is
 * service data, not instruction" marker from the one half of the response a
 * client is guaranteed to put in front of the model, which is exactly where it
 * earns its keep — `unfenced()` exists for matching and sorting, never output.
 *
 * The managing service's id comes first among the ids because it is the value
 * the write tools take as `instance`/`id`; the external ones follow so a model
 * can cross-reference without a second call.
 */
export function libraryLine(item: MergedItem): string {
    const facts: string[] = [item.kind];
    if (item.acquisition?.id !== undefined) facts.push(`${item.acquisition.service}:${item.acquisition.id}`);
    for (const source of ['tmdb', 'tvdb', 'imdb', 'mbid'] as const) {
        const id = item.ids[source];
        if (id !== undefined) facts.push(`${source}:${id}`);
    }
    if (item.acquisition?.hasFile === false) facts.push('no file');
    if (item.playback?.watched === true) facts.push('watched');
    if (item.playback?.empty === true && item.presence === 'jellyfin_only') facts.push('empty folder');
    // A book's format and size are what tell two copies of it apart. Never its
    // `monitored`, which is always false: Grimmory has no monitoring.
    if (item.kind === 'book') {
        if (item.acquisition?.quality !== undefined) facts.push(item.acquisition.quality);
        if (item.acquisition?.sizeBytes !== undefined) facts.push(bookSize(item.acquisition.sizeBytes));
        if (item.library !== undefined) facts.push(`in ${item.library}`);
    }

    if (item.albumCount !== undefined) facts.push(`${item.albumCount} albums`);
    return `${titled(item.title, item.year)} — ${facts.join(', ')}`;
}

export async function buildGetLibrary(loader: LibraryLoader, opts: LibraryQuery): Promise<GetLibraryResult> {
    rejectImpossibleFilters(opts);

    const { index, degraded, counts, note: libraryNote } = await loader.load(opts.watched_by);

    const genre = opts.genre?.toLowerCase();
    const quality = opts.quality?.toLowerCase();
    const library = opts.library?.toLowerCase();
    const addedSince = opts.added_since === undefined ? undefined : Date.parse(opts.added_since);

    const filtered = index.all().filter(item => {
        if (opts.kind !== undefined && item.kind !== opts.kind) return false;
        if (opts.year !== undefined && item.year !== opts.year) return false;
        if (genre !== undefined && !(item.genres ?? []).some(g => unfenced(g).toLowerCase() === genre)) return false;
        // Books carry monitored: false by type, but nothing monitors them.
        if (opts.monitored !== undefined && item.kind === 'book') return false;
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
        //
        // Music is the exception. Lidarr reads no watch state, and the media
        // server's artist rows carry playback without `watched`, so both count
        // as unwatched and `watched: false` would answer with every artist —
        // 1,600 rows of the whole music collection. Left out, as they are for
        // rating and quality. With `kind: "artist"` named, rejecting the filter
        // says so instead; this is the unnamed case.
        //
        // A book's watch state is its read status for the one account arr-mcp
        // signs in as, so `watched` filters it but `watched_by` cannot ask about
        // anyone else. A book has no presence: every book reads
        // `unknown`, so `presence: "unknown"` would otherwise answer with the
        // whole book library as if a media server were down.
        if ((opts.watched !== undefined || opts.watched_by !== undefined) && item.kind === 'artist') return false;
        if (opts.watched_by !== undefined && item.kind === 'book') return false;
        if (opts.watched !== undefined && (item.playback?.watched ?? false) !== opts.watched) return false;
        if (opts.presence !== undefined && (item.kind === 'book' || item.presence !== opts.presence)) return false;
        if (opts.missing_from !== undefined && item.media_servers?.[opts.missing_from]?.present !== false) return false;
        if (quality !== undefined) {
            // Series are excluded rather than compared: they have no
            // series-level quality to compare against.
            if (item.kind !== 'movie' && item.kind !== 'book') return false;
            if ((item.acquisition?.quality ?? '').toLowerCase() !== quality) return false;
        }
        if (library !== undefined && (item.library === undefined || unfenced(item.library).toLowerCase() !== library)) return false;
        if (addedSince !== undefined) {
            const added = Date.parse(item.acquisition?.addedAt ?? '');
            if (!Number.isFinite(added) || added < addedSince) return false;
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
        return {
            ...shaped,
            items: shaped.items.map(i => project(i, opts.detail)),
            degraded,
            counts,
            ...(libraryNote === undefined ? {} : { note: libraryNote })
        };
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
        },
        ...(libraryNote === undefined ? {} : { note: libraryNote })
    };
}

const getLibraryInput = byMediaServers(ids => toolInput({
    kind: z
        .enum(['movie', 'series', 'artist', 'book'])
        .meta({ [KINDS_KEY]: true })
        .optional()
        .describe('Only {{or: radarr=films; sonarr|whisparr=series; lidarr=Lidarr artists; grimmory=Grimmory books}}; omit for all.'),
    year: z.number().int().optional(),
    genre: z.string().min(1).optional().describe('Matched case-insensitively against the *arr genres.'),
    monitored: z.boolean().optional(),
    has_file: z
        .boolean()
        .optional()
        .describe(
            'Whether a file is on disk; for an artist, any track.'
        ),
    watched: z.boolean().optional().describe('The media server\'s watch state[[grimmory: , or a Grimmory book\'s read status]]; pair with `user` for someone else.'),
    user: UserSchema,
    // Undocumented on purpose: the spelling this tool had when the
    // surface froze at 1.0, where `get_playback` and `get_requests`
    // already called the same thing `user`. Kept working forever —
    // removing it would break a saved prompt silently — but
    // described nowhere.
    watched_by: UserSchema,
    quality: z.string().min(1).optional().describe("Films, or a book's file format such as EPUB."),
    library: z.string().min(1).optional().describe('[[grimmory: A Grimmory library, by name; matches books only.]]'),
    added_since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}/, 'must start with an ISO 8601 date (YYYY-MM-DD), e.g. "2026-08-01" or "2026-08-01T00:00:00Z".')
        .optional()
        .describe('Only items added at or after this ISO 8601 date; items with none are left out.'),
    min_rating: z
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe(
            'Minimum rating on a 0-10 scale, whatever the source.'
        ),
    rating_source: z
        .enum(RATING_SOURCES)
        .optional()
        .describe('Which rating `min_rating` and `sort: "rating"` use; defaults to the best-covered source.'),
    presence: z
        .enum(['both', 'arr_only', 'jellyfin_only', 'unknown'])
        .optional()
        .describe(
            'both, arr_only (likely broken import), jellyfin_only (unmanaged, any media server) or unknown (the other half was not read)' +
                // Joined with a semicolon, not a new sentence: each field keeps to one sentence.
                (ids === undefined ? '.' : '; with two media servers, measured against the primary.')
        ),
    ...(ids === undefined
        ? {}
        : {
              missing_from: z
                  .enum(ids)
                  .optional()
                  .describe(
                      'Items this media server reported it does not have.'
                  )
          }),
    sort: z
        .enum(SORT_FIELDS)
        .optional()
        .describe(
            'Order applied before `limit`: rating, added and year descending, title ascending.'
        ),
    detail: DetailSchema,
    limit: LimitSchema,
    offset: OffsetSchema
}, { undocumented: ['watched_by'] }));

const getLibraryOutput = byMediaServers(ids => PagedOutputSchema.extend({
    note: z
        .string()
        .optional()
        .describe(
            'Present when a fact about the stack\'s config, not this call, needs stating — no media server configured at all, or one configured with no default_user.' +
                withBoth(ids, 'Also when the secondary media server is not read because its default_user is missing (Jellyfin) or matches no user.')
        )
}));

export function registerGetLibrary(
    server: McpServer,
    loader: LibraryLoader,
    mediaServerIds?: [string, string],
    /** Only for the cards' download state, read from the *arrs' queues. */
    adapters: readonly ServiceAdapter[] = [],
    /** `tools.media_cards`. */
    mediaCards = true
): void {
    server.registerTool(
        'get_library',
        {
            title: 'Library',
            annotations: READ_ONLY,
            ...(mediaCards ? { _meta: mediaCardsToolMeta() } : {}),
            description:
                'Your library joined across {{and: radarr=Radarr; sonarr=Sonarr; whisparr=Whisparr; lidarr=Lidarr; grimmory=Grimmory}} and your media server on shared external ids. Use it for filtered lists and counts; for one title use get_media_details. `presence` is what no single service can tell: `arr_only` with a file is a likely broken import, `jellyfin_only` (spelled that way for any media server) is media nothing manages, and `unknown` means the other half was not read. When `degraded` or `note` explain a gap, report that reason rather than calling it unwatched or unrated. `has_file: false` with `monitored: true` is what you are still waiting for. [[lidarr: An artist\'s `monitored` is the artist-level flag, not the album flag; its albums and their ids come from get_media_details on the Lidarr artist.]] A series has an IMDb rating only with the IMDb dataset on, so ask `rating_source: "imdb"` explicitly. Series `seasons` and folder paths need `detail: "full"`. Field reference: arr://docs/get_library.' +
                withBoth(
                    mediaServerIds,
                    'With two media servers, `presence`, `playback` and `seasons` describe the primary, and `media_servers` says per server whether it has the item and under which `itemId`; a server missing from that map was not read. The non-primary server is matched on tmdb, tvdb or imdb ids, so an item it holds without any reads `present: false`. Items only the non-primary server has do not appear here; search_media finds them.'
                ),
            outputSchema: getLibraryOutput(mediaServerIds),
            inputSchema: getLibraryInput(mediaServerIds)
        },
        async (input, ctx) => {
            const { user, watched_by, ...rest } = input as LibraryQuery & { user?: string };
            const watchedBy = preferred({ name: 'user', value: user, alias: 'watched_by', aliasValue: watched_by });

            const result = await buildGetLibrary(loader, {
                ...rest,
                ...(watchedBy === undefined ? {} : { watched_by: watchedBy })
            });

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
            // Same reasoning as `coverage` above: the summary line is what a
            // reader who never opens `structuredContent` actually sees.
            const note = result.note === undefined ? '' : ` ${result.note}`;

            const summary = `${result.returned} of ${result.total} item(s).${coverage}${missing}${note}`;

            // Same snapshot `buildGetLibrary` just read (cached per user): the
            // items are projected copies, and the index holds their artwork
            // and their full acquisition half.
            const cards = wantsCards(mediaCards, server, ctx)
                ? await cardsFromLibrary(result.items, (await loader.load(watchedBy)).index, adapters)
                : undefined;

            return withCards({ content: [{ type: 'text' as const, text: listText(summary, result.items, libraryLine) }], structuredContent: result }, cards);
        }
    );
}
