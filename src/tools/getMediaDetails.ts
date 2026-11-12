import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { servicesOnly } from '../core/gather.ts';
import { filmOrSeriesMatch, isFilmOrSeries, type FilmOrSeries } from '../core/resolver.ts';
import { DetailSchema, LimitSchema, READ_ONLY, toolInput, type DetailLevel } from '../core/shape.ts';
import { logger } from '../core/logger.ts';
import { enrichWithImdb } from '../metadata/enrich.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import { hasMediaDetails, type CleanupStatus, type EpisodeSummary, type MediaDetails, type SearchHit, type ServiceAdapter } from '../services/types.ts';
import { removalSentence, upcomingSentence, withCleanup } from './cleanupStatus.ts';
import type { LibraryLoader } from './library.ts';
import { buildSearchMedia, searchLine } from './searchMedia.ts';
import { withBoth } from './mediaServers.ts';
import { withoutDisplay } from '../core/display.ts';
import { mediaCardsToolMeta, wantsCards, withCards } from '../mcp/apps.ts';
import { cardFromDetails } from '../ui/mediaCards.ts';

/**
 * Unlike the list tools, this one **throws rather than degrades**. A request
 * for one specific item either produced that item or did not, and an empty
 * success would read as "the item does not exist".
 */
export async function buildGetMediaDetails(
    adapters: readonly ServiceAdapter[],
    opts: { service: ServiceId; instance?: string | undefined; id: string; detail: DetailLevel; limit: number },
    dataset?: ImdbDataset
): Promise<MediaDetails> {
    const adapter = resolveInstance(adapters, opts.service, opts.instance);
    if (!hasMediaDetails(adapter)) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no media details to return`, {
            remedy: 'Only radarr, sonarr, lidarr and jellyfin can answer get_media_details.'
        });
    }

    const details = await adapter.getMediaDetails(opts.id, {
        includeEpisodes: opts.detail === 'full',
        episodeLimit: opts.limit
    });

    // A single-item array through the same function the library uses, so one
    // title cannot get a different rating depending on which tool asked.
    const rated = enrichWithImdb([details], dataset)[0] as MediaDetails;

    return withSeerrRatings(adapters, rated);
}

/**
 * Rotten Tomatoes, and IMDb for a film, from Seerr.
 *
 * Only here, on both forms, and only for one item. It costs an HTTP call per
 * title, so it has no business on a path that returns a page of them;
 * `search_media` with `source: "discover"` uses the `voteAverage` Seerr already puts in its search
 * payload instead.
 *
 * Worth the call here because this is the "tell me everything about this one
 * thing" tool, and Rotten Tomatoes is the one score nothing else in the stack
 * can supply for a series. Never overwrites: the managing service is the
 * authority on its own data, and Radarr already reports RT for films.
 */
async function withSeerrRatings<T extends { kind: string; ids: { tmdb?: number }; ratings?: Record<string, number> }>(
    adapters: readonly ServiceAdapter[],
    details: T
): Promise<T & { seerrBlocklisted?: true }> {
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);
    const tmdb = details.ids.tmdb;
    if (seerr === undefined || tmdb === undefined) return details;

    const kind = details.kind === 'series' ? 'series' : 'movie';
    const [extra, blocklisted] = await Promise.all([seerr.getRatings(tmdb, kind), blocklistedIn(seerr, tmdb, details.kind)]);

    const merged = { ...extra, ...details.ratings };
    const rated = Object.keys(merged).length === 0 ? details : { ...details, ratings: merged };
    return blocklisted ? { ...rated, seerrBlocklisted: true } : rated;
}

/**
 * Whether Seerr refuses requests for this film or series (#602), so a caller
 * deciding whether to delete or re-add it knows. Only ever `true`: absent
 * covers "not blocklisted" and "could not tell", and the second degrades
 * rather than failing the details it decorates, as the ratings do.
 */
async function blocklistedIn(seerr: SeerrAdapter, tmdb: number, kind: string): Promise<boolean> {
    if (kind !== 'movie' && kind !== 'series') return false;
    try {
        return await seerr.isBlocklisted(tmdb, kind === 'series' ? 'tv' : 'movie');
    } catch (err) {
        logger.warn({ service: seerr.id, tmdb, err }, 'seerr blocklist lookup failed; continuing without it');
        return false;
    }
}

type MediaDetailsQuery = {
    query?: string;
    service?: ServiceId;
    instance?: string | undefined;
    id?: string;
    detail: DetailLevel;
    limit: number;
};

/**
 * The resolved form: the merged record the join exists for.
 *
 * Like the explicit form, it **throws rather than degrading**. A request for
 * one specific item either produced that item or did not, and an empty success
 * would read as "the item does not exist".
 */
/** Another film or series the title matched exactly as well as the answer did. */
type MatchCandidate = Pick<FilmOrSeries, 'kind' | 'title' | 'year' | 'ids'> & {
    acquisition?: { service: string; id?: string };
};

export type ResolvedMediaDetails = FilmOrSeries & {
    episodes?: EpisodeSummary[];
    episodeCount?: number;
    episodesTruncated?: boolean;
    /**
     * Set when other films or series matched the title as well as this one
     * did: the same tier of exact, prefix or substring, on any of their names.
     * The record is still the best guess; `candidates` are the others, so a
     * caller can name one by `service` and `id` instead (#517).
     */
    ambiguous?: true;
    candidates?: MatchCandidate[];
};

/**
 * No film or series in the library matches. The plain message says only that;
 * `get_media_details` itself adds what a metadata lookup knows, so a caller
 * gets the whole answer to "do I have this, and if not what is it" at once.
 */
export class NotInLibrary extends Error {
    readonly query: string;
    constructor(query: string, hedge: string) {
        super(`Nothing in your library matches "${query}".${hedge}`);
        this.name = 'NotInLibrary';
        this.query = query;
    }
}

/** Enough to say what the title is without paging through every edition. */
const MAX_LOOKUP_HITS = 5;

/**
 * The miss, finished: what a discover search would have said, in the same answer.
 *
 * Without it a model that asked for a title the library lacks went on to
 * `search_media`, `get_library` and a discover search in turn, three to five calls
 * to learn what this one lookup says (#518's eval). The lookup is a read, and
 * a failing one only drops the extra: the miss itself is still the answer.
 */
export async function explainMiss(adapters: readonly ServiceAdapter[], miss: NotInLibrary, dataset?: ImdbDataset): Promise<Error> {
    let found: SearchHit[];
    let unreachable: string[];
    try {
        // `standard`, not `minimal`: the year is what tells a remake from the original.
        // Films and series only, asked for before the limit: five artists and
        // books ranked first would leave the filter below nothing to keep.
        const lookup = await buildSearchMedia(
            adapters,
            { query: miss.query, source: 'discover', detail: 'standard', limit: MAX_LOOKUP_HITS, kinds: ['movie', 'series'] },
            dataset
        );
        found = lookup.items;
        unreachable = lookup.degraded;
    } catch (err) {
        logger.warn({ err }, 'lookup after a library miss failed; answering with the miss alone');
        return new Error(`${miss.message} search_media \`source: "discover"\` says what it is and how to add it.`, { cause: miss });
    }
    const films = found.filter(h => h.kind === 'movie' || h.kind === 'series');
    if (films.length === 0) {
        // An empty lookup is only a fact about the title when every service answered it.
        return new Error(
            unreachable.length === 0
                ? `${miss.message} No metadata lookup knows that title either, so check the spelling.`
                : `${miss.message} The metadata lookup could not reach ${unreachable.join(', ')}; search_media \`source: "discover"\` can try again.`,
            { cause: miss }
        );
    }
    return new Error(
        `${miss.message} Not in your library, but known as: ${films.map(searchLine).join('; ')}. ` +
            'To get one, add_media takes its tmdb id (a film) or tvdb id (a series), or request_media asks through Seerr. No further search is needed.',
        { cause: miss }
    );
}

/** Enough to tell the candidates apart and to ask for one by id. */
const MAX_CANDIDATES = 5;

const toCandidate = (item: FilmOrSeries): MatchCandidate => ({
    kind: item.kind,
    title: item.title,
    ...(item.year === undefined ? {} : { year: item.year }),
    ids: item.ids,
    ...(item.acquisition === undefined
        ? {}
        : {
              acquisition: {
                  service: item.acquisition.service,
                  ...(item.acquisition.id === undefined ? {} : { id: item.acquisition.id })
              }
          })
});

export async function buildResolvedMediaDetails(
    loader: LibraryLoader,
    query: string,
    /** Optional and last: only a series at `detail: "full"` reads it, and the
     *  callers that want the merged record alone stay unchanged. */
    opts?: { adapters: readonly ServiceAdapter[]; detail: DetailLevel; limit: number }
): Promise<ResolvedMediaDetails> {
    const { index, degraded } = await loader.load();
    const ranked = index.searchRanked(query);
    const found = filmOrSeriesMatch(
        ranked.map(h => h.item),
        query
    );

    if (found === undefined) {
        // `diagnose_media` (via its own `resolve` step) and `get_library` both hedge
        // this exact claim across a degraded load; this is the third consumer
        // of the same `LibraryLoader` snapshot, and answering confidently
        // across the same hole is not a different situation. Named services,
        // not just "something failed"; a model deciding whether to retry
        // needs to know which ones.
        //
        // Source-scoped ids are excluded (`gather.ts`'s `servicesOnly`): a
        // source like `jellyfin:seasons` intersects its own series list with
        // this user's episodes, so it can only ever *add* `seasons` to items
        // another source already returned. It can never be why a title was not
        // found, and saying it might be is a hedge against nothing. The same
        // goes for the secondary media server, whose rows never enter the join,
        // and for a book-only source: a book can never be the answer here.
        const secondary = loader.secondaryMediaServerId;
        const books = loader.bookSourceIds ?? [];
        const unreachable = servicesOnly(degraded).filter(id => id !== secondary && !books.includes(id));
        const hedge =
            unreachable.length === 0
                ? ''
                : ` ${unreachable.join(', ')} could not be reached, so this may be incomplete rather than a real absence.`;
        throw new NotInLibrary(query, hedge);
    }

    // Only ties count: a title one item matches exactly and another merely
    // contains ("Runner" against "Cyberpunk: Edgerunners") has a clear answer.
    const bestRank = ranked.find(h => h.item === found)?.rank;
    const others = ranked
        .filter(h => h.item !== found && h.rank === bestRank)
        .map(h => h.item)
        .filter(isFilmOrSeries);
    const best: ResolvedMediaDetails =
        others.length === 0
            ? found
            : { ...found, ambiguous: true, candidates: others.slice(0, MAX_CANDIDATES).map(toCandidate) };

    if (opts === undefined || opts.detail !== 'full' || best.kind !== 'series') return best;

    // The merged record has no episodes of its own; no service contributes
    // them to the join, because ten thousand episode rows in a library
    // snapshot would cost every caller who never asked. So they are fetched
    // here, from the Sonarr that manages this series, using the id
    // `acquisition.id` now carries.
    const service = best.acquisition?.service;
    const id = best.acquisition?.id;
    if (service === undefined || id === undefined) return best;

    const adapter = opts.adapters.find(a => a.id === service);
    if (adapter === undefined || !hasMediaDetails(adapter)) return best;

    try {
        const raw = await adapter.getMediaDetails(id, { includeEpisodes: true, episodeLimit: opts.limit });
        return {
            ...best,
            ...(raw.episodes === undefined ? {} : { episodes: raw.episodes }),
            ...(raw.episodeCount === undefined ? {} : { episodeCount: raw.episodeCount }),
            ...(raw.episodesTruncated === undefined ? {} : { episodesTruncated: raw.episodesTruncated })
        };
    } catch (err) {
        // The merged record *is* the answer here; episodes are the extra. A
        // Sonarr that will not list them must not turn a good answer into an
        // error the caller reads as "no such series".
        logger.warn({ service, err }, 'episode read failed; answering without episodes');
        return best;
    }
}

/**
 * Two forms, both deliberate. `query` returns the merged record;
 * `service` + `id` returns one service's raw view, which is how you inspect a
 * join that looks wrong and what `diagnose_media` needs when `presence` says the two
 * halves disagree.
 */
export async function resolveMediaDetails(
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader,
    opts: MediaDetailsQuery,
    /** The by-id branch rates with it, and a by-title miss rates the lookup
     *  hits it adds. A by-title hit resolves through the library index, which
     *  `LibraryLoader` has already enriched. */
    dataset?: ImdbDataset
): Promise<MediaDetails | ResolvedMediaDetails> {
    // The explicit id wins when both are given: an id is unambiguous and a
    // title is not.
    if (opts.service !== undefined && opts.id !== undefined) {
        const details = await buildGetMediaDetails(adapters, {
            service: opts.service,
            ...(opts.instance === undefined ? {} : { instance: opts.instance }),
            id: opts.id,
            detail: opts.detail,
            limit: opts.limit
        }, dataset);
        return withCleanup(adapters, details);
    }

    if (opts.query === undefined) {
        // Not a ServiceError: no service failed, and ServiceError needs a
        // ServiceId that would misattribute the fault to one.
        throw new Error('Name either a query (a title) or both service and id.');
    }

    let resolved: ResolvedMediaDetails;
    try {
        resolved = await buildResolvedMediaDetails(loader, opts.query, { adapters, detail: opts.detail, limit: opts.limit });
    } catch (err) {
        if (err instanceof NotInLibrary) throw await explainMiss(adapters, err, dataset);
        throw err;
    }
    return withCleanup(adapters, await withSeerrRatings(adapters, resolved));
}

const GetMediaDetailsInput = toolInput({
    query: z
        .string()
        .min(1)
        .optional()
        .describe(
            'A title, matched against every title the services know (original and alternate titles too). When other items match equally well, the answer carries `ambiguous: true` and their `candidates`. A title not in your library is refused with what a metadata lookup knows of it, so no other search is needed.'
        ),
    service: ServiceIdSchema.optional().describe('With `id`: one service’s own view.'),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    id: z.string().min(1).optional().describe("The item's id within that service."),
    detail: DetailSchema,
    limit: LimitSchema
});

const GetMediaDetailsOutput = z.looseObject({
    kind: z.enum(['movie', 'series', 'item', 'artist', 'book']),
    title: z.string()
});

export function registerGetMediaDetails(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader,
    dataset?: ImdbDataset,
    mediaServerIds?: [string, string],
    /** `tools.media_cards`. */
    mediaCards = true
): void {
    server.registerTool(
        'get_media_details',
        {
            title: 'Media details',
            annotations: READ_ONLY,
            ...(mediaCards ? { _meta: mediaCardsToolMeta() } : {}),
            description:
                'Everything known about one item. A title as `query` returns the merged record (acquisition, watch state, ratings, presence across services); `service` plus `id` returns that service\'s raw view, for checking a join that looks wrong. A series carries `seasons` with per-season watched, on-disk, aired and total counts[[sonarr|whisparr: , and `monitored`, the *arr\'s own flag: check it before delete_episode_files, because deleting a monitored season\'s files makes it download them again]]. At `detail: "full"` a series lists its episodes[[lidarr:  and a Lidarr artist its albums with their ids]]. `audioLanguages` (per episode for a series, on the record for a film) are the tracks read off the file: that, not a `MULTi` release name, answers "is the dub here". [[reclaimerr: With Reclaimerr, `cleanup` says what will delete or move it, and when.]] Field reference: arr://docs/get_media_details.' +
                withBoth(mediaServerIds, 'With two media servers, `media_servers` says which has it and under which `itemId`.'),
            /**
             * One item, and the only tool answering in two different shapes:
             * asked by title it returns the merged record, asked by `service`
             * plus `id` it returns that one service's own view. Only what both
             * carry is declared; enumerating either branch would make the
             * schema reject the other, and a mismatch fails the whole call.
             *
             * `artist` is the Lidarr raw view. The title form refuses an artist,
             * but `service: "lidarr"` plus an artist id answers with one, and it
             * is the route every artist refusal names for album ids. Without it
             * here the SDK rejects the result and the caller never sees it.
             * `book` is Grimmory's, by `service` plus `id` only.
             */
            outputSchema: GetMediaDetailsOutput,
            inputSchema: GetMediaDetailsInput
        },
        async ({ query, service, instance, id, detail, limit }, ctx) => {
            const result = await resolveMediaDetails(adapters, loader, {
                ...(query === undefined ? {} : { query }),
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                ...(id === undefined ? {} : { id }),
                detail,
                limit
            }, dataset);

            // `unknown` is not a place something is "present in"; it is the
            // absence of a confident answer, so it gets its own phrasing
            // rather than reading as
            // "present in: unknown."
            const summary =
                'presence' in result
                    ? (result.presence === 'unknown'
                          ? `${result.kind}, presence could not be determined.`
                          : `${result.kind}, present in: ${result.presence}.`) +
                      // The title form fetches episodes too now, so it owes
                      // the same count the raw form has always given.
                      (result.episodes === undefined
                          ? ''
                          : ` ${result.episodes.length} of ${result.episodeCount ?? result.episodes.length} episode(s).`)
                    : result.kind === 'book'
                      ? `book from ${result.service}${result.book === undefined ? '.' : `, in ${result.book.library}; ${result.book.formats.length === 0 ? 'no files.' : `formats: ${result.book.formats.map(f => f.format).join(', ')}.`}`}`
                      : `${result.kind} from ${result.service}` +
                      // `episodes` is only fetched at detail: full. Reporting
                      // "0 of 62" below that read as an empty series rather
                      // than as episodes nobody asked for.
                      (result.episodeCount === undefined
                          ? '.'
                          : result.episodes === undefined
                            ? `, ${result.episodeCount} episode(s). Ask for detail: full to list them.`
                            : `, ${result.episodes.length} of ${result.episodeCount} episode(s).`);

            const cleanup = 'cleanup' in result ? (result.cleanup as CleanupStatus) : undefined;
            const cleanupNote =
                cleanup === undefined
                    ? ''
                    : ` ${upcomingSentence(cleanup.service, cleanup.candidates) ?? (cleanup.removals[0] === undefined ? '' : removalSentence(cleanup.service, cleanup.removals[0]))}`.trimEnd();

            // The card reads artwork from the library snapshot the title form
            // resolved through (cached, so no second fan-out), or from the
            // service's own view; neither reaches the answer itself.
            const cards = wantsCards(mediaCards, server, ctx)
                ? await cardFromDetails(result, 'presence' in result ? (await loader.load()).index : undefined, adapters)
                : undefined;
            const answer = 'display' in result ? withoutDisplay(result) : result;

            return withCards({ content: [{ type: 'text' as const, text: summary + cleanupNote }], structuredContent: answer }, cards);
        }
    );
}
