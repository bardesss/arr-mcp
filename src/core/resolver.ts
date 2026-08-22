import { RANK_NONE, rankTitle, unfenced } from './titleMatch.ts';

export type ExternalIds = { tmdb?: number; tvdb?: number; imdb?: string };

/**
 * Named sources rather than a loose map, which would accept a source name that
 * does not exist.
 *
 * A film populates some subset of the first five; a series populates `tvdb`,
 * plus `imdb` from the IMDb dataset. Sonarr's own rating is one flat value,
 * unrelated to Radarr's per-source map — the two never mix.
 */
export type MergedRatings = {
    imdb?: number;
    tmdb?: number;
    rottenTomatoes?: number;
    trakt?: number;
    metacritic?: number;
    tvdb?: number;
};

/**
 * One season's watch state, joined from two services that each know half of it.
 *
 * Every field but `season` is optional because either half can be missing.
 * `complete` is **absent, never `false`**: a `false` would put a season you had
 * finished onto a list of things still to watch.
 */
export type SeasonSummary = {
    season: number;
    /** Jellyfin: episodes in this season with `UserData.Played`. */
    watched?: number;
    /** Jellyfin: the newest `LastPlayedDate` across the season. */
    lastPlayed?: string;
    /** Sonarr `episodeFileCount` — what is on disk. */
    onDisk?: number;
    /** Sonarr `episodeCount` — what has aired. */
    aired?: number;
    /** Sonarr `totalEpisodeCount` — TVDB's count, including unaired. */
    total?: number;
    /** Computed in `LibraryIndex.build`, never by a service. */
    complete?: boolean;
    /**
     * Sonarr's per-season monitoring flag, so `seasons[].monitored` means the
     * same thing here as on `MediaDetails.seasons` — `get_media_details`
     * returns either shape depending on how it was asked, and a key that
     * carried monitoring on one form and nothing on the other is how a caller
     * reads "no `monitored`" as "not monitored", unmonitors nothing, and
     * deletes files Sonarr immediately re-downloads.
     *
     * **Absent, never `false`**, like every other field here: a series no
     * Sonarr manages has no monitoring at all, and `false` would be a claim
     * about a service that was never asked.
     */
    monitored?: boolean;
};

export type MergedItem = {
    kind: 'movie' | 'series';
    title: string;
    year?: number;
    /**
     * Absent from the record and required because `genre` is a `get_library`
     * filter, and no other field in the merged shape could answer one.
     * Recorded here as a correction to the design rather than bolted on later.
     */
    genres?: string[];
    ids: ExternalIds;
    acquisition?: {
        service: string;
        monitored: boolean;
        hasFile: boolean;
        quality?: string;
        sizeBytes?: number;
        /**
         * When the managing service added it, ISO 8601, as reported.
         *
         * On `acquisition` rather than on the item, deliberately: "when Radarr
         * added this" and Jellyfin's `DateCreated` are different facts, and one
         * field holding both repeats the mistake Sonarr's unlabelled rating
         * taught. Jellyfin-only media has no acquisition half and so no added
         * date, which `sort: 'added'` reports by omission rather than guessing.
         */
        addedAt?: string;
    };
    playback?: { user: string; watched: boolean; playCount?: number; lastPlayed?: string };
    /** Series only. Films have no seasons and carry this field never. */
    seasons?: SeasonSummary[];
    ratings?: MergedRatings;
    /**
     * What no single service can tell you. `arr_only` **with a file** means a
     * broken import; `jellyfin_only` means media nothing is managing.
     *
     * A degraded or unconfigured media server gets `unknown`, never
     * `arr_only` — that claim asserts the server looked and did not find it.
     *
     * The value is named for Jellyfin because it is the only media server
     * today. A second one renames it, with the old name aliased for a minor.
     */
    presence: 'both' | 'arr_only' | 'jellyfin_only' | 'unknown';
};

export type IndexInput = Omit<MergedItem, 'presence'>;

export type BuildOptions = {
    /**
     * Whether the media server's half of this build was gathered — configured
     * *and* read without error. Defaults to `true`.
     *
     * "Looked and found nothing" and "was never asked" both arrive with
     * `playback` unset, and an unset field carries no reason. `LibraryLoader`
     * owns the fetch, so it passes in which one this was.
     */
    playbackGathered?: boolean;
};

/**
 * Namespaced so a film with tmdb 550 never merges with a series carrying
 * tvdb 550 — unrelated id spaces that happen to collide numerically.
 */
const keysOf = (kind: MergedItem['kind'], ids: ExternalIds): string[] => {
    const out: string[] = [];
    if (ids.tmdb !== undefined) out.push(`${kind}:tmdb:${ids.tmdb}`);
    if (ids.tvdb !== undefined) out.push(`${kind}:tvdb:${ids.tvdb}`);
    if (ids.imdb !== undefined) out.push(`${kind}:imdb:${ids.imdb}`);
    return out;
};

/**
 * Joins season rows **per season number**, because the two halves of one row
 * come from different services: Sonarr supplies the denominators, Jellyfin the
 * watch counts.
 *
 * `absorb` replaces `playback` wholesale, which is right for a field one service
 * owns end to end. Doing the same here would let whichever source merged last
 * erase the other's half of every row — and which one merges last depends on
 * adapter order, so the bug would be intermittent rather than obvious.
 *
 * Both mappers omit absent fields rather than setting them undefined, so the
 * spread cannot clobber a known value with a hole.
 */
function mergeSeasons(target: SeasonSummary[] | undefined, input: readonly SeasonSummary[]): SeasonSummary[] {
    const rows = new Map<number, SeasonSummary>();
    for (const row of target ?? []) rows.set(row.season, { ...row });
    for (const row of input) rows.set(row.season, { ...rows.get(row.season), ...row });
    return [...rows.values()].sort((a, b) => a.season - b.season);
}

function mergeInto(target: MergedItem, input: IndexInput): void {
    // The *arr title wins: it is the managed one, and the one a user sees in
    // the service they would go and fix something in.
    if (input.acquisition !== undefined || target.title === '') target.title = input.title;
    // `exactOptionalPropertyTypes` forbids assigning a possibly-undefined value
    // into an optional field, so the incoming value must be known-present.
    if (target.year === undefined && input.year !== undefined) target.year = input.year;
    if (target.genres === undefined && input.genres !== undefined) target.genres = input.genres;

    target.ids = { ...target.ids, ...input.ids };
    if (input.acquisition !== undefined) target.acquisition = input.acquisition;
    if (input.playback !== undefined) target.playback = input.playback;
    if (input.seasons !== undefined) target.seasons = mergeSeasons(target.seasons, input.seasons);
    if (input.ratings !== undefined) target.ratings = { ...target.ratings, ...input.ratings };
}

/**
 * the shared join. Records merge when **any** strong id matches, which is what
 * handles Radarr knowing only `tmdbId` while Jellyfin knows only `Imdb`.
 *
 * Records sharing no id stay separate. That is correct rather than lossy:
 * absent a shared identifier there is no evidence they are the same item, and
 * merging on title similarity is how a remake gets fused with its original.
 */
export class LibraryIndex {
    readonly #items: MergedItem[];
    readonly #byKey: Map<string, MergedItem>;

    private constructor(items: MergedItem[], byKey: Map<string, MergedItem>) {
        this.#items = items;
        this.#byKey = byKey;
    }

    static build(inputs: readonly IndexInput[], opts: BuildOptions = {}): LibraryIndex {
        const playbackGathered = opts.playbackGathered ?? true;
        const byKey = new Map<string, MergedItem>();
        const items: MergedItem[] = [];

        // Membership as a Set, order as the array. `items.includes` per key per
        // input and `indexOf`/`splice` per fusion made this quadratic: a 10k
        // item library is 10^8+ comparisons on every cache-miss build, which on
        // a NAS is seconds of user-facing latency behind a 5-minute TTL.
        // Absorbed groups are dropped from `live` and the array is compacted
        // once, after the loop.
        const live = new Set<MergedItem>();

        for (const input of inputs) {
            const keys = keysOf(input.kind, input.ids);
            // A record can carry ids that already belong to *two* separate
            // groups — e.g. a second Jellyfin copy holding both the tmdb id
            // one group formed around and the imdb id another group formed
            // around. Collecting every distinct match (not just the first)
            // is what lets them be fused instead of orphaning all but one:
            // taking only the first match would leave the other group's only
            // index entry overwritten by the re-index below, unreachable via
            // `find` but still sitting in `#items` reporting stale presence.
            // `byKey` is patched incrementally in this loop (see the re-index
            // comment below) and can still hold a key pointing at a group
            // already spliced out of `items` by an earlier iteration. If such
            // a stale key were allowed to win here, `matches[0]` would be that
            // ghost: `mergeInto` below would write this input's evidence into
            // an object outside `items`, no new item would be created because
            // `matches.length` is not zero, and the evidence would be gone —
            // present nowhere in the final `all()`. Filtering to objects still
            // in `items` is what keeps a spliced-out group from ever winning a
            // later merge.
            const matches = [
                ...new Set(keys.map(k => byKey.get(k)).filter((v): v is MergedItem => v !== undefined))
            ].filter(m => live.has(m));

            if (matches.length === 0) {
                const created: MergedItem = { ...input, presence: 'arr_only' };
                items.push(created);
                live.add(created);
                for (const key of keys) byKey.set(key, created);
                continue;
            }

            // One survivor absorbs the rest. mergeInto reads the *incoming*
            // record's `acquisition` to decide whether its title wins, so
            // fusing a loser this way still lets it win the title over the
            // survivor if the loser is the one carrying acquisition.
            const survivor = matches[0]!;
            for (const loser of matches.slice(1)) {
                mergeInto(survivor, loser);
                live.delete(loser);
            }
            mergeInto(survivor, input);

            // Re-index under every id the survivor now knows — from fused
            // losers and from this input — so a later record carrying any of
            // them still finds this one group *during the build*. This is
            // still an incremental patch, not a removal: it only ever adds or
            // overwrites keys, so a key that used to point at a group later
            // absorbed elsewhere (e.g. the loser fused above) can be left
            // stale here, pointing at an object no longer in `items`.
            for (const key of keysOf(survivor.kind, survivor.ids)) byKey.set(key, survivor);
        }

        // `byKey`, patched incrementally above, can still hold stale entries
        // from groups that were fused away partway through the loop — a key
        // set while a loser was still its own group, never revisited once
        // that group merged into someone else's survivor. Rebuilding from
        // `items` (the authoritative final set) is what guarantees `find`
        // can never return an object `all()` does not contain, and it is
        // also the natural place to compute `presence`: every item here has
        // reached its final, fully-merged shape.
        // Compacted once rather than spliced per fusion — same order, same
        // contents, linear instead of quadratic.
        const merged = items.filter(i => live.has(i));

        const finalByKey = new Map<string, MergedItem>();
        for (const item of merged) {
            item.presence =
                item.acquisition !== undefined && item.playback !== undefined
                    ? 'both'
                    : item.acquisition !== undefined
                      ? // `arr_only` claims the media server looked and found
                        // nothing — not a claim to make when it was never read.
                        playbackGathered
                          ? 'arr_only'
                          : 'unknown'
                      : item.playback !== undefined
                        ? 'jellyfin_only'
                        : 'unknown';
            // Here rather than in `absorb` for the reason `presence` is here:
            // this is the first point at which an item is fully merged, and a
            // verdict computed mid-merge would be computed against half the
            // evidence. `total === 0` is excluded because 0 >= 0 would report a
            // season with no episodes as finished.
            if (item.seasons !== undefined) {
                item.seasons = item.seasons.map(s =>
                    s.total === undefined || s.watched === undefined || s.total === 0
                        ? s
                        : { ...s, complete: s.watched >= s.total }
                );
            }
            for (const key of keysOf(item.kind, item.ids)) finalByKey.set(key, item);
        }

        return new LibraryIndex(merged, finalByKey);
    }

    /**
     * Undefined for an empty id set: no id is not a wildcard.
     *
     * `kind` is optional so today's callers, which do not have one to hand,
     * keep scanning movie keys before series keys unchanged. A caller that
     * *does* know which it wants — `diagnose` will, since it already holds
     * the kind of the thing it is chasing — should pass it: a film and a
     * series can share the same numeric tmdb/tvdb id (unrelated id spaces
     * colliding), and without `kind` the first one indexed wins, silently
     * hiding the other.
     */
    find(ids: ExternalIds, kind?: 'movie' | 'series'): MergedItem | undefined {
        const kinds = kind !== undefined ? [kind] : (['movie', 'series'] as const);
        for (const k of kinds) {
            for (const key of keysOf(k, ids)) {
                const hit = this.#byKey.get(key);
                if (hit !== undefined) return hit;
            }
        }
        return undefined;
    }

    /** Ranked by relevance, non-matches excluded rather than ranked last. */
    search(query: string): MergedItem[] {
        return this.#items
            .map(item => ({ item, rank: rankTitle(item.title, query) }))
            .filter(({ rank }) => rank !== RANK_NONE)
            // Every production title is fenced (`<<untrusted:service.field>>…`),
            // and the fence prefix carries the *service* name. Comparing the
            // raw strings would tie-break alphabetically by service first —
            // "all Jellyfin-sourced items, then all *arr-sourced items" — and
            // only alphabetically by title within each group. unfenced() is
            // what makes the tiebreak compare the title a person reads.
            .sort((a, b) => a.rank - b.rank || unfenced(a.item.title).localeCompare(unfenced(b.item.title)))
            .map(({ item }) => item);
    }

    all(): readonly MergedItem[] {
        return this.#items;
    }

    size(): number {
        return this.#items.length;
    }
}
