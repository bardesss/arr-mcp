import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { gather, type Source } from '../core/gather.ts';
import { isUnknownUser, type IdentityResolver } from '../core/identity.ts';
import { logger } from '../core/logger.ts';
import { LibraryIndex, type IndexInput, type MediaServerPresence, type MergedItem } from '../core/resolver.ts';
import { enrichWithImdb } from '../metadata/enrich.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import {
    NO_MEDIA_SERVER_NOTE,
    hasLibrary,
    hasUserLibrary,
    hasUserSeasons,
    type ServiceAdapter,
    type ServiceUser
} from '../services/types.ts';

/**
 * A degraded snapshot is worth caching, briefly.
 *
 * Declining outright meant that while any one source was down — a Jellyfin
 * restarting for an hour — every read did the full fan-out with no cache at
 * all, hammering the healthy services hardest exactly when the stack was
 * fragile. Short enough that recovery is noticed almost immediately.
 */
const DEGRADED_TTL_MS = 20_000;

export type LibrarySnapshot = {
    index: LibraryIndex;
    degraded: string[];
    /**
     * Keyed by **source**, not by service: `jellyfin:seasons` is its own
     * source and reports its own count. Widened from `ServiceId` for that
     * reason; every existing key is unchanged.
     */
    counts: Record<string, number>;
    /** Set when the media server half is missing — no server configured, or one
     *  configured with no `default_user` — or when a secondary is not read
     *  because its `default_user` is missing (Jellyfin; Plex falls back to the
     *  token owner) or matches nobody. */
    note?: string;
};

/** Which configured media server is the primary, and the secondary if there is one. */
export type LibraryMediaServers = {
    primaryId: string;
    secondary?: { id: string; identity: IdentityResolver | undefined };
};

type SecondarySkip = 'unconfigured' | 'unmatched';
type SecondaryUser = { user: ServiceUser } | { skipped: SecondarySkip };

const presenceOf = (row: MergedItem | undefined): MediaServerPresence =>
    row === undefined
        ? { present: false }
        : { present: true, ...(row.playback?.itemId === undefined ? {} : { itemId: row.playback.itemId }) };

/**
 * One cached library index, shared by get_library, get_media_details and
 * diagnose (duplicating the join is how joins drift apart).
 *
 * The cache lives here rather than in the adapters, so adapters stay directly
 * testable against fixtures and caching policy sits in one reviewable place.
 */
export class LibraryLoader {
    readonly #adapters: readonly ServiceAdapter[];
    readonly #identity: IdentityResolver | undefined;
    readonly #cache: TtlCache;
    readonly #dataset: ImdbDataset | undefined;
    readonly #mediaServers: LibraryMediaServers | undefined;

    constructor(
        adapters: readonly ServiceAdapter[],
        mediaServerIdentity: IdentityResolver | undefined,
        cache: TtlCache = new TtlCache(),
        /**
         * Enrichment happens here, not per tool, for the reason this class
         * exists: all three readers share one snapshot, so they cannot
         * disagree about a rating, and the dataset is queried once per cache
         * TTL rather than once per call. Last and optional, so existing call
         * sites keep compiling.
         */
        dataset?: ImdbDataset,
        /** Absent means pick the first media server, as before there could be two. */
        mediaServers?: LibraryMediaServers
    ) {
        this.#adapters = adapters;
        this.#identity = mediaServerIdentity;
        this.#cache = cache;
        this.#dataset = dataset;
        this.#mediaServers = mediaServers;
    }

    get secondaryMediaServerId(): string | undefined {
        return this.#mediaServers?.secondary?.id;
    }

    /**
     * Whether an IMDb rating is *obtainable* here, which is not the same
     * question as whether one was found.
     *
     * `get_library` needs this to tell three situations apart that all arrive
     * as "0 rated": the dataset is off, it is on but has not finished its first
     * ingest, or it is loaded and genuinely does not cover these titles. Only
     * the last is an answer about the library; the other two are answers about
     * this server, and a caller told "0 rated" without them reasonably
     * concludes the library is the problem — which is exactly what happened.
     *
     * A getter rather than a field on the snapshot: the state changes when the
     * ingest lands, which is not a library read and must not wait for the cache
     * to expire.
     */
    get imdbDatasetState(): 'off' | 'ingesting' | 'ready' {
        if (this.#dataset === undefined) return 'off';
        return this.#dataset.status().ingestedAt === undefined ? 'ingesting' : 'ready';
    }

    async load(user?: string): Promise<LibrarySnapshot> {
        const resolved = await this.#resolveUser(user);

        // Keyed by user, or one household member's watch history appears in
        // another's answer — a correctness bug that reads as a privacy one.
        const key = `library:${resolved.user?.id ?? 'none'}`;

        // A degraded snapshot gets a short TTL rather than none, via `ttlFor`
        // instead of a later `invalidate()`, which cannot tell "my degraded
        // load lost a race to a complete one" from "nothing raced me" and
        // would delete the good entry.
        return this.#cache.get(key, LIBRARY_TTL_MS, () => this.#build(resolved), snapshot =>
            snapshot.degraded.length === 0 ? LIBRARY_TTL_MS : DEGRADED_TTL_MS
        );
    }

    /**
     * Called after a successful write, so the next `get_library` reflects it
     * rather than up to five minutes of a library that no longer exists.
     *
     * Clears every entry, not one key: keys are per user, and a film just
     * deleted is gone from all of them. Recomputing a household's worth of
     * snapshots costs one library read each; a stale one costs a wrong answer.
     */
    invalidate(): void {
        this.#cache.clear();
        // The adapters hold their own copy of the same bytes now, and a write
        // that only cleared the join would leave search_media answering from
        // pre-write data.
        for (const adapter of this.#adapters) adapter.invalidateLibrary?.();
    }

    /**
     * `user` is undefined when there is no Jellyfin half to fetch.
     *
     * Propagate or degrade turns on the error's **kind**, never on whether a
     * user was named — naming someone must not turn a plain Jellyfin outage
     * into a hard failure of the whole read, since the *arr half is still
     * worth returning.
     *
     * - `AuthFailed` — the named user was refused. Propagates: a model must
     *   not retry a refusal.
     * - `NotFound` with a name, or with none but a (wrong) `default_user`
     *   configured, propagates too — both are actionable config errors, not
     *   outages. Only "no name, no `default_user`" degrades
     *   (`unconfigured: true`), so the remedy names the missing key.
     * - Everything else degrades: a reachability problem, not a config one.
     */
    async #resolveUser(
        requested: string | undefined
    ): Promise<{ user: ServiceUser | undefined; unconfigured: boolean }> {
        if (this.#identity === undefined) return { user: undefined, unconfigured: false };
        try {
            return { user: await this.#identity.resolve(requested), unconfigured: false };
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'AuthFailed') throw err;
            if (err instanceof ServiceError && err.kind === 'NotFound') {
                if (requested !== undefined || this.#identity.hasDefaultUser) throw err;
                return { user: undefined, unconfigured: true };
            }
            logger.warn(
                { service: this.#identity.serviceId, err },
                'media server identity unavailable; building the library without watch state'
            );
            return { user: undefined, unconfigured: false };
        }
    }

    /**
     * The secondary is only ever read as its default user, and never fails the
     * read: a refusal (`AuthFailed`) or an outage throws, and `gather` degrades
     * it by name, since the primary's half is the answer and the secondary only
     * annotates it. A missing or wrong `default_user` is config, so it is
     * skipped and goes in the note instead. Plex with none is read as the
     * token owner, so only Jellyfin needs one. A 404 from the user listing
     * itself is an outage, not a wrong name.
     */
    async #secondaryUser(identity: IdentityResolver | undefined): Promise<SecondaryUser> {
        if (identity === undefined) return { skipped: 'unconfigured' };
        try {
            return { user: await identity.resolve(undefined) };
        } catch (err) {
            if (!identity.hasDefaultUser && err instanceof ServiceError && err.kind === 'NotFound') {
                return { skipped: 'unconfigured' };
            }
            if (identity.hasDefaultUser && isUnknownUser(err)) return { skipped: 'unmatched' };
            throw err;
        }
    }

    async #build(resolved: { user: ServiceUser | undefined; unconfigured: boolean }): Promise<LibrarySnapshot> {
        const { user } = resolved;
        const sources: Source<IndexInput>[] = this.#adapters
            .filter(hasLibrary)
            .map(a => ({ id: a.id, fetch: () => a.listLibrary() }));

        const primaryId = this.#mediaServers?.primaryId;
        const isPrimary = (a: ServiceAdapter) => primaryId === undefined || a.id === primaryId;
        const mediaServer = this.#adapters.filter(hasUserLibrary).find(isPrimary);
        if (mediaServer !== undefined) {
            sources.push({
                id: mediaServer.id,
                fetch:
                    user === undefined
                        ? // Reported as degraded rather than silently absent: the
                          // answer really is missing a service's contribution.
                          () => Promise.reject(new Error(`no ${mediaServer.id} user resolved`))
                        : () => mediaServer.listUserLibrary(user)
            });
        }

        // Its own source, so `gather` degrades it by name. A try/catch inside
        // the adapter could not tell the snapshot *why* seasons were missing —
        // the same ambiguity `BuildOptions.playbackGathered` exists to prevent.
        const seasons = this.#adapters.filter(hasUserSeasons).find(isPrimary);
        if (seasons !== undefined) {
            sources.push({
                // Not `:episodes` — `listUserSeasons` returns one row per
                // *series*, and the old name reported a series count as an
                // episode count (362 vs. a real 23,492 on one tester's
                // library). See F5.
                id: `${seasons.id}:seasons`,
                fetch:
                    user === undefined
                        ? () => Promise.reject(new Error(`no ${seasons.id} user resolved`))
                        : () => seasons.listUserSeasons(user)
            });
        }

        // Its user is resolved inside its own source, so a down secondary
        // waits alongside the primary's reads rather than before them. Its
        // rows are kept out of the join (they would fuse into `playback`); the
        // source returns none, so `gather` only records whether it failed.
        const secondary = this.#mediaServers?.secondary;
        const secondaryAdapter =
            secondary === undefined ? undefined : this.#adapters.filter(hasUserLibrary).find(a => a.id === secondary.id);
        const secondaryState: { skipped?: SecondarySkip } = {};
        const secondaryRows: IndexInput[] = [];
        if (secondary !== undefined) {
            sources.push({
                id: secondary.id,
                fetch: async () => {
                    const resolved = await this.#secondaryUser(secondary.identity);
                    if ('skipped' in resolved) secondaryState.skipped = resolved.skipped;
                    else if (secondaryAdapter !== undefined) {
                        secondaryRows.push(...(await secondaryAdapter.listUserLibrary(resolved.user)));
                    }
                    return [];
                }
            });
        }

        const { items, degraded, counts } = await gather(sources);

        const secondaryRead =
            secondaryAdapter !== undefined && secondaryState.skipped === undefined && !degraded.includes(secondaryAdapter.id);
        // Absent, not zero, when it was not read: zero would claim it was asked.
        if (secondary !== undefined) Reflect.deleteProperty(counts, secondary.id);
        if (secondaryRead) counts[secondaryAdapter.id] = secondaryRows.length;

        // The one place that knows whether the media server was actually read:
        // configured (a source was pushed above) *and* successful (its id is
        // not in `degraded`, covering a fetch failure and the synthetic
        // no-user-resolved rejection alike).
        const playbackGathered = mediaServer !== undefined && !degraded.includes(mediaServer.id);

        // Enriched *before* the merge: the index hands the same objects to
        // `all()` and to its key map, so replacing them afterwards would have
        // to keep both in step. It also means media-server-only items get a
        // rating, which nothing else in the stack could give them.
        const rated = enrichWithImdb(items, this.#dataset);

        // The actual configured media server's id (`jellyfin` or `plex`), not
        // a hardcoded name — falls back to the identity's own adapter id for
        // the pathological case where the two disagree.
        const mediaServerId = mediaServer?.id ?? this.#identity?.serviceId;

        // Ordered most specific first: a media server that is configured but
        // unusable is a different remedy from none at all, and only one of the
        // two can be true — `resolved.unconfigured` needs an identity, which
        // needs an adapter.
        const primaryNote = resolved.unconfigured
            ? `${mediaServerId} is configured without a default_user, so watch state is not included. Set \`services.${mediaServerId}.default_user\` in config.yaml, or pass \`user\` explicitly.`
            : mediaServer === undefined
              ? NO_MEDIA_SERVER_NOTE
              : undefined;
        const secondaryNote =
            secondary === undefined
                ? undefined
                : secondaryState.skipped === 'unconfigured'
                  ? `${secondary.id} is configured without a default_user, so media_servers leaves it out. Set \`services.${secondary.id}.default_user\` in config.yaml.`
                  : secondaryState.skipped === 'unmatched'
                    ? `\`services.${secondary.id}.default_user\` does not match any user on ${secondary.id}, so media_servers leaves it out. Fix it in config.yaml.`
                    : undefined;
        const note = [primaryNote, secondaryNote].filter(n => n !== undefined).join(' ') || undefined;

        const index = LibraryIndex.build(rated, { playbackGathered });

        if (secondary !== undefined) {
            const secondaryIndex = secondaryRead ? LibraryIndex.build(secondaryRows) : undefined;
            for (const item of index.all()) {
                const servers: Record<string, MediaServerPresence> = {};
                if (playbackGathered) servers[mediaServer.id] = item.playback === undefined ? { present: false } : presenceOf(item);
                if (secondaryIndex !== undefined && secondaryAdapter !== undefined) {
                    servers[secondaryAdapter.id] = presenceOf(secondaryIndex.find(item.ids, item.kind));
                }
                item.media_servers = servers;
            }
        }

        return {
            index,
            degraded,
            counts,
            ...(note === undefined ? {} : { note })
        };
    }
}
