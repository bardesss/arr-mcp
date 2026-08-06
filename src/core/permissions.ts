import type { AnyServiceConfig, ServiceId } from '../config/schema.ts';
import { ServiceError } from './errors.ts';

/**
 * Design spec §10's two tiers, as an **ordered** pair rather than two
 * independent switches.
 *
 * `safe` is a mutation the service itself can undo: monitor a movie, trigger a
 * search, pause a download. `destructive` loses something — files on disk, a
 * request's history, a queue item and its blocklist entry.
 *
 * Ordering is the whole point. `destructive: true` grants `safe` as well,
 * because a config that permits deleting a film but refuses to let it be
 * re-monitored describes no coherent policy anyone would choose on purpose —
 * and a user who set the scarier-sounding flag and then found `add_media`
 * refused would reasonably read that as a bug. Someone who genuinely wants
 * neither leaves both off, which is the default (see PermissionsSchema).
 */
export const WRITE_TIERS = ['safe', 'destructive'] as const;
export type WriteTier = (typeof WRITE_TIERS)[number];

/** The YAML key each tier is granted by, for error messages that can be acted on. */
const TIER_KEY: Record<WriteTier, string> = {
    safe: 'safe_write',
    destructive: 'destructive'
};

export type PermissionVerdict =
    | { allowed: true; tier: WriteTier }
    | { allowed: false; tier: WriteTier; reason: string; remedy: string };

/**
 * Config-shaped rather than adapter-shaped on purpose: the gate answers from
 * `config.yaml` alone, so a compromised or buggy adapter cannot widen its own
 * permissions by reporting a capability it was never granted.
 */
export type PermissionSource = {
    get(service: ServiceId): AnyServiceConfig | undefined;
};

/** The property type is written out rather than as `Partial<Record<…>>` so it
 *  accepts `config.services` under `exactOptionalPropertyTypes`, where an
 *  explicitly-`undefined` key and a missing one are different types. */
export function permissionSourceFrom(services: { [K in ServiceId]?: AnyServiceConfig | undefined }): PermissionSource {
    return { get: service => services[service] };
}

/**
 * Never throws. A denial is a *value* here because two callers need it in
 * different shapes: a live write turns it into a `PermissionDenied` error, and
 * a dry run reports it as part of the preview without failing (see
 * `src/tools/write.ts` for why a dry run is not gated).
 */
export function checkPermission(source: PermissionSource, service: ServiceId, tier: WriteTier): PermissionVerdict {
    const config = source.get(service);

    if (config === undefined) {
        return {
            allowed: false,
            tier,
            reason: `${service} is not configured`,
            remedy: `Add a \`services.${service}\` block to config.yaml and restart. Writes additionally need \`services.${service}.permissions.${TIER_KEY[tier]}: true\`.`
        };
    }

    // The ordering rule, in the one place it exists. Note this reads
    // `destructive` for *both* tiers — a safe write is permitted by either
    // flag, a destructive one only by `destructive`.
    const granted = tier === 'safe' ? config.permissions.safe_write || config.permissions.destructive : config.permissions.destructive;

    if (granted) return { allowed: true, tier };

    return {
        allowed: false,
        tier,
        reason: `${tier} writes are disabled for ${service}`,
        remedy: `Set \`services.${service}.permissions.${TIER_KEY[tier]}: true\` in config.yaml and restart arr-mcp. This is off by default; nothing but a deliberate edit turns it on.`
    };
}

/**
 * The live-write form of the same check. Throws the §15-shaped error, so a
 * refusal reaches the model as a sentence naming the exact YAML key to change
 * rather than as a bare "forbidden" it would then have to guess about.
 */
export function assertPermitted(source: PermissionSource, service: ServiceId, tier: WriteTier): void {
    const verdict = checkPermission(source, service, tier);
    if (verdict.allowed) return;

    throw new ServiceError('PermissionDenied', service, verdict.reason, { remedy: verdict.remedy });
}
