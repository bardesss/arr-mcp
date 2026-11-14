import * as z from 'zod/v4';
import { HASH_PATTERN, hashToken } from '../core/secrets.ts';
import { isAddressOrCidr } from '../core/trustedProxies.ts';

export const ServiceIdSchema = z.enum([
    'radarr',
    'sonarr',
    'whisparr',
    'lidarr',
    'prowlarr',
    'bazarr',
    'jellyfin',
    'seerr',
    'sabnzbd',
    'nzbget',
    'transmission',
    'qbittorrent',
    'plex',
    'profilarr',
    'cleanuparr',
    'reclaimerr',
    'dispatcharr',
    'shelfmark',
    'grimmory'
]);
export type ServiceId = z.infer<typeof ServiceIdSchema>;

/**
 * The download clients, as against the *arrs that send them releases: the
 * services pause_downloads takes, and the ones diagnose_media reads as a client.
 */
export const DOWNLOAD_CLIENTS: readonly ServiceId[] = ['sabnzbd', 'nzbget', 'transmission', 'qbittorrent'];

/** Marks which services a `service` field takes; read and removed by `mcp/leanSchema.ts`. */
export const SERVICES_KEY = 'x-arr-services';
/** Marks a `kind` field, whose enum the tool list trims to the kinds the configured services hold. */
export const KINDS_KEY = 'x-arr-kinds';
/** Maps enum values to the services they need, `{ bookdrop: ['grimmory'] }`; the tool list drops a value none of them is configured for. */
export const VALUES_KEY = 'x-arr-values';

/**
 * A `service` field that advertises only the services this tool takes.
 *
 * Validation still accepts every service id, on purpose: a tool's own refusal
 * names the services it does take and what to do instead, which a bare enum
 * error would not. Only the schema a client reads is narrowed (#518).
 */
export const serviceOf = (services: readonly ServiceId[]) => ServiceIdSchema.meta({ [SERVICES_KEY]: [...services] });

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
 * Shared by every service. Every concrete schema below is a *strict* object, so a
 * misspelled key fails at startup instead of being silently dropped, which is
 * the difference between "my timeout setting does nothing" taking a minute to
 * diagnose or an afternoon.
 */
const BaseServiceShape = {
    url: UrlSchema,
    timeout_ms: z.number().int().positive().max(2_147_483_647).default(10_000),
    permissions: PermissionsSchema
};

const ApiKeyShape = { api_key: z.string().min(1, 'api_key must not be empty') };

/** Every service that takes an API key and nothing more, the *arrs and SABnzbd among them. */
const KeyedServiceSchema = z.strictObject({ ...BaseServiceShape, ...ApiKeyShape });

export type KeyedServiceConfig = z.infer<typeof KeyedServiceSchema>;

/**
 * Shelfmark, whose default is no authentication at all: every route is open and
 * there is no key to give.
 */
const OptionalKeyServiceSchema = z.strictObject({ ...BaseServiceShape, api_key: ApiKeyShape.api_key.optional() });
type OptionalKeyServiceConfig = z.infer<typeof OptionalKeyServiceSchema>;

/** Grimmory has no API key: it signs in with a username and password and gets a JWT back. */
const GrimmoryServiceSchema = z.strictObject({
    ...BaseServiceShape,
    username: z.string().min(1),
    password: z.string().min(1)
});
type GrimmoryServiceConfig = z.infer<typeof GrimmoryServiceSchema>;


/**
 * Goes into the qualified id (`radarr/4k`), which reaches audit rows, log
 * filters and eventually a tool parameter, so a `/` in here would make the id
 * ambiguous, and a space would make it unquotable in half the places it lands.
 */
const InstanceNameSchema = z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must be letters, digits, dashes or underscores, starting with one');

/**
 * Names are compared case-insensitively because `4K` and `4k` naming two
 * different Radarrs is a typo every time, never an intention.
 *
 * Shared by the keyed and credential lists rather than pasted into both: two
 * copies is two chances to disagree about whether `Main` and `main` are one
 * instance.
 */
const uniqueNames = (list: readonly { name: string }[], ctx: z.RefinementCtx): void => {
    const seen = new Map<string, number>();
    list.forEach((entry, index) => {
        const key = entry.name.toLowerCase();
        const first = seen.get(key);
        if (first !== undefined) {
            ctx.addIssue({
                code: 'custom',
                message: `duplicate instance name "${entry.name}", already used by entry ${first + 1}`,
                path: [index, 'name']
            });
            return;
        }
        seen.set(key, index);
    });
};

/**
 * One block, as before, or a list of named ones. A union rather than a new key,
 * so every config that parses today parses unchanged; there is no migration
 * and no upgrade step, the same reasoning that made `password_hash` optional.
 *
 * The shape picks the branch before the union runs: an array can only be the
 * list, and anything else only the block. A missing or wrong-typed field fails
 * both branches, and a union that fails both reports only "Invalid input" at the
 * service. Checked against the one branch its shape allows, the value fails
 * with that branch's own issues, which name the field (`services.lidarr.api_key`,
 * `services.radarr[1].url`). The union still does the parsing, so a config that
 * parses is read exactly as before.
 *
 * Each issue is re-added as `custom` so the pipe stops there: it goes on past an
 * `unrecognized_keys` issue, into the union.
 */
const listOrBlock = <B extends z.ZodType, L extends z.ZodType>(block: B, list: L) =>
    z
        .unknown()
        .superRefine((value, ctx) => {
            const result = (Array.isArray(value) ? list : block).safeParse(value);
            if (result.success) return;
            for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
        })
        .pipe(z.union([block, list]));

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
 * rather than parsed from its own schema; nothing ever validates against this
 * alone, and a schema with no parser is a schema that drifts.
 */
export type BaseServiceConfig = Pick<KeyedServiceConfig, 'url' | 'timeout_ms' | 'permissions'>;

/**
 * Jellyfin and Seerr only; the two services with their own
 * user concepts.
 *
 * `default_user` is optional on purpose: configuring a service purely so it
 * appears in get_stack_health is legitimate, and guessing an identity is the silent
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

/** Plex alone gets the repair switch; Jellyfin repairs without one. */
const PlexServiceSchema = z.strictObject({
    ...MultiUserServiceSchema.shape,
    allow_metadata_repair: z.boolean().default(true)
});
export type PlexServiceConfig = z.infer<typeof PlexServiceSchema>;

/**
 * The services without an API key: Transmission and NZBGet take HTTP Basic,
 * qBittorrent a login that returns a cookie. Both credential parts are optional
 * because a LAN Transmission is commonly unauthenticated and qBittorrent can
 * bypass auth for localhost.
 */
const CredentialServiceSchema = z.strictObject({
    ...BaseServiceShape,
    username: z.string().min(1).optional(),
    password: z.string().optional()
});
export type CredentialServiceConfig = z.infer<typeof CredentialServiceSchema>;

export type AnyServiceConfig = KeyedServiceConfig | MultiUserServiceConfig | PlexServiceConfig | CredentialServiceConfig;

/**
 * Which config shape each service id carries.
 *
 * Written out rather than inferred from `ServicesSchema`, because the schema's
 * entry for a multi-instance service is a union of one block and a list of
 * named ones, and unwrapping that in the type system reads far worse than the
 * ten lines it would replace.
 *
 * This exists so `buildAdapter` can narrow on `type` instead of casting.
 * Before it, every case in that switch restated its config type with an
 * unchecked `as`, and two of them needed no cast at all; every member of
 * `AnyServiceConfig` structurally satisfies `Instanced<CredentialServiceConfig>`,
 * so the compiler accepted anything there and a swapped case body would have
 * shipped.
 */
/**
 * A phantom field naming the service a config belongs to.
 *
 * Optional on purpose, and that is the whole trick. Optional does not mean
 * ignored: with `exactOptionalPropertyTypes`, a value whose type declares
 * `__service?: 'jellyfin'` is **not** assignable where `__service?: 'radarr'`
 * is expected, so two configs that are structurally identical stop being
 * interchangeable. But a plain object literal that declares no `__service` at
 * all still satisfies either, so every test that builds a config by hand keeps
 * working and nothing has to carry the brand around.
 *
 * It exists at the type level only. Nothing reads it, nothing writes it, and
 * it never appears in a parsed config.
 */
type For<Id extends ServiceId, T> = T & { readonly __service?: Id };

export type ConfigByService = {
    radarr: For<'radarr', Instanced<KeyedServiceConfig>>;
    sonarr: For<'sonarr', Instanced<KeyedServiceConfig>>;
    whisparr: For<'whisparr', Instanced<KeyedServiceConfig>>;
    lidarr: For<'lidarr', Instanced<KeyedServiceConfig>>;
    bazarr: For<'bazarr', Instanced<KeyedServiceConfig>>;
    prowlarr: For<'prowlarr', Instanced<KeyedServiceConfig>>;
    sabnzbd: For<'sabnzbd', Instanced<KeyedServiceConfig>>;
    nzbget: For<'nzbget', Instanced<CredentialServiceConfig>>;
    jellyfin: For<'jellyfin', MultiUserServiceConfig>;
    seerr: For<'seerr', MultiUserServiceConfig>;
    plex: For<'plex', PlexServiceConfig>;
    transmission: For<'transmission', Instanced<CredentialServiceConfig>>;
    qbittorrent: For<'qbittorrent', Instanced<CredentialServiceConfig>>;
    profilarr: For<'profilarr', KeyedServiceConfig>;
    cleanuparr: For<'cleanuparr', KeyedServiceConfig>;
    reclaimerr: For<'reclaimerr', KeyedServiceConfig>;
    dispatcharr: For<'dispatcharr', KeyedServiceConfig>;
    shelfmark: For<'shelfmark', OptionalKeyServiceConfig>;
    grimmory: For<'grimmory', GrimmoryServiceConfig>;
};

/**
 * What a service's entry says about it, read off its own schema so the two
 * cannot disagree: which fields it has, which it cannot do without, whether
 * it can be a list, and whether arr-mcp ever writes to it.
 */
type ServiceTraits = {
    readonly multiInstance: boolean;
    readonly readOnly: boolean;
    readonly fields: ReadonlySet<string>;
    readonly required: ReadonlySet<string>;
};

/**
 * Where a credential can come from instead of the file itself (#636): a
 * `<field>_file` beside it naming a file to read, or the whole value written as
 * `${NAME}` to read environment variable NAME. Both are resolved by
 * `resolveSecrets`, never here, so the parsed config keeps the reference and a
 * save from the config UI writes the reference back rather than the secret.
 *
 * The block's own schema still says whether the credential is required, so
 * `serviceTraits` reads the same as before; the parsing schema makes the field
 * optional, adds the `_file` key, and puts the requirement back as "exactly
 * one of the two" (or "at most one" where the credential was optional).
 */
const SecretFileSchema = z.string().min(1, 'must name a file');

/**
 * Typed as the block it came from. Every reader of a credential that runs
 * against the stored form (the API's `apiKeySet`, the form's edit rules) reads
 * it as possibly absent already, and the adapters only ever see a resolved
 * config, where the type is true again. Typing the optional field honestly
 * would ripple through every adapter's constructor for no reader that needs it.
 */
const withSecretSources = <B extends z.ZodObject>(block: B) => {
    const field = 'api_key' in block.shape ? 'api_key' : 'password';
    const fileKey = `${field}_file`;
    const original = block.shape[field] as z.ZodType;
    const required = !original.safeParse(undefined).success;
    const parsing = block.extend({ [field]: original.optional(), [fileKey]: SecretFileSchema.optional() }) as unknown as B;
    const rule = (entry: Record<string, unknown>, ctx: z.RefinementCtx): void => {
        if (entry[field] !== undefined && entry[fileKey] !== undefined) {
            ctx.addIssue({ code: 'custom', path: [fileKey], message: `cannot be set together with ${field}; keep one of them` });
        } else if (required && entry[field] === undefined && entry[fileKey] === undefined) {
            ctx.addIssue({ code: 'custom', path: [field], message: `is required (or name a file with ${fileKey})` });
        }
    };
    return { parsing, rule };
};

const traitsOf = (block: z.ZodObject, multiInstance: boolean, readOnly: boolean): ServiceTraits => {
    const fields = Object.entries(block.shape) as [string, z.ZodType][];
    return {
        multiInstance,
        readOnly,
        fields: new Set(fields.map(([key]) => key)),
        required: new Set(fields.filter(([, field]) => !field.safeParse(undefined).success).map(([key]) => key))
    };
};

/** The list form: the same block, named, and no two names alike. */
const multi = <Shape extends z.core.$ZodShape>(block: z.ZodObject<Shape, z.core.$strict>) => {
    const { parsing, rule } = withSecretSources(block);
    return {
        schema: listOrBlock(
            parsing.superRefine(rule),
            z
                .array(parsing.extend({ name: InstanceNameSchema }).superRefine(rule))
                .min(1, 'list at least one instance, or use a single block instead of a list')
                .superRefine((list, ctx) => uniqueNames(list as { name: string }[], ctx))
        ),
        traits: traitsOf(block, true, false)
    };
};

/**
 * Refuses a list, and says which services take one.
 *
 * Without this the reader gets zod's `expected object, received array`, which
 * is true but does not answer the question they actually have; they have just
 * seen a list work under `radarr` and reasonably tried it here.
 */
const singleOnly = <T extends z.ZodType>(schema: T) =>
    z
        .unknown()
        .superRefine((value, ctx) => {
            if (!Array.isArray(value)) return;
            ctx.addIssue({
                code: 'custom',
                message: `only ${MULTI_INSTANCE.join(', ')} can be a list of instances. Give this service a single block`
            });
        })
        .pipe(schema);

const single = <B extends z.ZodObject>(block: B) => {
    const { parsing, rule } = withSecretSources(block);
    return { schema: singleOnly(parsing.superRefine(rule)), traits: traitsOf(block, false, false) };
};

/**
 * Write flags on a service nothing writes to would be reported as granted
 * while granting nothing, so they are read as off whatever the file says.
 */
const readOnly = <B extends z.ZodObject>(block: B) => {
    const { parsing, rule } = withSecretSources(block);
    return {
        schema: singleOnly(parsing.superRefine(rule).transform(c => ({ ...c, permissions: { safe_write: false, destructive: false } }))),
        traits: traitsOf(block, false, true)
    };
};

/**
 * Every service, and which may appear more than once.
 *
 * Quality tiers are the reason anyone runs two *arrs, and a Bazarr follows each
 * pair because it connects to exactly one of each. A Lidarr tier can be, for
 * example, a lossless library beside a lossy one. The download clients and
 * Prowlarr are here for a different reason: nothing selects them by anything but
 * capability, so a second one is merged into reads and named on writes with no
 * special case.
 *
 * The ones left out are refusals, not omissions; most say why beside their key
 * in this table, and the rest are here. `get_library`'s `presence` asks
 * whether the media server can see a file, which has no answer with two media
 * servers; and a Seerr request carries a user identity that a second instance
 * makes ambiguous.
 */
const SERVICES = {
    radarr: multi(KeyedServiceSchema),
    sonarr: multi(KeyedServiceSchema),
    // Single only: the one deployment that wants two Whisparrs is V2
    // beside V3 (Eros), and Eros is a different API with no adapter.
    whisparr: single(KeyedServiceSchema),
    // A list, like Radarr: a second Lidarr can be a quality tier too, for
    // example lossless beside lossy. Reads name the instance a row came
    // from (`lidarr/flac`), an artist both hold is one row as a film two
    // Radarrs hold is, and writes refuse to guess between them.
    lidarr: multi(KeyedServiceSchema),
    bazarr: multi(KeyedServiceSchema),
    prowlarr: multi(KeyedServiceSchema),
    sabnzbd: multi(KeyedServiceSchema),
    nzbget: multi(CredentialServiceSchema),
    jellyfin: single(MultiUserServiceSchema),
    seerr: single(MultiUserServiceSchema),
    transmission: multi(CredentialServiceSchema),
    qbittorrent: multi(CredentialServiceSchema),
    plex: single(PlexServiceSchema),
    // Single only: Profilarr is the one place that owns profile config,
    // so two of them would mean two sources of truth.
    profilarr: single(KeyedServiceSchema),
    // Single only: one Cleanuparr cleans one stack.
    cleanuparr: readOnly(KeyedServiceSchema),
    // Single only: one Reclaimerr owns one library's cleanup rules.
    reclaimerr: readOnly(KeyedServiceSchema),
    // Single only: one Dispatcharr serves one set of playlists.
    dispatcharr: readOnly(KeyedServiceSchema),
    // Single only: one Shelfmark holds one download queue and one set of requests.
    shelfmark: single(OptionalKeyServiceSchema),
    // Single only: one Grimmory is the book library, and get_library's book rows need one source.
    grimmory: single(GrimmoryServiceSchema)
} satisfies Record<ServiceId, { schema: z.ZodType; traits: ServiceTraits }>;

export const serviceTraits = (type: ServiceId): ServiceTraits => SERVICES[type].traits;

export const MULTI_INSTANCE: readonly ServiceId[] = ServiceIdSchema.options.filter(id => SERVICES[id].traits.multiInstance).sort();

/** The field a blank form entry keeps as it was, and that must not follow the instance to a new host. */
export const secretFieldOf = (type: ServiceId): 'api_key' | 'password' =>
    serviceTraits(type).fields.has('api_key') ? 'api_key' : 'password';

/**
 * Strict as well, so an unknown service id is an error rather than a key that
 * silently vanishes. Someone adding `plex:` should be told it is unsupported,
 * not left wondering why nothing happened.
 */
const ServicesSchema = z
    .strictObject(
        Object.fromEntries(Object.entries(SERVICES).map(([id, entry]) => [id, entry.schema.optional()])) as {
            [Id in keyof typeof SERVICES]: z.ZodOptional<(typeof SERVICES)[Id]['schema']>;
        }
    )
    .superRefine((services, ctx) => {
        /**
         * Jellyfin and Seerr issue one admin-scoped key that can answer for
         * anybody, which is what `allow_other_users` governs. A Plex
         * `X-Plex-Token` is scoped to a single account (`PlexAdapter` never
         * reads this flag and always reports account 1 as the only user) so
         * admitting `true` here would accept a shape the adapter then quietly
         * ignores. Refused, the same call the rest of this schema makes.
         */
        if (services.plex?.allow_other_users === true) {
            ctx.addIssue({
                code: 'custom',
                message:
                    'must be false. A Plex token is scoped to one account, so there is no second user to permit.',
                path: ['plex', 'allow_other_users']
            });
        }
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
const MetadataSchema = z
    .object({
        imdb: z.object({ enabled: z.boolean().default(false) }).strict().optional()
    })
    .strict();


/**
 * How the config UI looks. Server-side rather than a browser cookie because
 * this UI has exactly one account (there is no second person for a shared
 * setting to be wrong for) and it keeps the rule that everything the UI does
 * is still just `config.yaml`.
 *
 * `system` is the default and follows `prefers-color-scheme`. The other two are
 * a deliberate override, for the display that is not the one the OS was set up
 * for.
 */
export const ThemeSchema = z.enum(['system', 'dark', 'light']);
export type Theme = z.infer<typeof ThemeSchema>;

const UiSchema = z.strictObject({ theme: ThemeSchema.default('system') });

/**
 * The three scopes, one per access level `core/permissions.ts` already
 * distinguishes. Not a new axis beside the tiers: a read/write pair would
 * collapse `safe` and `destructive` back together, which is the one
 * distinction this repo has decided is worth keeping.
 *
 * Renameable because an operator's authorization server may already have a
 * naming convention, and a scope string is theirs to choose. The mapping to
 * tiers is not.
 */
const OAuthScopesSchema = z
    .strictObject({
        read: z.string().min(1).default('arr-mcp:read'),
        write: z.string().min(1).default('arr-mcp:write'),
        destructive: z.string().min(1).default('arr-mcp:destructive')
    })
    // Otherwise `{read: x, write: x, destructive: x}` parses, and PR 2 reads a
    // read-scoped token as carrying every tier; the one failure this whole
    // block exists to refuse.
    .refine(value => new Set([value.read, value.write, value.destructive]).size === 3, {
        message: 'must name three distinct scopes'
    });

/**
 * HTTPS, or `http:` on a loopback host for testing against a local provider.
 * Protocol and host are checked together; checking them as two independent
 * ORs would accept `ftp://localhost`, since a loopback hostname alone
 * satisfied the check regardless of scheme.
 */
const isHttpsOrLoopback = (value: string): boolean => {
    // Unparseable is `z.url()`'s to report; `new URL` would throw out of the parse.
    if (!URL.canParse(value)) return true;
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
};

/**
 * Absent means off, exactly like a service nobody configured.
 *
 * Strict, and `auth` is strict with it: a misspelled key inside a
 * non-strict object is silently dropped, which would leave `/mcp` quietly on
 * the static-token path while the operator believed OAuth was in force. That
 * is the failure this block most needs to refuse, so it refuses it at both
 * levels.
 *
 * `jwks_uri` is required rather than discovered. OIDC discovery would be a
 * second outbound request to a path derived from the issuer; one config line
 * buys that whole class of surprise away.
 */
export const OAuthSchema = z.strictObject({
    /**
     * HTTPS, or a loopback host for testing against a local provider. The
     * MCP SDK's `buildOAuthProtectedResourceMetadata` enforces the same rule
     * and throws when it is broken; refusing here means a bad issuer is a
     * fatal config error at startup rather than a 500 from the metadata
     * route.
     */
    issuer: z
        .url()
        .refine(isHttpsOrLoopback, { message: 'must be https, or http on localhost' })
        .refine(value => !URL.canParse(value) || (new URL(value).hash === '' && new URL(value).search === ''), {
            message: 'must not carry a query string or a fragment'
        }),
    /**
     * Not optional, and this is the one field most likely to be left out.
     * Without it, every token that issuer ever minted for any of its clients
     * is accepted here.
     */
    audience: z.string().min(1),
    // Same rule as `issuer`: PR 2 fetches signing keys from here, and plaintext
    // JWKS is exactly the traffic a proxy log or a network path could tamper
    // with in flight.
    jwks_uri: z.url().refine(isHttpsOrLoopback, { message: 'must be https, or http on localhost' }),
    scopes: OAuthScopesSchema.prefault({})
});

export type OAuthConfig = z.infer<typeof OAuthSchema>;

const MIN_PLAINTEXT_TOKEN = 32;

const McpTokenSchema = z.strictObject({
    name: InstanceNameSchema,
    tier: z.enum(['read', 'write', 'destructive']),
    hash: z.string().regex(HASH_PATTERN, 'hash must be sha256:<64 hex>').optional(),
    token: z.string().optional(),
    expires: z.iso.date().optional()
});

type RawToken = z.infer<typeof McpTokenSchema>;

export function tokensNeedingRewrite(rawAuth: unknown): string[] {
    if (rawAuth === null || typeof rawAuth !== 'object') return [];
    const auth = rawAuth as { bearer_token?: unknown; tokens?: unknown };
    const names = auth.bearer_token === undefined ? [] : ['default'];
    if (Array.isArray(auth.tokens)) {
        for (const t of auth.tokens as { name?: unknown; token?: unknown }[]) {
            if (t?.token !== undefined) names.push(String(t.name));
        }
    }
    return names;
}

/** The single key from before named keys. Normalised into a `default` admin entry on parse. */
const LegacyManagementKeySchema = z.strictObject({
    hash: z.string().regex(HASH_PATTERN, 'hash must be sha256:<64 hex>'),
    created: z.iso.date()
});

/** Hash only: unlike MCP tokens there is no plaintext form to hand-write. */
const ManagementKeySchema = z.strictObject({
    name: InstanceNameSchema,
    tier: z.enum(['read', 'admin']),
    ...LegacyManagementKeySchema.shape
});

type NamedManagementKey = z.infer<typeof ManagementKeySchema>;

/**
 * Named, rather than inlined into `ConfigSchema`, so `load.ts`'s salvage path
 * can parse against it directly. `ConfigSchema`'s `auth` field is this same
 * object with the oauth/allow_token_in_url refinement chained on, but the
 * salvage parse runs precisely when the rest of the file is already broken,
 * and wants the *unrefined* object: a cross-field check there would only make
 * salvage fail for a combination that has nothing to do with why the file
 * doesn't load.
 */
export const AuthSchema = z.strictObject({
    /** Pre-1.34 single token. Normalised into a `default` entry on parse. */
    bearer_token: z.string().length(64).optional(),
    tokens: z.array(McpTokenSchema).optional(),
    /** Who logs into the config UI. Defaulted rather than generated;
     *  a random username helps nobody and is one more thing to look up. */
    username: z.string().min(1).default('admin'),
    /**
     * scrypt hash of the UI password, `scrypt$salt$hash`.
     *
     * Optional, and that is the design: absent means **unclaimed**, so the
     * config UI serves its setup page until someone chooses a password in
     * the browser.
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
    allowed_hosts: z.array(z.string()).default([]),
    /**
     * Peers whose `X-Forwarded-For`, `Forwarded` and `X-Forwarded-Proto` are
     * believed, as addresses or CIDR ranges. Absent means none: the sign-in
     * throttle then counts every request against the address that connected,
     * which behind a proxy is the proxy, and `X-Forwarded-Proto` is taken from
     * any peer.
     */
    trusted_proxies: z
        .array(z.string().trim().refine(isAddressOrCidr, { message: 'must be an IP address or a CIDR range such as 172.18.0.0/16' }))
        .optional(),
    oauth: OAuthSchema.optional(),
    /** Pre-named-keys single key. Normalised into a `default` entry on parse. */
    management_key: LegacyManagementKeySchema.optional(),
    /** The management API's keys. Absent means the API is off. */
    management_keys: z.array(ManagementKeySchema).optional()
});

export const MediaServerIdSchema = z.enum(['jellyfin', 'plex']);
export type MediaServerId = z.infer<typeof MediaServerIdSchema>;

export const mediaServersIn = (services: Readonly<Record<string, unknown>>): MediaServerId[] =>
    MediaServerIdSchema.options.filter(id => services[id] !== undefined);

/**
 * The library event log. A plain secret, like a service's `api_key` and unlike an
 * MCP token, because it has to be pasted into every *arr and can only write event
 * rows. The API never returns it, and the config page shows it masked.
 */
const WebhooksSchema = z
    .strictObject({
        enabled: z.boolean().default(false),
        secret: z.string().min(32).optional(),
        retention_days: z.number().int().min(1).max(3650).default(30)
    })
    .refine(value => !value.enabled || value.secret !== undefined, {
        message: 'needs a secret of at least 32 characters while enabled',
        path: ['secret']
    });

const ConfigShape = {
    // Parsing normalises tokens, so two parses of one file always agree.
    auth: AuthSchema.refine(value => !(value.oauth !== undefined && value.allow_token_in_url), {
        message: 'must be false while auth.oauth is configured. A JWT in the URL reaches every proxy log',
        path: ['allow_token_in_url']
    })
        .superRefine((auth, ctx) => {
            if (auth.bearer_token !== undefined && auth.tokens !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['bearer_token'], message: 'cannot be set together with tokens; move the old token into tokens or delete it' });
            }
            const seen = new Set<string>();
            (auth.tokens ?? []).forEach((t: RawToken, i: number) => {
                const key = t.name.toLowerCase();
                if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['tokens', i, 'name'], message: `duplicate token name "${t.name}"` });
                seen.add(key);
                if ((t.hash === undefined) === (t.token === undefined)) {
                    ctx.addIssue({ code: 'custom', path: ['tokens', i], message: `token '${t.name}' needs exactly one of hash or token` });
                } else if (t.token !== undefined && t.token.length < MIN_PLAINTEXT_TOKEN) {
                    ctx.addIssue({ code: 'custom', path: ['tokens', i, 'token'], message: `token '${t.name}' must be at least ${MIN_PLAINTEXT_TOKEN} characters` });
                }
            });
            if (auth.management_key !== undefined && auth.management_keys !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['management_key'], message: 'cannot be set together with management_keys; move the old key into management_keys or delete it' });
            }
            const seenKeys = new Set<string>();
            (auth.management_keys ?? []).forEach((k: NamedManagementKey, i: number) => {
                const key = k.name.toLowerCase();
                if (seenKeys.has(key)) ctx.addIssue({ code: 'custom', path: ['management_keys', i, 'name'], message: `duplicate management key name "${k.name}"` });
                seenKeys.add(key);
            });
        })
        .transform(({ bearer_token, tokens, management_key, management_keys, ...rest }) => {
            const keys: NamedManagementKey[] = [
                ...(management_key === undefined ? [] : [{ name: 'default', tier: 'admin' as const, ...management_key }]),
                ...(management_keys ?? [])
            ];
            return {
                ...rest,
                tokens: [
                    ...(bearer_token === undefined ? [] : [{ name: 'default', tier: 'destructive' as const, hash: hashToken(bearer_token) }]),
                    ...(tokens ?? []).map(({ token, hash, ...t }: RawToken) => ({ ...t, hash: hash ?? hashToken(token as string) }))
                ],
                // Absent rather than empty: an instance that never used the API
                // should not gain a key older versions refuse to load.
                ...(keys.length === 0 ? {} : { management_keys: keys })
            };
        }),
    services: ServicesSchema,
    /** Which media server the tools default to. Required when both are configured. */
    primary_media_server: MediaServerIdSchema.optional(),
    /** Absent means off, exactly like a service nobody configured. */
    metadata: MetadataSchema.optional(),
    /** Absent means `system`, so a config nobody touched stays as clean as it
     *  started, the same reasoning as `metadata`. */
    ui: UiSchema.optional(),
    /** Absent means off, and the route answers 404. */
    webhooks: WebhooksSchema.optional(),
    /**
     * How much of the tool surface a client sees. A write tool none of whose
     * services is configured is never listed. Absent means every read stays,
     * which keeps saved prompts working; `hide_unusable` is the opt-in for a
     * small stack that would rather not pay context for reads it cannot use (#518).
     * `media_cards: false` turns the MCP Apps poster cards off: no `_meta.ui`
     * on the tools, no `ui://` resource, and none of the queue reads behind
     * them. This is for an HTTP client that cannot render them and does not say so.
     */
    tools: z
        .object({ hide_unusable: z.boolean().default(false), media_cards: z.boolean().default(true) })
        .strict()
        .optional()
};

/** Edit distance, for naming the key a typo was probably meant to be. */
function distance(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            const swap = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + swap);
        }
        prev = row;
    }
    return prev[b.length] ?? 0;
}

/**
 * Names each stray key, and the known key it is probably a typo for. The
 * stray key stays in quotes, which the unauthenticated repair surfaces redact,
 * since a mis-indented value can land in key position. The suggestion is one
 * of this schema's own keys, so it is left bare.
 */
function unknownTopLevelKeys(keys: readonly string[]): string {
    const known = Object.keys(ConfigShape);
    const named = keys.map(key => {
        // Within two edits, and within half the known key's length, so `id`
        // is not offered `ui`.
        const scored = known
            .map(k => ({ k, d: distance(key.toLowerCase(), k) }))
            .filter(({ k, d }) => d <= Math.min(2, Math.floor(k.length / 2)))
            .sort((a, b) => a.d - b.d);
        const near = scored[0]?.k;
        return near === undefined ? `"${key}"` : `"${key}" (did you mean ${near}?)`;
    });
    return `Unrecognized top-level key${keys.length === 1 ? '' : 's'} ${named.join(', ')}: rename or remove ${keys.length === 1 ? 'it' : 'them'}`;
}

/**
 * Strict like every level below it: a misspelled `service:` or `webhook:` used
 * to load as a healthy instance with nothing configured.
 */
export const ConfigSchema = z.strictObject(ConfigShape, {
    error: issue => (issue.code === 'unrecognized_keys' ? unknownTopLevelKeys(issue.keys) : undefined)
}).superRefine((config, ctx) => {
    // `jellyfin` and `plex` are distinct, individually valid keys, so the two
    // together are admitted, and this rule says which one the tools default to.
    // Refused rather than guessed: a silent default would send a Plex question
    // to Jellyfin, or the reverse.
    const configured = mediaServersIn(config.services);
    const primary = config.primary_media_server;
    if (configured.length === 2 && primary === undefined) {
        ctx.addIssue({
            code: 'custom',
            path: ['primary_media_server'],
            message: 'set to jellyfin or plex: both are configured, so arr-mcp needs to know which one the tools default to'
        });
    }
    if (primary !== undefined && !configured.includes(primary)) {
        ctx.addIssue({
            code: 'custom',
            path: ['primary_media_server'],
            message: `is ${primary}, but services.${primary} is not configured`
        });
    }
});
export type Config = z.infer<typeof ConfigSchema>;
