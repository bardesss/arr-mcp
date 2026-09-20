import type { OAuthConfig } from '../config/schema.ts';
import type { PermissionSource, WriteTier } from '../core/permissions.ts';

/**
 * What the presented scopes permit, as a ceiling over the config.
 *
 * The three scopes are independent and unioned — a token presents whichever
 * it was granted. The one ordering applied here is the repo's own: the
 * destructive scope carries the safe tier with it, for the same reason
 * `destructive: true` grants `safe_write` in `core/permissions.ts`. Nothing
 * about tier ordering is re-decided; this mirrors the rule that already
 * exists so a capped source and an uncapped one cannot disagree.
 *
 * `undefined` means the token carried none of the three. That is a refusal,
 * not an empty ceiling: a credential granted nothing here should be told so
 * rather than quietly handed the library.
 */
export function tiersFor(oauth: OAuthConfig, scopes: readonly string[]): ReadonlySet<WriteTier> | undefined {
    const held = new Set(scopes);
    const read = held.has(oauth.scopes.read);
    const write = held.has(oauth.scopes.write);
    const destructive = held.has(oauth.scopes.destructive);

    if (!read && !write && !destructive) return undefined;

    const tiers = new Set<WriteTier>();
    if (write || destructive) tiers.add('safe');
    if (destructive) tiers.add('destructive');
    return tiers;
}

/**
 * The same source, with an upper bound. `get` is untouched, so the gate still
 * answers from `config.yaml` alone and a compromised or over-generous issuer
 * cannot grant a write this server was never configured to allow.
 */
export function cappedTo(source: PermissionSource, tiers: ReadonlySet<WriteTier>): PermissionSource {
    return {
        get: instance => source.get(instance),
        permits: tier => tiers.has(tier)
    };
}
