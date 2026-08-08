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
 * Permission tiers per the Both default to off: a service
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
 * Which services may appear more than once.
 *
 * Quality tiers are the reason anyone runs two of something: an HD and a 4K
 * Radarr, the matching Sonarrs, and a Bazarr per stack because Bazarr connects
 * to exactly one Radarr and one Sonarr.
 *
 * The other five are deliberately single. Prowlarr feeds every *arr from one
 * place and Seerr connects to your instances itself, so a second one is not a
 * tier — and more to the point, `register.ts` selects those with a `.find`.
 * Admitting a shape the code then degrades on is worse than refusing it, so the
 * schema refuses it.
 */
export const MULTI_INSTANCE: readonly ServiceId[] = ['bazarr', 'radarr', 'sonarr'];

/**
 * Goes into the qualified id (`radarr/4k`), which reaches audit rows, log
 * filters and eventually a tool parameter — so a `/` in here would make the id
 * ambiguous, and a space would make it unquotable in half the places it lands.
 */
const InstanceNameSchema = z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must be letters, digits, dashes or underscores, starting with one');

const NamedKeyedServiceSchema = z.strictObject({
    ...BaseServiceShape,
    ...ApiKeyShape,
    name: InstanceNameSchema
});

/**
 * The list form. Names are compared case-insensitively because `4K` and `4k`
 * naming two different Radarrs is a typo every time, never an intention.
 */
const InstanceListSchema = z
    .array(NamedKeyedServiceSchema)
    .min(1, 'list at least one instance, or use a single block instead of a list')
    .superRefine((list, ctx) => {
        const seen = new Map<string, number>();
        list.forEach((entry, index) => {
            const key = entry.name.toLowerCase();
            const first = seen.get(key);
            if (first !== undefined) {
                ctx.addIssue({
                    code: 'custom',
                    message: `duplicate instance name "${entry.name}" — already used by entry ${first + 1}`,
                    path: [index, 'name']
                });
                return;
            }
            seen.set(key, index);
        });
    });

/**
 * One block, as before, or a list of named ones. A union rather than a new key,
 * so every config that parses today parses unchanged — there is no migration
 * and no upgrade step, the same reasoning that made `password_hash` optional.
 */
const MultiInstanceServiceSchema = z.union([KeyedServiceSchema, InstanceListSchema]);
export type NamedKeyedServiceConfig = z.infer<typeof NamedKeyedServiceSchema>;
export type MultiInstanceServiceConfig = z.infer<typeof MultiInstanceServiceSchema>;

/**
 * A service config as an adapter receives it: the same shape, plus the name
 * that distinguishes it when several are configured.
 *
 * Carrying the name *in the config* rather than as a constructor argument is
 * what keeps this change from touching eight constructor signatures and every
 * test that builds an adapter by hand. The single form simply has no `name`.
 */
export type Instanced<T> = T & { readonly name?: string | undefined };

/**
 * What ServiceHttp needs from any service, whatever its auth shape. Derived
 * rather than parsed from its own schema — nothing ever validates against this
 * alone, and a schema with no parser is a schema that drifts.
 */
export type BaseServiceConfig = Pick<KeyedServiceConfig, 'url' | 'timeout_ms' | 'permissions'>;

/**
 * Jellyfin and Seerr only — the two services with their own
 * user concepts.
 *
 * `default_user` is optional on purpose: configuring a service purely so it
 * appears in stack_health is legitimate, and guessing an identity is the silent
 * mismatch warns about. A per-user tool called with nothing configured
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
 * Refuses a list, and says which services take one.
 *
 * Without this the reader gets zod's `expected object, received array`, which
 * is true but does not answer the question they actually have — they have just
 * seen a list work under `radarr` and reasonably tried it here.
 */
const singleOnly = <T extends z.ZodType>(schema: T) =>
    z
        .unknown()
        .superRefine((value, ctx) => {
            if (!Array.isArray(value)) return;
            ctx.addIssue({
                code: 'custom',
                message: `only ${MULTI_INSTANCE.join(', ')} can be a list of instances — give this service a single block`
            });
        })
        .pipe(schema);

/**
 * Strict as well, so an unknown service id is an error rather than a key that
 * silently vanishes. Someone adding `plex:` should be told it is unsupported,
 * not left wondering why nothing happened.
 */
const ServicesSchema = z
    .strictObject({
        radarr: MultiInstanceServiceSchema.optional(),
        sonarr: MultiInstanceServiceSchema.optional(),
        bazarr: MultiInstanceServiceSchema.optional(),
        prowlarr: singleOnly(KeyedServiceSchema).optional(),
        sabnzbd: singleOnly(KeyedServiceSchema).optional(),
        jellyfin: singleOnly(MultiUserServiceSchema).optional(),
        seerr: singleOnly(MultiUserServiceSchema).optional(),
        transmission: singleOnly(TransmissionServiceSchema).optional()
    })
    .default({});

/**
 * Metadata sources that are not services (0.8 spec ).
 *
 * Separate from `services` because nothing here is reachable, has a URL, or
 * can be tested — an instance card would have nothing to put on it. It also
 * holds no credential, so the no-echo rule that shapes the rest of the config
 * page does not reach it.
 *
 * `.strict()` on both levels, and the reason is the same in each. The setting
 * a user is most likely to invent is a refresh interval, and IMDb publishes
 * daily — there is no second answer to choose between. A knob whose only
 * sensible value is the default exists to be got wrong, and quietly ignoring
 * one that was set is worse than refusing it: the user believes it took
 * effect.
 */
export const MetadataSchema = z
    .object({
        imdb: z.object({ enabled: z.boolean().default(false) }).strict().optional()
    })
    .strict();

export type MetadataConfig = z.infer<typeof MetadataSchema>;

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
    services: ServicesSchema,
    /** Absent means off, exactly like a service nobody configured. */
    metadata: MetadataSchema.optional()
});
export type Config = z.infer<typeof ConfigSchema>;
