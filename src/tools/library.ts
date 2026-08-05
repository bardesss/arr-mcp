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
     * Returns undefined when there is no Jellyfin half to fetch. The decision
     * to propagate or degrade turns on the error's *kind*, not on whether a
     * user was named — naming someone must not turn a plain Jellyfin outage
     * into a hard failure of the whole library read; the *arr half is still
     * worth returning:
     *
     * - `AuthFailed` always propagates — the model must not retry a refusal.
     * - `NotFound` propagates only when a user was explicitly requested: the
     *   caller named someone who does not exist, and degrading would silently
     *   answer as if nobody had asked. Unrequested, `NotFound` means "no
     *   default user is configured," a configuration gap that still degrades.
     * - Everything else — `Unreachable`, `Timeout`, `UpstreamError`, and any
     *   non-`ServiceError` — degrades regardless of whether a user was named.
     */
    async #resolveUser(requested: string | undefined): Promise<ServiceUser | undefined> {
        if (this.#identity === undefined) return undefined;
        try {
            return await this.#identity.resolve(requested);
        } catch (err) {
            if (err instanceof ServiceError) {
                if (err.kind === 'AuthFailed') throw err;
                if (err.kind === 'NotFound' && requested !== undefined) throw err;
            }
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
        return { index: LibraryIndex.build(items), degraded, counts };
    }
}
