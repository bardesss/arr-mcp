import { instanceId, listInstances, type ServiceInstance } from '../config/instances.ts';
import { configuredMediaServers } from '../config/edits.ts';
import { MULTI_USER, NO_API_KEY } from '../config/mutate.ts';
import { ServiceIdSchema, type Config, type ServiceId } from '../config/schema.ts';
import { fingerprint, isExpired } from '../core/mcpTokens.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import { withoutCredentials } from '../tools/stackHealth.ts';

/** Secrets appear only as `…Set` booleans. */
export type AppResource = {
    id: string;
    type: ServiceId;
    name: string | null;
    url: string;
    timeoutMs: number;
    safeWrite: boolean;
    destructive: boolean;
    apiKeySet?: boolean;
    username?: string | null;
    passwordSet?: boolean;
    defaultUser?: string | null;
    allowOtherUsers?: boolean;
    allowMetadataRepair?: boolean;
};

type Loose = {
    url: string;
    timeout_ms: number;
    permissions: { safe_write: boolean; destructive: boolean };
    api_key?: string;
    username?: string;
    password?: string;
    default_user?: string;
    allow_other_users?: boolean;
    allow_metadata_repair?: boolean;
};

export function appResource(instance: ServiceInstance): AppResource {
    const c = instance.config as Loose;
    const base = {
        id: instance.id,
        type: instance.type,
        name: instance.name ?? null,
        url: withoutCredentials(c.url),
        timeoutMs: c.timeout_ms,
        safeWrite: c.permissions.safe_write,
        destructive: c.permissions.destructive
    };
    if (NO_API_KEY.has(instance.type)) {
        return { ...base, username: c.username ?? null, passwordSet: (c.password ?? '') !== '' };
    }
    return {
        ...base,
        apiKeySet: (c.api_key ?? '') !== '',
        ...(MULTI_USER.has(instance.type)
            ? { defaultUser: c.default_user ?? null, allowOtherUsers: c.allow_other_users ?? false }
            : {}),
        ...(instance.type === 'plex' ? { allowMetadataRepair: c.allow_metadata_repair ?? false } : {})
    };
}

export function findInstance(config: Config, type: string, name: string | undefined): ServiceInstance | undefined {
    const parsed = ServiceIdSchema.safeParse(type);
    if (!parsed.success) return undefined;
    const id = instanceId(parsed.data, name);
    return listInstances(config).find(i => i.id === id);
}

export const mcpSettings = (config: Config) => ({
    allowedHosts: config.auth.allowed_hosts,
    allowTokenInUrl: config.auth.allow_token_in_url,
    oauthConfigured: config.auth.oauth !== undefined
});

/** `primary` is the server the tools default to, so a lone server is primary too. */
export function mediaServerSettings(config: Config) {
    const configured = configuredMediaServers(config);
    return { primary: config.primary_media_server ?? configured[0] ?? null, configured };
}

export function imdbSettings(config: Config, dataset: ImdbDataset | undefined) {
    const status = dataset?.status();
    return {
        enabled: config.metadata?.imdb?.enabled === true,
        ingestedAt: status?.ingestedAt ?? null,
        titles: status?.titles ?? null,
        ratings: status?.ratings ?? null
    };
}

export const tokenResources = (config: Config, plaintextOnDisk: readonly string[], now: Date) =>
    config.auth.tokens.map(t => ({
        name: t.name,
        tier: t.tier,
        expires: t.expires ?? null,
        fingerprint: fingerprint(t.hash),
        expired: isExpired(t.expires, now),
        plaintextOnDisk: plaintextOnDisk.includes(t.name)
    }));
