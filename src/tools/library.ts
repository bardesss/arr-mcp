import type { ServiceId } from '../config/schema.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { gather, type Source } from '../core/gather.ts';
import type { IdentityResolver } from '../core/identity.ts';
import { logger } from '../core/logger.ts';
import { LibraryIndex, type IndexInput } from '../core/resolver.ts';
import { hasLibrary, hasUserLibrary, type ServiceAdapter, type ServiceUser } from '../services/types.ts';

export type LibrarySnapshot = {
    index: LibraryIndex;
    degraded: ServiceId[];
    counts: Partial<Record<ServiceId, number>>;
};

/**
 * One cached library index, shared by get_library, get_media_details and
 * diagnose (§8: duplicating the join is how joins drift apart).
 *
 * The cache lives here rather than in the adapters, so adapters stay directly
 * testable against fixtures and caching policy sits in one reviewable place.
 */
export class LibraryLoader {
    readonly #adapters: readonly ServiceAdapter[];
    readonly #identity: IdentityResolver | undefined;
    readonly #cache: TtlCache;

    constructor(
        adapters: readonly ServiceAdapter[],
        jellyfinIdentity: IdentityResolver | undefined,
        cache: TtlCache = new TtlCache()
    ) {
        this.#adapters = adapters;
        this.#identity = jellyfinIdentity;
        this.#cache = cache;
    }

    async load(user?: string): Promise<LibrarySnapshot> {
        const resolved = await this.#resolveUser(user);

        // §4.3: the key includes the user id, or one household member's watch
        // history appears in another's answer — a correctness bug that reads as
        // a privacy one.
        const key = `library:${resolved?.id ?? 'none'}`;

        // A partial load is not worth five minutes of cache: the missing
        // service is usually restarting, and the next call should find it.
        // Declined via `shouldCache` rather than a follow-up `invalidate()`:
        // invalidate has no way to tell "my degraded load lost a race to a
        // fresher, complete one" from "nothing raced me" — it would delete
        // the good entry in the first case. `shouldCache` runs on the same
        // identity check the cache's own failure path uses, so only this
        // exact load's entry is ever dropped.
        return this.#cache.get(key, LIBRARY_TTL_MS, () => this.#build(resolved), snapshot => snapshot.degraded.length === 0);
    }

    /**
     * §16's write-invalidation seam, and the reason `TtlCache.invalidate`
     * existed unused until now. Called after a successful write, so the next
     * `get_library` reflects the change rather than up to five minutes of a
     * library that no longer exists.
     *
     * Clears every entry rather than one key: this cache holds nothing but
     * library snapshots, and a Radarr write invalidates *every* user's
     * snapshot, not just the writer's — the keys are per Jellyfin user, and the
     * film that was just deleted is gone from all of them. Recomputing a
     * household's worth of snapshots costs one library read each; serving a
     * stale one costs a wrong answer.
     */
    invalidate(): void {
        this.#cache.clear();
    }

    /**
     * Returns undefined when there is no Jellyfin half to fetch. The decision
     * to propagate or degrade turns on the error's *kind*, not on whether a
     * user was named — naming someone must not turn a plain Jellyfin outage
     * into a hard failure of the whole library read; the *arr half is still
     * worth returning. Three distinct meanings, three distinct outcomes
     * (whole-phase review item 5 — this is the one place all three have to
     * stay apart):
     *
     * - `AuthFailed` — the named user was refused (`allow_other_users` is
     *   false and it wasn't the default). Always propagates: the model must
     *   not retry a refusal.
     * - `NotFound` — either nobody was named and no `default_user` is
     *   configured, or the name in play (named or default) does not exist in
     *   Jellyfin's own directory. Always propagates now, regardless of
     *   `requested`: both are configuration errors with an actionable remedy
     *   already attached (`IdentityResolver` names the exact config key), and
     *   `src/config/schema.ts` documents that a per-user tool called with
     *   nothing configured *fails naming that key* — degrading here instead
     *   silently swallowed the remedy and reported "jellyfin could not be
     *   reached" forever, indistinguishable from a real, transient outage,
     *   while `stack_health` kept calling Jellyfin healthy. This is also what
     *   used to make item 1's `unknown`-when-ungathered collapse permanent
     *   rather than transient on such a stack: nothing about the failure ever
     *   changes, so it never stops being ungathered.
     *   Previously this propagated only when `requested !== undefined` (a
     *   user was explicitly named) — the no-`default_user`-configured case
     *   degraded silently. That distinction is gone: both are the same kind
     *   of error (a config key that needs setting), so both surface the same
     *   way. This must not be confused with `AuthFailed` above, which is a
     *   different, narrower thing — a *configured* default exists, someone
     *   asked to be answered as somebody else, and it was refused. That is
     *   never a configuration gap and must never degrade.
     * - Everything else — `Unreachable`, `Timeout`, `UpstreamError`, and any
     *   non-`ServiceError` — degrades regardless of whether a user was named:
     *   a real reachability problem, not a configuration one.
     */
    async #resolveUser(requested: string | undefined): Promise<ServiceUser | undefined> {
        if (this.#identity === undefined) return undefined;
        try {
            return await this.#identity.resolve(requested);
        } catch (err) {
            if (err instanceof ServiceError && (err.kind === 'AuthFailed' || err.kind === 'NotFound')) throw err;
            logger.warn(
                { service: 'jellyfin', err },
                'jellyfin identity unavailable; building the library without watch state'
            );
            return undefined;
        }
    }

    async #build(user: ServiceUser | undefined): Promise<LibrarySnapshot> {
        const sources: Source<IndexInput>[] = this.#adapters
            .filter(hasLibrary)
            .map(a => ({ id: a.id, fetch: () => a.listLibrary() }));

        const jellyfin = this.#adapters.find(hasUserLibrary);
        if (jellyfin !== undefined) {
            sources.push({
                id: jellyfin.id,
                fetch:
                    user === undefined
                        ? // Reported as degraded rather than silently absent: the
                          // answer really is missing a service's contribution.
                          () => Promise.reject(new Error('no Jellyfin user resolved'))
                        : () => jellyfin.listUserLibrary(user)
            });
        }

        const { items, degraded, counts } = await gather(sources);

        // `LibraryIndex` cannot tell "Jellyfin looked and found nothing" from
        // "Jellyfin was never gathered" on its own (resolver.ts's
        // `BuildOptions` doc) — this is the one place that knows which,
        // because it owns the fetch. Gathered means both configured (a
        // `jellyfin` source was even pushed above) *and* successful (its id
        // is not in `degraded` — covering an outright fetch failure and the
        // synthetic no-user-resolved rejection above alike).
        const jellyfinGathered = jellyfin !== undefined && !degraded.includes(jellyfin.id);

        return { index: LibraryIndex.build(items, { jellyfinGathered }), degraded, counts };
    }
}
