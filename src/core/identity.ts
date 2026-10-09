import type { MultiUserServiceConfig } from '../config/schema.ts';
import type { ServiceAdapter, ServiceUser, UserDirectoryCapable } from '../services/types.ts';
import { ServiceError } from './errors.ts';
import { fenceText } from './fence.ts';

type IdentityConfig = Pick<MultiUserServiceConfig, 'default_user' | 'allow_other_users'>;

/** The resolver's own "no such user", as opposed to a NotFound from the service itself. */
export const isUnknownUser = (err: unknown): boolean => err instanceof ServiceError && err.reason === 'unknown_user';

/**
 * Two of the nine services have their own user concepts, and
 * both issue admin-scoped keys — so one key plus a user parameter can query as
 * anybody. `allow_other_users` exists to make that deliberate rather than
 * incidental.
 *
 * The gate runs before any network call and reads configuration only, so no
 * value a service returns can widen what the model may do.
 */
export class IdentityResolver {
    readonly #adapter: ServiceAdapter & UserDirectoryCapable;
    readonly #config: IdentityConfig;
    #directory: Promise<ServiceUser[]> | undefined;

    constructor(adapter: ServiceAdapter & UserDirectoryCapable, config: IdentityConfig) {
        this.#adapter = adapter;
        this.#config = config;
    }

    /** Whether `default_user` is set at all — distinct from whether it names a real user. */
    get hasDefaultUser(): boolean {
        return this.#config.default_user !== undefined;
    }

    /** The underlying adapter's id — `jellyfin` or `plex` — for remedies and
     *  log tags built outside this class, which must not hardcode either. */
    get serviceId(): string {
        return this.#adapter.id;
    }

    async resolve(requested?: string): Promise<ServiceUser> {
        const wanted = this.#authorize(requested);
        const users = await this.#list();

        if (wanted === undefined) {
            const [owner] = users;
            if (users.length === 1 && owner !== undefined) return owner;
            throw new ServiceError('NotFound', this.#adapter.id, 'no user was named and the token owner is unknown', {
                remedy: `Set services.${this.#adapter.id}.default_user in config.yaml, or pass a user explicitly.`,
                reason: 'unknown_user'
            });
        }

        const matches = users.filter(u => u.name.toLowerCase() === wanted.toLowerCase());
        // Users can pick their own names, so a second account can take this
        // one. Guessing between them would let it stand in for the real one.
        if (matches.length > 1) {
            throw new ServiceError('PermissionDenied', this.#adapter.id, `${matches.length} users are named "${wanted}"`, {
                remedy: `Rename all but one of them in ${this.#adapter.id}, or point default_user at a unique name.`
            });
        }
        const [match] = matches;
        if (match === undefined) {
            const available = fenceText(users.map(u => u.name).join(', '), { service: this.#adapter.id, field: 'users' });
            throw new ServiceError('NotFound', this.#adapter.id, `no user named "${wanted}"`, {
                remedy: available
                    ? `Known users: ${available}. Fix default_user in config.yaml.`
                    : 'The service reported no users at all — check the API key has admin scope.',
                reason: 'unknown_user'
            });
        }
        return match;
    }

    /** Configuration only: whether users other than `default_user` are in reach. */
    get allowsOtherUsers(): boolean {
        return this.#config.allow_other_users;
    }

    /**
     * Configuration only. Returns the username to look up, or throws — and
     * throws *before* the directory is fetched, so a refused request costs no
     * network call and cannot be influenced by what the service would say.
     * Undefined means the token's own account, which only an adapter that
     * declares `tokenOwnerOnly` can answer with.
     */
    #authorize(requested: string | undefined): string | undefined {
        const fallback = this.#config.default_user;

        if (requested === undefined) {
            if (fallback === undefined) {
                if (this.#adapter.tokenOwnerOnly === true) return undefined;
                throw new ServiceError('NotFound', this.#adapter.id, 'no user was named and none is configured', {
                    remedy: `Set services.${this.#adapter.id}.default_user in config.yaml, or pass a user explicitly.`,
                    reason: 'unknown_user'
                });
            }
            return fallback;
        }

        const sameAsDefault = fallback !== undefined && requested.toLowerCase() === fallback.toLowerCase();
        if (!sameAsDefault && !this.#config.allow_other_users) {
            throw new ServiceError('AuthFailed', this.#adapter.id, `not permitted to query as "${requested}"`, {
                remedy:
                    `Only ${fallback ?? 'the configured default user'} may be queried. ` +
                    `Set services.${this.#adapter.id}.allow_other_users: true to permit others — ` +
                    "this exposes every user's history."
            });
        }
        return requested;
    }

    /**
     * Users change rarely, so the directory is fetched once per process. A
     * failed fetch is deliberately not cached: a service restarting during the
     * first call would otherwise poison every later one until arr-mcp itself
     * restarts.
     */
    async #list(): Promise<ServiceUser[]> {
        this.#directory ??= this.#adapter.listUsers();
        try {
            return await this.#directory;
        } catch (err) {
            this.#directory = undefined;
            throw err;
        }
    }
}
