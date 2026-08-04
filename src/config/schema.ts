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

const ServiceConfigSchema = z.object({
    url: z
        .url()
        .refine(u => u.startsWith('http://') || u.startsWith('https://'), {
            message: 'must be an http:// or https:// URL'
        }),
    api_key: z.string().min(1, 'api_key must not be empty'),
    timeout_ms: z.number().int().positive().default(10_000),
    permissions: PermissionsSchema
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export const ConfigSchema = z.object({
    // Required, not optional: loadConfig always injects a generated token
    // before parsing, so the only way this is missing is a hand-edited file
    // that deleted it — which must fail loudly rather than default to ''.
    auth: z.object({
        /** Generated on first run by loadConfig; 32 random bytes, hex. */
        bearer_token: z.string().length(64),
        /**
         * Hostnames the MCP endpoint may be reached on, for the SDK's DNS
         * rebinding protection. Empty means "accept any Host", which is the
         * right default for a LAN container reached by IP; pin hostnames when
         * running behind a reverse proxy.
         */
        allowed_hosts: z.array(z.string()).default([])
    }),
    services: z.partialRecord(ServiceIdSchema, ServiceConfigSchema).default({})
});
export type Config = z.infer<typeof ConfigSchema>;
