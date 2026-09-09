import { MULTI_INSTANCE, type ConfigByService, type Config, type ServiceId } from './schema.ts';

/**
 * Flattening the config into instances, in one place.
 *
 * `services.radarr` is either one block or a list of named ones, and three
 * separate consumers need that difference to disappear before they see it: the
 * adapter registry, the permission source, and eventually the config UI. Three
 * flattenings would be three chances to disagree about what `radarr/4k` means.
 *
 * This lives under `config/` rather than beside the registry so that
 * `core/permissions.ts` can use it without importing the service layer, which
 * would pull every adapter into the permission check.
 */

/**
 * One configured instance, discriminated by `type`.
 *
 * A union rather than a record with a widened `config`, so that narrowing on
 * `type` narrows the config with it. That is what lets `buildAdapter` hand a
 * config straight to a constructor with no cast, and what makes handing a
 * Jellyfin block to a Radarr adapter a compile error rather than a runtime
 * surprise.
 *
 * It does not make *every* mix-up impossible: Transmission and qBittorrent
 * take the same config shape, so swapping those two case bodies still
 * type-checks. That is a fact about the schema — they genuinely have the same
 * fields — rather than a gap left open here, and closing it would mean
 * branding two otherwise identical types.
 */
export type ServiceInstance = {
    [T in ServiceId]: {
        /** `radarr` when there is one, `radarr/4k` when named. */
        readonly id: string;
        /** What kind of service it is. Capability dispatch keys on this, never id. */
        readonly type: T;
        /** Absent for a single unnamed instance, which is every config today. */
        readonly name?: string | undefined;
        readonly config: ConfigByService[T];
    };
}[ServiceId];

/**
 * The unnamed case keeping its bare id is what makes multiple instances a
 * widening rather than a migration: existing audit rows, log filters and error
 * messages stay correct with no backfill and no dual-read.
 */
export const instanceId = (type: ServiceId, name?: string): string =>
    name === undefined ? type : `${type}/${name}`;

/**
 * Every configured instance, ordered by id.
 *
 * Sorted for the same reason `buildAdapters` was alphabetical before: it makes
 * stack_health's output stable across restarts and diffable in tests. Sorting
 * by id rather than by service keeps a service's own instances adjacent.
 */
export function listInstances(config: Config): ServiceInstance[] {
    const out: ServiceInstance[] = [];

    for (const [key, value] of Object.entries(config.services)) {
        if (value === undefined) continue;
        const type = key as ServiceId;

        // Only the types in MULTI_INSTANCE can be a list, and the schema has
        // already refused one anywhere else — so this is a shape check, not a
        // policy decision being made twice.
        const entries: readonly unknown[] = Array.isArray(value) ? value : [value];

        for (const entry of entries) {
            const name = (entry as { name?: string }).name;

            // The one place the key and its config are paired by hand, and so
            // the one cast. `ServicesSchema` has already validated that
            // `services.radarr` holds a Radarr block, but that pairing lives in
            // the schema rather than in this loop's types, and a `for` over
            // `Object.entries` cannot carry it. Casting here rather than at
            // each consumer is the point: it buys `ServiceInstance` a real
            // discriminant, so `buildAdapter` needs no casts at all and a
            // Jellyfin block handed to a Radarr adapter stops compiling.
            out.push({
                id: instanceId(type, name),
                type,
                ...(name === undefined ? {} : { name }),
                config: entry
            } as ServiceInstance);
        }
    }

    return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether this service may appear more than once. */
export const isMultiInstance = (type: ServiceId): boolean => MULTI_INSTANCE.includes(type);
