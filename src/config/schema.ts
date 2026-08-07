import * as z from 'zod/v4';

export const ServiceIdSchema = z.enum([
    'radarr',
    'sonarr',
    'prowlarr',
    'bazarr',
    'jellyfin',
    'seerr',
    'sabnzbd',
    'transmission'
]);
export type ServiceId = z.infer<typeof ServiceIdSchema>;

/**
 * Permission tiers per the design spec §10. Both default to off: a service
 * added by hand-editing YAML must not silently acquire write access.
 */
const PermissionsSchema = z
    .object({
        safe_write: z.boolean().default(false),
        destructive: z.boolean().default(false)
    })
    .default({ safe_write: false, destructive: false });

const UrlSchema = z.url().refine(u => u.startsWith('http://') || u.startsWith('https://'), {
    message: 'must be an http:// or https:// URL'
});

/**
 * Shared by all eight. Every concrete schema below is a *strict* object, so a
 * misspelled key fails at startup instead of being silently dropped — which is
 * the difference between "my timeout setting does nothing" taking a minute to
 * diagnose or an afternoon.
 */
const BaseServiceShape = {
    url: UrlSchema,
    timeout_ms: z.number().int().positive().default(10_000),
    permissions: PermissionsSchema
};

const ApiKeyShape = { api_key: z.string().min(1, 'api_key must not be empty') };

/** Radarr, Sonarr, Prowlarr, Bazarr, SABnzbd — an API key and nothing more. */
const KeyedServiceSchema = z.strictObject({ ...BaseServiceShape, ...ApiKeyShape });
export type KeyedServiceConfig = z.infer<typeof KeyedServiceSchema>;

/**
 * What ServiceHttp needs from any service, whatever its auth shape. Derived
 * rather than parsed from its own schema — nothing ever validates against this
 * alone, and a schema with no parser is a schema that drifts.
 */
export type BaseServiceConfig = Pick<KeyedServiceConfig, 'url' | 'timeout_ms' | 'permissions'>;

/**
 * Jellyfin and Seerr only (design spec §9) — the two services with their own
 * user concepts.
 *
 * `default_user` is optional on purpose: configuring a service purely so it
 * appears in stack_health is legitimate, and guessing an identity is the silent
 * mismatch §14 warns about. A per-user tool called with nothing configured
 * fails naming this key.
 */
const MultiUserServiceSchema = z.strictObject({
    ...BaseServiceShape,
    ...ApiKeyShape,
    default_user: z.string().min(1).optional(),
    allow_other_users: z.boolean().default(false)
});
export type MultiUserServiceConfig = z.infer<typeof MultiUserServiceSchema>;

/**
 * Transmission's RPC has no API key — HTTP Basic auth plus an
 * `X-Transmission-Session-Id` handshake. Both credential parts are optional
 * because LAN instances are commonly unauthenticated.
 */
const TransmissionServiceSchema = z.strictObject({
    ...BaseServiceShape,
    username: z.string().min(1).optional(),
    password: z.string().optional()
});
export type TransmissionServiceConfig = z.infer<typeof TransmissionServiceSchema>;

export type AnyServiceConfig = KeyedServiceConfig | MultiUserServiceConfig | TransmissionServiceConfig;

/**
 * Strict as well, so an unknown service id is an error rather than a key that
 * silently vanishes. Someone adding `plex:` should be told it is unsupported,
 * not left wondering why nothing happened.
 */
const ServicesSchema = z
    .strictObject({
        radarr: KeyedServiceSchema.optional(),
        sonarr: KeyedServiceSchema.optional(),
        prowlarr: KeyedServiceSchema.optional(),
        bazarr: KeyedServiceSchema.optional(),
        sabnzbd: KeyedServiceSchema.optional(),
        jellyfin: MultiUserServiceSchema.optional(),
        seerr: MultiUserServiceSchema.optional(),
        transmission: TransmissionServiceSchema.optional()
    })
    .default({});

export const ConfigSchema = z.object({
    // Required, not optional: loadConfig always injects a generated token
    // before parsing, so the only way this is missing is a hand-edited file
    // that deleted it — which must fail loudly rather than default to ''.
    auth: z.object({
        /** Generated on first run by loadConfig; 32 random bytes, hex. */
        bearer_token: z.string().length(64),
        /** Who logs into the config UI. Defaulted rather than generated —
         *  a random username helps nobody and is one more thing to look up. */
        username: z.string().min(1).default('admin'),
        /**
         * scrypt hash of the UI password, `scrypt$salt$hash`.
         *
         * Optional, unlike `bearer_token`, and the difference is the whole
         * design: absent means **unclaimed**, and the config UI serves its
         * setup page instead of a login form until someone chooses a password
         * in the browser. A bearer token has no interactive path, so a missing
         * one must be generated; a password does, so one is never invented.
         *
         * Deleting this line is how you ask for a new password, and it puts
         * the instance on exactly the path a fresh install takes. The password
         * itself is never stored and never logged.
         */
        password_hash: z.string().min(1).optional(),
        /**
         * Hostnames the MCP endpoint may be reached on, for the SDK's DNS
         * rebinding protection. Empty means "accept any Host", which is the
         * right default for a LAN container reached by IP; pin hostnames when
         * running behind a reverse proxy.
         */
        allowed_hosts: z.array(z.string()).default([])
    }),
    services: ServicesSchema
});
export type Config = z.infer<typeof ConfigSchema>;
