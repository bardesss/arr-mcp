import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { servicesOnly } from '../core/gather.ts';
import type { MergedItem } from '../core/resolver.ts';
import { DetailSchema, LimitSchema, READ_ONLY, toolInput, type DetailLevel } from '../core/shape.ts';
import { logger } from '../core/logger.ts';
import { enrichWithImdb } from '../metadata/enrich.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import { hasMediaDetails, type EpisodeSummary, type MediaDetails, type ServiceAdapter } from '../services/types.ts';
import type { LibraryLoader } from './library.ts';

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
            remedy: 'Only radarr, sonarr and jellyfin can answer get_media_details.'
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
 * Only here, and only for one item. It costs an HTTP call per title, so it has
 * no business on a path that returns a page of them — `lookup_media` uses the
 * `voteAverage` Seerr already puts in its search payload instead.
 *
 * Worth the call here because this is the "tell me everything about this one
 * thing" tool, and Rotten Tomatoes is the one score nothing else in the stack
 * can supply for a series. Never overwrites: the managing service is the
 * authority on its own data, and Radarr already reports RT for films.
 */
async function withSeerrRatings(
    adapters: readonly ServiceAdapter[],
    details: MediaDetails
): Promise<MediaDetails> {
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);
    const tmdb = details.ids.tmdb;
    if (seerr === undefined || tmdb === undefined) return details;

    const kind = details.kind === 'series' ? 'series' : 'movie';
    const extra = await seerr.getRatings(tmdb, kind);

    const merged = { ...extra, ...details.ratings };
    return Object.keys(merged).length === 0 ? details : { ...details, ratings: merged };
}

export type MediaDetailsQuery = {
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
export type ResolvedMediaDetails = MergedItem & {
    episodes?: EpisodeSummary[];
    episodeCount?: number;
    episodesTruncated?: boolean;
};

export async function buildResolvedMediaDetails(
    loader: LibraryLoader,
    query: string,
    /** Optional and last: only a series at `detail: "full"` reads it, and the
     *  callers that want the merged record alone stay unchanged. */
    opts?: { adapters: readonly ServiceAdapter[]; detail: DetailLevel; limit: number }
): Promise<ResolvedMediaDetails> {
    const { index, degraded } = await loader.load();
    const [best] = index.search(query);

    if (best === undefined) {
        // `diagnose` (via its own `resolve` step) and `get_library` both hedge
        // this exact claim across a degraded load; this is the third consumer
        // of the same `LibraryLoader` snapshot, and answering confidently
        // across the same hole is not a different situation. Named services,
        // not just "something failed" — a model deciding whether to retry
        // needs to know which ones.
        //
        // Source-scoped ids are excluded (`gather.ts`'s `servicesOnly`): a
        // source like `jellyfin:episodes` intersects its own series list with
        // this user's episodes, so it can only ever *add* `seasons` to items
        // another source already returned. It can never be why a title was not
        // found, and saying it might be is a hedge against nothing.
        const unreachable = servicesOnly(degraded);
        const hedge =
            unreachable.length === 0
                ? ''
                : ` ${unreachable.join(', ')} could not be reached, so this may be incomplete rather than a real absence.`;
        throw new Error(
            `Nothing in your library matches "${query}".${hedge} Try search_media, which also looks at what you do not have yet.`
        );
    }

    if (opts === undefined || opts.detail !== 'full' || best.kind !== 'series') return best;

    // The merged record has no episodes of its own — no service contributes
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
 * join that looks wrong and what `diagnose` needs when `presence` says the two
 * halves disagree.
 */
export async function resolveMediaDetails(
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader,
    opts: MediaDetailsQuery,
    /** Only the by-id branch needs this. The by-title branch resolves through
     *  the library index, which `LibraryLoader` has already enriched. */
    dataset?: ImdbDataset
): Promise<MediaDetails | ResolvedMediaDetails> {
    // The explicit id wins when both are given: an id is unambiguous and a
    // title is not.
    if (opts.service !== undefined && opts.id !== undefined) {
        return buildGetMediaDetails(adapters, {
            service: opts.service,
            ...(opts.instance === undefined ? {} : { instance: opts.instance }),
            id: opts.id,
            detail: opts.detail,
            limit: opts.limit
        }, dataset);
    }

    if (opts.query === undefined) {
        // Not a ServiceError: no service failed, and ServiceError needs a
        // ServiceId that would misattribute the fault to one.
        throw new Error('Name either a query (a title) or both service and id.');
    }

    return buildResolvedMediaDetails(loader, opts.query, { adapters, detail: opts.detail, limit: opts.limit });
}

export function registerGetMediaDetails(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader,
    dataset?: ImdbDataset
): void {
    server.registerTool(
        'get_media_details',
        {
            title: 'Media details',
            annotations: READ_ONLY,
            description:
                'Everything known about one item. Give a title as `query` for the merged record — acquisition, watch state, ratings and presence joined across services — or `service` plus `id` for one service’s raw view, which is how you inspect a join that looks wrong — the explicit id wins if both are given. A series at detail: full returns its episodes on **either** form: the raw view lists them from that service, and the title form fetches them from the Sonarr that manages the series — so a series no Sonarr manages carries none. Asked by title, a series also carries `seasons`: per-season `watched` and `lastPlayed` from Jellyfin, `onDisk`, `aired` and `total` from Sonarr, and `complete`, which is absent rather than false whenever it cannot be known. Both forms — by title and by `service` plus `id` — carry `seasons[].monitored`, Sonarr’s own per-season monitoring flag, absent rather than false when no Sonarr manages the series. Check it before delete_episode_files: deleting the files of a season that is still monitored makes Sonarr search for them again and re-download exactly what was removed.',
            /**
             * One item, and the only tool answering in two different shapes:
             * asked by title it returns the merged record, asked by `service`
             * plus `id` it returns that one service's own view. Only what both
             * carry is declared — enumerating either branch would make the
             * schema reject the other, and a mismatch fails the whole call.
             */
            outputSchema: z.looseObject({
                kind: z.enum(['movie', 'series', 'item']),
                title: z.string()
            }),
            inputSchema: toolInput({
                query: z.string().min(1).optional().describe('A title. Resolved through the library index.'),
                service: ServiceIdSchema.optional().describe('With `id`: one service’s own view.'),
                instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
                id: z.string().min(1).optional().describe("The item's id within that service."),
                detail: DetailSchema,
                limit: LimitSchema
            })
        },
        async ({ query, service, instance, id, detail, limit }) => {
            const result = await resolveMediaDetails(adapters, loader, {
                ...(query === undefined ? {} : { query }),
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                ...(id === undefined ? {} : { id }),
                detail,
                limit
            }, dataset);

            // `unknown` is not a place something is "present in" — it is the
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
                    : `${result.kind} from ${result.service}` +
                      // `episodes` is only fetched at detail: full. Reporting
                      // "0 of 62" below that read as an empty series rather
                      // than as episodes nobody asked for.
                      (result.episodeCount === undefined
                          ? '.'
                          : result.episodes === undefined
                            ? `, ${result.episodeCount} episode(s) — ask for detail: full to list them.`
                            : `, ${result.episodes.length} of ${result.episodeCount} episode(s).`);

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
