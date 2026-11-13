import { ConfigEditError } from './mutate.ts';
import { ConfigSchema, MediaServerIdSchema, mediaServersIn, type Config, type MediaServerId } from './schema.ts';
import { generateManagementKey, type ManagementKeyTier } from '../core/managementKey.ts';
import { hashToken } from '../core/secrets.ts';

/**
 * Settings edits shared by the config UI and the management API. Each owns its
 * fields and carries every other one forward.
 */

/** Off drops the block, so an untouched config stays clean. */
export function setImdb(config: Config, enabled: boolean): Config {
    const { metadata: _dropped, ...rest } = config;
    return { ...rest, ...(enabled ? { metadata: { imdb: { enabled: true } } } : {}) };
}

/** An omitted field is left as it is. */
export function setMcpEndpoint(
    config: Config,
    opts: { allowedHosts?: readonly string[]; allowTokenInUrl?: boolean; trustedProxies?: readonly string[] }
): Config {
    const urlToken = opts.allowTokenInUrl ?? config.auth.allow_token_in_url;
    // The schema refuses this too, but as a union error nobody can read.
    if (urlToken && config.auth.oauth !== undefined) {
        throw new ConfigEditError(
            'OAuth is configured, so the token cannot travel in the URL: a JWT in the address reaches every proxy log. Remove it on the OAuth card first.'
        );
    }
    const hosts =
        opts.allowedHosts === undefined
            ? config.auth.allowed_hosts
            : opts.allowedHosts.map(h => h.trim()).filter(h => h !== '');

    // Empty drops the key, so a config that never used it stays as it was.
    const proxies =
        opts.trustedProxies === undefined
            ? config.auth.trusted_proxies
            : opts.trustedProxies.map(p => p.trim()).filter(p => p !== '');
    const { trusted_proxies: _dropped, ...auth } = config.auth;

    return {
        ...config,
        auth: {
            ...auth,
            allow_token_in_url: urlToken,
            allowed_hosts: hosts,
            ...(proxies === undefined || proxies.length === 0 ? {} : { trusted_proxies: proxies })
        }
    };
}

export function addManagementKey(
    config: Config,
    opts: { name: string; tier: ManagementKeyTier },
    now: Date
): { config: Config; plaintext: string } {
    const existing = config.auth.management_keys ?? [];
    if (existing.some(k => k.name.toLowerCase() === opts.name.toLowerCase())) {
        throw new ConfigEditError(`There is already a key named "${opts.name}".`);
    }
    const plaintext = generateManagementKey();
    const key = { ...opts, hash: hashToken(plaintext), created: now.toISOString().slice(0, 10) };
    const parsed = ConfigSchema.safeParse({ ...config, auth: { ...config.auth, management_keys: [...existing, key] } });
    if (!parsed.success) {
        throw new ConfigEditError('Key names must be letters, digits, dashes or underscores, starting with one.');
    }
    return { config: parsed.data, plaintext };
}

/** Names are unique regardless of case, so this matches that way too. Revoking the last key turns the API off. */
export function revokeManagementKey(config: Config, name: string): Config {
    const { management_keys: existing = [], ...auth } = config.auth;
    const same = (k: { name: string }) => k.name.toLowerCase() === name.toLowerCase();
    if (!existing.some(same)) throw new ConfigEditError(`No key named "${name}".`);
    const left = existing.filter(k => !same(k));
    return { ...config, auth: { ...auth, ...(left.length === 0 ? {} : { management_keys: left }) } };
}

export const configuredMediaServers = (config: Config): MediaServerId[] => mediaServersIn(config.services);

/** Only meaningful with both configured; with one, naming that one is a no-op. */
export function setPrimaryMediaServer(config: Config, primary: string): Config {
    const parsed = MediaServerIdSchema.safeParse(primary);
    if (!parsed.success) throw new ConfigEditError('Pick jellyfin or plex as the primary media server.');
    const configured = configuredMediaServers(config);
    if (!configured.includes(parsed.data)) throw new ConfigEditError(`${parsed.data} is not configured.`);
    if (configured.length < 2) return config;
    return { ...config, primary_media_server: parsed.data };
}
