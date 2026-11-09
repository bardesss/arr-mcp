import type { Display } from '../core/display.ts';
import { logger } from '../core/logger.ts';
import type { LibraryIndex, MergedItem } from '../core/resolver.ts';
import { literalTitle, unfenced } from '../core/titleMatch.ts';
import { hasQueue, type MediaDetails, type SearchHit, type ServiceAdapter } from '../services/types.ts';

/**
 * Poster cards for an MCP Apps host (`mcp/apps.ts`).
 *
 * A tool answering with films or series adds `cards` to its
 * `structuredContent`; a host that renders MCP Apps loads the card view and
 * hands it the result, and every other client ignores the field. The text
 * `content` is untouched, and so is every item: what only a card needs
 * (artwork, the synopsis) rides on `Display`, which the items never carry.
 *
 * Titles, genres and the synopsis stay fenced. `structuredContent` may reach
 * a model, so the view unfences them for display, never the server.
 */

/**
 * Where the title stands in the stack, in the five words a badge can say.
 *
 * `absent` is not in any *arr; `monitored` is managed and still wanted;
 * `unmonitored` is managed with nothing on disk and nothing looking;
 * `downloaded` has its file (a series: every aired episode, or whatever it
 * has once nothing is looking for more); `downloading` is in the queue now.
 */
export type CardStatus = 'absent' | 'monitored' | 'unmonitored' | 'downloaded' | 'downloading';

export type MediaCard = {
    type: 'movie' | 'series';
    /** Fenced. */
    title: string;
    year?: number;
    ids: { tmdb?: number; tvdb?: number; imdb?: string };
    status: CardStatus;
    qualityProfile?: string;
    poster?: string;
    /** Detail view only. */
    backdrop?: string;
    /** Detail view only. Fenced. */
    overview?: string;
    /** Fenced. */
    genres?: string[];
    runtimeMinutes?: number;
    seasonCount?: number;
    /** Series: episodes on disk against episodes aired. */
    episodes?: { onDisk: number; aired: number };
    links?: { tmdb?: string; imdb?: string };
    /**
     * The managing instance and its id: what a later version of the view
     * passes to a tool (`trigger_search`, `set_monitoring`) through the host.
     * Absent on a title nothing manages.
     */
    ref?: { service: string; id: string };
};

export type MediaCards = {
    view: 'detail' | 'grid';
    items: MediaCard[];
    /** How many films and series the answer held, before the grid's cap. */
    total: number;
};

/** A grid past this is a wall, and every card costs an image request. */
export const MAX_CARDS = 20;

export type StatusFacts = {
    type: 'movie' | 'series';
    inLibrary: boolean;
    monitored?: boolean | undefined;
    hasFile?: boolean | undefined;
    downloading?: boolean | undefined;
    episodes?: { onDisk: number; aired: number } | undefined;
};

export function cardStatus(facts: StatusFacts): CardStatus {
    if (!facts.inLibrary) return 'absent';
    if (facts.downloading === true) return 'downloading';
    const complete =
        facts.type === 'movie'
            ? facts.hasFile === true
            : facts.episodes === undefined
              ? facts.hasFile === true && facts.monitored !== true
              : facts.episodes.aired > 0 && facts.episodes.onDisk >= facts.episodes.aired;
    if (complete) return 'downloaded';
    if (facts.monitored === true) return 'monitored';
    // Nothing is looking for more, so what is on disk is the whole answer.
    return facts.hasFile === true || (facts.episodes?.onDisk ?? 0) > 0 ? 'downloaded' : 'unmonitored';
}

const IMDB_ID = /^tt\d{5,10}$/;

export function externalLinks(type: 'movie' | 'series', ids: MediaCard['ids']): MediaCard['links'] {
    const links = {
        ...(ids.tmdb === undefined || ids.tmdb <= 0 ? {} : { tmdb: `https://www.themoviedb.org/${type === 'movie' ? 'movie' : 'tv'}/${ids.tmdb}` }),
        ...(ids.imdb === undefined || !IMDB_ID.test(ids.imdb) ? {} : { imdb: `https://www.imdb.com/title/${ids.imdb}/` })
    };
    return Object.keys(links).length === 0 ? undefined : links;
}

const isFilmOrSeries = (kind: string): kind is 'movie' | 'series' => kind === 'movie' || kind === 'series';

type CardInput = {
    type: 'movie' | 'series';
    title: string;
    year?: number | undefined;
    ids: { tmdb?: number | undefined; tvdb?: number | undefined; imdb?: string | undefined; mbid?: string | undefined };
    display?: Display | undefined;
    genres?: string[] | undefined;
    qualityProfile?: string | undefined;
    ref?: { service: string; id: string } | undefined;
    facts: Omit<StatusFacts, 'type' | 'episodes'>;
};

function toCard(input: CardInput, view: MediaCards['view']): MediaCard {
    const ids = {
        ...(input.ids.tmdb === undefined || input.ids.tmdb <= 0 ? {} : { tmdb: input.ids.tmdb }),
        ...(input.ids.tvdb === undefined || input.ids.tvdb <= 0 ? {} : { tvdb: input.ids.tvdb }),
        ...(input.ids.imdb === undefined ? {} : { imdb: input.ids.imdb })
    };
    const d = input.display ?? {};
    const episodes = input.type === 'series' ? d.episodes : undefined;
    const links = externalLinks(input.type, ids);
    return {
        type: input.type,
        title: input.title,
        ...(input.year === undefined || input.year <= 0 ? {} : { year: input.year }),
        ids,
        status: cardStatus({ type: input.type, ...input.facts, episodes }),
        ...(input.qualityProfile === undefined ? {} : { qualityProfile: input.qualityProfile }),
        ...(d.poster === undefined ? {} : { poster: d.poster }),
        ...(view === 'detail' && d.backdrop !== undefined ? { backdrop: d.backdrop } : {}),
        ...(view === 'detail' && d.overview !== undefined ? { overview: d.overview } : {}),
        ...(input.genres === undefined || input.genres.length === 0 ? {} : { genres: input.genres }),
        ...(input.type === 'movie' && d.runtimeMinutes !== undefined ? { runtimeMinutes: d.runtimeMinutes } : {}),
        ...(input.type === 'series' && d.seasonCount !== undefined ? { seasonCount: d.seasonCount } : {}),
        ...(episodes === undefined ? {} : { episodes }),
        ...(links === undefined ? {} : { links }),
        ...(input.ref === undefined ? {} : { ref: input.ref })
    };
}

const refKey = (ref: { service: string; id: string } | undefined): string | undefined =>
    ref === undefined ? undefined : `${ref.service}:${ref.id}`;

/**
 * Which managed titles are downloading right now, as `service:id`.
 *
 * One queue read per *arr that manages a card, in parallel. A queue that will
 * not answer only costs the badge its `downloading` state, never the answer.
 */
export async function downloadingRefs(adapters: readonly ServiceAdapter[], services: ReadonlySet<string>): Promise<Set<string>> {
    const queues = adapters.filter(a => services.has(a.id)).filter(hasQueue);
    const settled = await Promise.allSettled(queues.map(async a => ({ service: a.id, rows: await a.getQueue() })));
    const refs = new Set<string>();
    for (const result of settled) {
        if (result.status === 'rejected') {
            logger.debug({ err: result.reason }, 'queue read for media cards failed; cards show no download state');
            continue;
        }
        for (const row of result.value.rows) if (row.mediaId !== undefined) refs.add(`${result.value.service}:${row.mediaId}`);
    }
    return refs;
}

async function finish(inputs: CardInput[], view: MediaCards['view'], adapters: readonly ServiceAdapter[]): Promise<MediaCards> {
    const shown = inputs.slice(0, view === 'detail' ? 1 : MAX_CARDS);
    const services = new Set(shown.flatMap(i => (i.ref === undefined ? [] : [i.ref.service])));
    const downloading = services.size === 0 ? new Set<string>() : await downloadingRefs(adapters, services);
    return {
        view,
        items: shown.map(i =>
            toCard({ ...i, facts: { ...i.facts, downloading: downloading.has(refKey(i.ref) ?? '') } }, view)
        ),
        total: inputs.length
    };
}

/**
 * Who a hit is, across services: the same film answers from Radarr's lookup
 * and from Seerr, and a series from Sonarr (by tvdb) and Seerr (by tmdb), so
 * the title and year are the last resort.
 */
const identities = (i: CardInput): string[] => [
    ...(i.ids.tmdb === undefined ? [] : [`${i.type}:tmdb:${i.ids.tmdb}`]),
    ...(i.ids.tvdb === undefined ? [] : [`${i.type}:tvdb:${i.ids.tvdb}`]),
    `${i.type}:title:${literalTitle(unfenced(i.title))}:${i.year ?? ''}`
];

/** One card per title; the managed copy wins, and lends its artwork gaps from the others. */
function dedupe(inputs: CardInput[]): CardInput[] {
    const out: CardInput[] = [];
    const seen = new Map<string, number>();
    for (const input of inputs) {
        const keys = identities(input);
        const at = keys.map(k => seen.get(k)).find(i => i !== undefined);
        if (at === undefined) {
            for (const k of keys) seen.set(k, out.length);
            out.push(input);
            continue;
        }
        const kept = out[at]!;
        const [winner, loser] = !kept.facts.inLibrary && input.facts.inLibrary ? [input, kept] : [kept, input];
        out[at] = {
            ...winner,
            ids: { ...loser.ids, ...winner.ids },
            display: { ...loser.display, ...winner.display }
        };
        for (const k of [...keys, ...identities(out[at])]) seen.set(k, at);
    }
    return out;
}

/** `search_media` and `lookup_media`: films and series only, releases and artists left out. */
export async function cardsFromHits(hits: readonly SearchHit[], adapters: readonly ServiceAdapter[]): Promise<MediaCards> {
    const inputs = hits.flatMap((h): CardInput[] => {
        if (!isFilmOrSeries(h.kind) || h.source === 'indexers') return [];
        const inLibrary = h.source === 'library' || h.display?.inLibrary === true;
        return [
            {
                type: h.kind,
                title: h.title,
                year: h.year,
                ids: h.ids,
                display: h.display,
                ...(inLibrary && h.id !== '' ? { ref: { service: h.service, id: h.id } } : {}),
                facts: { inLibrary, monitored: h.monitored, hasFile: h.hasFile }
            }
        ];
    });
    return finish(dedupe(inputs), 'grid', adapters);
}

/**
 * `item` may be a projected copy (`detail: "minimal"` drops `acquisition`), so
 * the facts are read from the index's own record when there is one.
 */
function fromMerged(projected: MergedItem, index: LibraryIndex | undefined): CardInput | undefined {
    if (!isFilmOrSeries(projected.kind)) return undefined;
    const indexed = index?.find(projected.ids, projected.kind);
    const item = indexed ?? projected;
    const a = item.acquisition;
    return {
        type: projected.kind,
        title: item.title,
        year: item.year,
        ids: item.ids,
        display: indexed === undefined ? undefined : index?.displayOf(indexed),
        genres: item.genres,
        qualityProfile: a?.qualityProfile,
        ...(a?.id === undefined ? {} : { ref: { service: a.service, id: a.id } }),
        // A title only the media server has is on disk all the same.
        facts:
            a === undefined
                ? { inLibrary: item.presence === 'jellyfin_only', hasFile: item.presence === 'jellyfin_only' }
                : { inLibrary: true, monitored: a.monitored, hasFile: a.hasFile }
    };
}

/** `get_library`. `index` is the snapshot the items came from, which holds their artwork. */
export async function cardsFromLibrary(
    items: readonly MergedItem[],
    index: LibraryIndex | undefined,
    adapters: readonly ServiceAdapter[]
): Promise<MediaCards> {
    const inputs = items.map(i => fromMerged(i, index)).filter((i): i is CardInput => i !== undefined);
    return finish(inputs, 'grid', adapters);
}

/**
 * `get_media_details`, either form. A merged record (asked by title) has its
 * artwork in the index; a service's own view (asked by id) carries it.
 */
export async function cardFromDetails(
    result: MergedItem | MediaDetails,
    index: LibraryIndex | undefined,
    adapters: readonly ServiceAdapter[]
): Promise<MediaCards | undefined> {
    let input: CardInput | undefined;
    if ('presence' in result) {
        input = fromMerged(result, index);
    } else if (isFilmOrSeries(result.kind)) {
        input = {
            type: result.kind,
            title: result.title,
            year: result.year,
            ids: result.ids,
            display: result.display,
            ref: { service: result.service, id: result.id },
            facts: {
                inLibrary: true,
                monitored: result.monitored,
                hasFile: result.kind === 'movie' ? result.hasFile : (result.display?.episodes?.onDisk ?? 0) > 0
            }
        };
    }
    return input === undefined ? undefined : finish([input], 'detail', adapters);
}
