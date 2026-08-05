import type { ServiceId } from '../config/schema.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
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

        const snapshot = await this.#cache.get(key, LIBRARY_TTL_MS, () => this.#build(resolved));

        // A partial load is not worth five minutes of cache: the missing
        // service is usually restarting, and the next call should find it.
        if (snapshot.degraded.length > 0) this.#cache.invalidate(key);
        return snapshot;
    }

    /**
     * Returns undefined when there is no Jellyfin half to fetch, and **throws
     * when a named user was refused**. Flattening a refusal into `degraded`
     * would tell the model the service was down, and it would retry forever.
     */
    async #resolveUser(requested: string | undefined): Promise<ServiceUser | undefined> {
        if (this.#identity === undefined) return undefined;
        try {
            return await this.#identity.resolve(requested);
        } catch (err) {
            if (requested !== undefined) throw err;
            // No user was asked for and none is configured — a configuration
            // gap, not a refusal. Build the *arr half and say Jellyfin is
            // missing from the answer.
            logger.warn({ service: 'jellyfin', err }, 'no default user; building the library without watch state');
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
