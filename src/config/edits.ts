import { ConfigEditError } from './mutate.ts';
import type { Config } from './schema.ts';

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
            'OAuth is configured, so the token cannot travel in the URL — a JWT in the address reaches every proxy log. Remove it on the OAuth card first.'
        );
    }
    const hosts =
        opts.allowedHosts === undefined
            ? config.auth.allowed_hosts
            : opts.allowedHosts.map(h => h.trim()).filter(h => h !== '');

    return { ...config, auth: { ...config.auth, allow_token_in_url: urlToken, allowed_hosts: hosts } };
}
