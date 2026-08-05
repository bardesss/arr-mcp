import type { ServiceId } from '../config/schema.ts';
import { RANK_NONE, rankTitle, unfenced } from './titleMatch.ts';

export type ExternalIds = { tmdb?: number; tvdb?: number; imdb?: string };

/**
 * Named sources rather than a loose map: §8 lists exactly these, and a
 * `Record<string, number>` accepts a source name that does not exist.
 *
 * A film populates some subset of the first five. A series populates `tvdb`
 * and nothing else — §21.2 established that Sonarr's rating is one flat value,
 * unrelated to Radarr's per-source map. The two never mix.
 */
export type MergedRatings = {
    imdb?: number;
    tmdb?: number;
    rottenTomatoes?: number;
    trakt?: number;
    metacritic?: number;
    tvdb?: number;
};

export type MergedItem = {
    kind: 'movie' | 'series';
    title: string;
    year?: number;
    /**
     * Absent from §4.1's record and required by §5: `genre` is a `get_library`
     * filter, and no other field in the merged shape could answer one.
     * Recorded here as a correction to the design rather than bolted on in 3b.
     */
    genres?: string[];
    ids: ExternalIds;
    acquisition?: { service: ServiceId; monitored: boolean; hasFile: boolean; quality?: string; sizeBytes?: number };
    playback?: { user: string; watched: boolean; playCount?: number; lastPlayed?: string };
    ratings?: MergedRatings;
    /**
     * §8's diagnostic payload. `arr_only` **with a file** means a broken
     * Jellyfin import; `jellyfin_only` means media nothing is managing.
     * Neither is visible from any single service.
     *
     * `unknown` covers a record with **neither** half of evidence — no
     * `acquisition` and no `playback`. Real adapter data never produces one
     * (every input contributes at least one side of the join), but the type
     * does not forbid it, and the alternative — falling through to
     * `jellyfin_only` — would assert Jellyfin evidence for a record that was
     * never seen there. `arr_only` is equally wrong for the same reason.
     * `unknown` is the only answer that does not fabricate a source.
     */
    presence: 'both' | 'arr_only' | 'jellyfin_only' | 'unknown';
};

export type IndexInput = Omit<MergedItem, 'presence'>;

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
    if (input.ratings !== undefined) target.ratings = { ...target.ratings, ...input.ratings };
}

/**
 * §8's shared join. Records merge when **any** strong id matches, which is what
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

    static build(inputs: readonly IndexInput[]): LibraryIndex {
        const byKey = new Map<string, MergedItem>();
        const items: MergedItem[] = [];

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
            const matches = [...new Set(keys.map(k => byKey.get(k)).filter((v): v is MergedItem => v !== undefined))].filter(m =>
                items.includes(m)
            );

            if (matches.length === 0) {
                const created: MergedItem = { ...input, presence: 'arr_only' };
                items.push(created);
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
                const index = items.indexOf(loser);
                if (index !== -1) items.splice(index, 1);
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
        const finalByKey = new Map<string, MergedItem>();
        for (const item of items) {
            item.presence =
                item.acquisition !== undefined && item.playback !== undefined
                    ? 'both'
                    : item.acquisition !== undefined
                      ? 'arr_only'
                      : item.playback !== undefined
                        ? 'jellyfin_only'
                        : 'unknown';
            for (const key of keysOf(item.kind, item.ids)) finalByKey.set(key, item);
        }

        return new LibraryIndex(items, finalByKey);
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

    all(): MergedItem[] {
        return this.#items;
    }

    size(): number {
        return this.#items.length;
    }
}
