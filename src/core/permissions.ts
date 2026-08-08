import type { ServiceInstance } from '../config/instances.ts';
import type { AnyServiceConfig } from '../config/schema.ts';
import { ServiceError } from './errors.ts';

/**
 * The two tiers, as an **ordered** pair rather than two
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
    /** Keyed by instance id — `radarr` or `radarr/4k`, never the bare type. */
    get(instance: string): AnyServiceConfig | undefined;
};

/**
 * Keyed per instance, which is a feature rather than a consequence: safe writes
 * on the HD Radarr and nothing on the 4K one is a policy people actually want,
 * and a source keyed by service type cannot express it.
 *
 * Takes the flattened instance list rather than `config.services` so the
 * one-or-many shape is already resolved. Doing it here as well would be a second
 * place that could disagree about what `radarr/4k` means.
 */
export function permissionSourceFrom(instances: readonly ServiceInstance[]): PermissionSource {
    const byId = new Map(instances.map(i => [i.id, i.config]));
    return { get: instance => byId.get(instance) };
}

/**
 * Never throws. A denial is a *value* here because two callers need it in
 * different shapes: a live write turns it into a `PermissionDenied` error, and
 * a dry run reports it as part of the preview without failing (see
 * `src/tools/write.ts` for why a dry run is not gated).
 */
/**
 * Where to set a permission, in the reader's actual config file.
 *
 * A named instance lives inside a list, so `services.radarr/4k.permissions` —
 * the obvious string to build from the id — names a key that does not exist and
 * cannot be created. Someone following it edits nothing and the write stays
 * refused, which is a worse failure than a vague message: it looks like the
 * remedy did not work.
 */
function permissionPath(instance: string, tier: WriteTier): string {
    const slash = instance.indexOf('/');
    if (slash === -1) {
        return `\`services.${instance}.permissions.${TIER_KEY[tier]}: true\``;
    }

    const type = instance.slice(0, slash);
    const name = instance.slice(slash + 1);
    return `\`permissions.${TIER_KEY[tier]}: true\` on the \`name: ${name}\` entry under \`services.${type}\``;
}

export function checkPermission(source: PermissionSource, service: string, tier: WriteTier): PermissionVerdict {
    const config = source.get(service);

    if (config === undefined) {
        const type = service.split('/')[0] ?? service;
        return {
            allowed: false,
            tier,
            reason: `${service} is not configured`,
            remedy: `Add a \`services.${type}\` block to config.yaml and restart. Writes additionally need ${permissionPath(service, tier)}.`
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
        remedy: `Set ${permissionPath(service, tier)} in config.yaml and restart arr-mcp. This is off by default; nothing but a deliberate edit turns it on.`
    };
}

/**
 * The live-write form of the same check. Throws the standard degraded-service error, so a
 * refusal reaches the model as a sentence naming the exact YAML key to change
 * rather than as a bare "forbidden" it would then have to guess about.
 */
export function assertPermitted(source: PermissionSource, service: string, tier: WriteTier): void {
    const verdict = checkPermission(source, service, tier);
    if (verdict.allowed) return;

    throw new ServiceError('PermissionDenied', service, verdict.reason, { remedy: verdict.remedy });
}
