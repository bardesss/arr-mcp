import * as z from 'zod/v4';

export const ServiceIdSchema = z.enum([
    'radarr',
    'sonarr',
    'prowlarr',
    'bazarr',
    'jellyfin',
    'seerr',
    'sabnzbd',
    'transmission',
    'qbittorrent'
]);
export type ServiceId = z.infer<typeof ServiceIdSchema>;

/**
 * Both default to off: a service added by hand-editing YAML must not
 * silently acquire write access.
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
 * Shared by all nine. Every concrete schema below is a *strict* object, so a
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
 * Which services may appear more than once. Quality tiers are the reason anyone
 * runs two — an HD and a 4K Radarr, their Sonarrs, and a Bazarr per stack
 * because Bazarr connects to exactly one of each.
 *
 * The other five are deliberately single: a second Prowlarr or Seerr is not a
 * tier, and `register.ts` selects those with a `.find`. Admitting a shape the
 * code then degrades on is worse than refusing it.
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
 * degrades instead, naming this key in the note.
 */
const MultiUserServiceSchema = z.strictObject({
    ...BaseServiceShape,
    ...ApiKeyShape,
    default_user: z.string().min(1).optional(),
    allow_other_users: z.boolean().default(false)
});
export type MultiUserServiceConfig = z.infer<typeof MultiUserServiceSchema>;

/**
 * The two torrent clients, neither of which has an API key: Transmission takes
 * HTTP Basic, qBittorrent a login that returns a cookie. Both credential parts
 * are optional because a LAN Transmission is commonly unauthenticated and
 * qBittorrent can bypass auth for localhost.
 */
const CredentialServiceSchema = z.strictObject({
    ...BaseServiceShape,
    username: z.string().min(1).optional(),
    password: z.string().optional()
});
export type CredentialServiceConfig = z.infer<typeof CredentialServiceSchema>;

export type AnyServiceConfig = KeyedServiceConfig | MultiUserServiceConfig | CredentialServiceConfig;

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
        transmission: singleOnly(CredentialServiceSchema).optional(),
        qbittorrent: singleOnly(CredentialServiceSchema).optional()
    })
    .default({});

/**
 * Metadata sources that are not services: nothing here is reachable, has a URL
 * or can be tested, and none of it is a credential.
 *
 * `.strict()` at both levels because the setting a user is most likely to
 * invent is a refresh interval, and there is no value they could pick that
 * would serve them better than the weekly one `REFRESH_INTERVAL_MS` explains.
 * Quietly ignoring one that was set is worse than refusing it, since the user
 * believes it took effect.
 */
export const MetadataSchema = z
    .object({
        imdb: z.object({ enabled: z.boolean().default(false) }).strict().optional()
    })
    .strict();


/**
 * How the config UI looks. Server-side rather than a browser cookie because
 * this UI has exactly one account — there is no second person for a shared
 * setting to be wrong for — and it keeps the rule that everything the UI does
 * is still just `config.yaml`.
 *
 * `system` is the default and follows `prefers-color-scheme`. The other two are
 * a deliberate override, for the display that is not the one the OS was set up
 * for.
 */
export const ThemeSchema = z.enum(['system', 'dark', 'light']);
export type Theme = z.infer<typeof ThemeSchema>;

const UiSchema = z.strictObject({ theme: ThemeSchema.default('system') });

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
         * Optional, unlike `bearer_token`, and that difference is the design:
         * absent means **unclaimed**, so the config UI serves its setup page
         * until someone chooses a password in the browser. A bearer token has
         * no interactive path and must be generated; a password does, so one is
         * never invented.
         *
         * Deleting this line is how you ask for a new password. The password
         * itself is never stored and never logged.
         */
        password_hash: z.string().min(1).optional(),
        /**
         * Whether `/mcp` accepts the token as `?token=` when no Authorization
         * header is sent. Off by default: it works for clients that can only be
         * given a URL, at the cost of the token reaching proxy logs.
         */
        allow_token_in_url: z.boolean().default(false),
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
    metadata: MetadataSchema.optional(),
    /** Absent means `system`, so a config nobody touched stays as clean as it
     *  started — the same reasoning as `metadata`. */
    ui: UiSchema.optional()
});
export type Config = z.infer<typeof ConfigSchema>;
