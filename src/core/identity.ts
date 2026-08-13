import type { MultiUserServiceConfig } from '../config/schema.ts';
import type { ServiceAdapter, ServiceUser, UserDirectoryCapable } from '../services/types.ts';
import { ServiceError } from './errors.ts';

type IdentityConfig = Pick<MultiUserServiceConfig, 'default_user' | 'allow_other_users'>;

/**
 * Two of the eight services have their own user concepts, and
 * both issue admin-scoped keys — so one key plus a user parameter can query as
 * anybody. `allow_other_users` exists to make that deliberate rather than
 * incidental.
 *
 * The gate runs before any network call and reads configuration only
 * requires that no value a service returns can widen what the model may do.
 */
export class IdentityResolver {
    readonly #adapter: ServiceAdapter & UserDirectoryCapable;
    readonly #config: IdentityConfig;
    #directory: Promise<ServiceUser[]> | undefined;

    constructor(adapter: ServiceAdapter & UserDirectoryCapable, config: IdentityConfig) {
        this.#adapter = adapter;
        this.#config = config;
    }

    async resolve(requested?: string): Promise<ServiceUser> {
        const wanted = this.#authorize(requested);
        const users = await this.#list();

        const match = users.find(u => u.name.toLowerCase() === wanted.toLowerCase());
        if (match === undefined) {
            const available = users.map(u => u.name).join(', ');
            throw new ServiceError('NotFound', this.#adapter.id, `no user named "${wanted}"`, {
                remedy: available
                    ? `Known users: ${available}. Fix default_user in config.yaml.`
                    : 'The service reported no users at all — check the API key has admin scope.'
            });
        }
        return match;
    }

    /**
     * Whether this server may deal in the named user's data at all — the
     * configuration half of `resolve`, with no directory lookup.
     *
     * The write path needs the gate *after* it knows whose request an id
     * belongs to, which `resolve` cannot serve: it would also insist the name
     * appear in the directory, and Seerr's display name on a request need not
     * match. Answering from configuration alone keeps the rule identical to
     * the read side's without inventing a second failure mode.
     */
    permits(name: string): boolean {
        const fallback = this.#config.default_user;
        if (fallback !== undefined && name.toLowerCase() === fallback.toLowerCase()) return true;
        return this.#config.allow_other_users;
    }

    /**
     * Configuration only. Returns the username to look up, or throws — and
     * throws *before* the directory is fetched, so a refused request costs no
     * network call and cannot be influenced by what the service would say.
     */
    #authorize(requested: string | undefined): string {
        const fallback = this.#config.default_user;

        if (requested === undefined) {
            if (fallback === undefined) {
                throw new ServiceError('NotFound', this.#adapter.id, 'no user was named and none is configured', {
                    remedy: `Set services.${this.#adapter.id}.default_user in config.yaml, or pass a user explicitly.`
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
     * Users change rarely, so the directory is fetched once per process
     * ( makes the cache in-memory and restart-clearing). A
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
