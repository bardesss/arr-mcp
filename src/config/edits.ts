import { ConfigEditError } from './mutate.ts';
import type { Config } from './schema.ts';
import { generateManagementKey } from '../core/managementKey.ts';
import { hashToken } from '../core/mcpTokens.ts';

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
    opts: { allowedHosts?: readonly string[]; allowTokenInUrl?: boolean }
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

    return { ...config, auth: { ...config.auth, allow_token_in_url: urlToken, allowed_hosts: hosts } };
}

/** Generating again replaces the old key, which stops working on the next request. */
export function setManagementKey(config: Config, now: Date): { config: Config; plaintext: string } {
    const plaintext = generateManagementKey();
    const management_key = { hash: hashToken(plaintext), created: now.toISOString().slice(0, 10) };
    return { config: { ...config, auth: { ...config.auth, management_key } }, plaintext };
}

export function clearManagementKey(config: Config): Config {
    const { management_key: _dropped, ...auth } = config.auth;
    return { ...config, auth };
}
