import * as z from 'zod/v4';
import { hashToken } from '../core/mcpTokens.ts';

export const ServiceIdSchema = z.enum([
    'radarr',
    'sonarr',
    'whisparr',
    'prowlarr',
    'bazarr',
    'jellyfin',
    'seerr',
    'sabnzbd',
    'transmission',
    'qbittorrent',
    'plex',
    'profilarr'
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
    timeout_ms: z.number().int().positive().max(2_147_483_647).default(10_000),
    permissions: PermissionsSchema
};

const ApiKeyShape = { api_key: z.string().min(1, 'api_key must not be empty') };

/** Radarr, Sonarr, Prowlarr, Bazarr, SABnzbd — an API key and nothing more. */
const KeyedServiceSchema = z.strictObject({ ...BaseServiceShape, ...ApiKeyShape });
export type KeyedServiceConfig = z.infer<typeof KeyedServiceSchema>;

/**
 * Which services may appear more than once.
 *
 * Quality tiers are the reason anyone runs two *arrs, and a Bazarr follows each
 * pair because it connects to exactly one of each. The download clients and
 * Prowlarr are here for a different reason: nothing selects them by anything but
 * capability, so a second one is merged into reads and named on writes with no
 * special case.
 *
 * The three left out are refusals, not omissions. `get_library`'s `presence`
 * asks whether the media server can see a file, which has no answer with two of
 * them; and a Seerr request carries a user identity that a second instance
 * makes ambiguous.
 */
export const MULTI_INSTANCE: readonly ServiceId[] = [
    'bazarr',
    'prowlarr',
    'qbittorrent',
    'radarr',
    'sabnzbd',
    'sonarr',
    'transmission'
];

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

/** The list form, for services taking an api_key. */
const InstanceListSchema = z
    .array(NamedKeyedServiceSchema)
    .min(1, 'list at least one instance, or use a single block instead of a list')
    .superRefine(uniqueNames);

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

/** Plex alone gets the repair switch: its repair is unverified against a live server (#203). */
const PlexServiceSchema = z.strictObject({
    ...MultiUserServiceSchema.shape,
    allow_metadata_repair: z.boolean().default(false)
});
export type PlexServiceConfig = z.infer<typeof PlexServiceSchema>;

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

const NamedCredentialServiceSchema = z.strictObject({
    ...BaseServiceShape,
    username: z.string().min(1).optional(),
    password: z.string().optional(),
    name: InstanceNameSchema
});

const CredentialInstanceListSchema = z
    .array(NamedCredentialServiceSchema)
    .min(1, 'list at least one instance, or use a single block instead of a list')
    .superRefine(uniqueNames);

const MultiInstanceCredentialSchema = z.union([CredentialServiceSchema, CredentialInstanceListSchema]);

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
 * unchecked `as`, and two of them needed no cast at all — every member of
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
    bazarr: For<'bazarr', Instanced<KeyedServiceConfig>>;
    prowlarr: For<'prowlarr', Instanced<KeyedServiceConfig>>;
    sabnzbd: For<'sabnzbd', Instanced<KeyedServiceConfig>>;
    jellyfin: For<'jellyfin', MultiUserServiceConfig>;
    seerr: For<'seerr', MultiUserServiceConfig>;
    plex: For<'plex', PlexServiceConfig>;
    transmission: For<'transmission', Instanced<CredentialServiceConfig>>;
    qbittorrent: For<'qbittorrent', Instanced<CredentialServiceConfig>>;
    profilarr: For<'profilarr', KeyedServiceConfig>;
};

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
                message: `only ${MULTI_INSTANCE.join(', ')} can be a list of instances. Give this service a single block`
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
        // Single only: V2 and Eros are separate service ids, so the one
        // deployment that would want two Whisparrs is already two keys.
        whisparr: singleOnly(KeyedServiceSchema).optional(),
        bazarr: MultiInstanceServiceSchema.optional(),
        prowlarr: MultiInstanceServiceSchema.optional(),
        sabnzbd: MultiInstanceServiceSchema.optional(),
        jellyfin: singleOnly(MultiUserServiceSchema).optional(),
        seerr: singleOnly(MultiUserServiceSchema).optional(),
        transmission: MultiInstanceCredentialSchema.optional(),
        qbittorrent: MultiInstanceCredentialSchema.optional(),
        plex: singleOnly(PlexServiceSchema).optional(),
        // Single only: Profilarr is the one place that owns profile config,
        // so two of them would mean two sources of truth.
        profilarr: singleOnly(KeyedServiceSchema).optional()
    })
    .superRefine((services, ctx) => {
        /**
         * Jellyfin and Seerr issue one admin-scoped key that can answer for
         * anybody, which is what `allow_other_users` governs. A Plex
         * `X-Plex-Token` is scoped to a single account — `PlexAdapter` never
         * reads this flag and always reports account 1 as the only user — so
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
    // read-scoped token as carrying every tier — the one failure this whole
    // block exists to refuse.
    .refine(value => new Set([value.read, value.write, value.destructive]).size === 3, {
        message: 'must name three distinct scopes'
    });

/**
 * HTTPS, or `http:` on a loopback host for testing against a local provider.
 * Protocol and host are checked together — checking them as two independent
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
     * and throws when it is broken — refusing here means a bad issuer is a
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

export const MIN_PLAINTEXT_TOKEN = 32;

const McpTokenSchema = z.strictObject({
    name: InstanceNameSchema,
    tier: z.enum(['read', 'write', 'destructive']),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'hash must be sha256:<64 hex>').optional(),
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

/** Hash only: unlike MCP tokens there is no plaintext form to hand-write. */
const ManagementKeySchema = z.strictObject({
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'hash must be sha256:<64 hex>'),
    created: z.iso.date()
});

/**
 * Named, rather than inlined into `ConfigSchema`, so `load.ts`'s salvage path
 * can parse against it directly. `ConfigSchema`'s `auth` field is this same
 * object with the oauth/allow_token_in_url refinement chained on — but the
 * salvage parse runs precisely when the rest of the file is already broken,
 * and wants the *unrefined* object: a cross-field check there would only make
 * salvage fail for a combination that has nothing to do with why the file
 * doesn't load.
 */
export const AuthSchema = z.strictObject({
    /** Pre-1.34 single token. Normalised into a `default` entry on parse. */
    bearer_token: z.string().length(64).optional(),
    tokens: z.array(McpTokenSchema).optional(),
    /** Who logs into the config UI. Defaulted rather than generated —
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
    oauth: OAuthSchema.optional(),
    /** The management API's key. Absent means the API is off. */
    management_key: ManagementKeySchema.optional()
});

export const MediaServerIdSchema = z.enum(['jellyfin', 'plex']);
export type MediaServerId = z.infer<typeof MediaServerIdSchema>;

export const ConfigSchema = z.object({
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
        })
        .transform(({ bearer_token, tokens, ...rest }) => ({
            ...rest,
            tokens: [
                ...(bearer_token === undefined ? [] : [{ name: 'default', tier: 'destructive' as const, hash: hashToken(bearer_token) }]),
                ...(tokens ?? []).map(({ token, hash, ...t }: RawToken) => ({ ...t, hash: hash ?? hashToken(token as string) }))
            ]
        })),
    services: ServicesSchema,
    /** Which media server the tools default to. Required when both are configured. */
    primary_media_server: MediaServerIdSchema.optional(),
    /** Absent means off, exactly like a service nobody configured. */
    metadata: MetadataSchema.optional(),
    /** Absent means `system`, so a config nobody touched stays as clean as it
     *  started — the same reasoning as `metadata`. */
    ui: UiSchema.optional()
}).superRefine((config, ctx) => {
    // `jellyfin` and `plex` are distinct, individually valid keys, so the two
    // together are admitted, and this rule says which one the tools default to.
    // Refused rather than guessed: a silent default would send a Plex question
    // to Jellyfin, or the reverse.
    const configured = MediaServerIdSchema.options.filter(id => config.services[id] !== undefined);
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
