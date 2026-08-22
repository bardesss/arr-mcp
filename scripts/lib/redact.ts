/**
 * Host redaction shared by the maintainer scripts that print a live error
 * message to the terminal (`capture-fixtures.ts`, `integration.ts`).
 *
 * `classifyFetchError` (`src/core/errors.ts`) deliberately embeds the
 * configured host in `ServiceError.message` for the Timeout/Unreachable
 * cases — the right choice for a model reading a tool result, which needs to
 * know *where* the connection failed. It is the wrong choice for these
 * scripts' own, stricter promise never to print a service URL to a
 * maintainer's terminal, so any raw error text they print is passed through
 * `redactHosts` first.
 */
import { listInstances } from '../../src/config/instances.ts';
import type { Config } from '../../src/config/schema.ts';

const PLACEHOLDER = '<configured-host>';

/**
 * Every host the user configured — hostname and host:port both, longest
 * first so `10.0.0.1:7878` is replaced before the bare `10.0.0.1` inside it.
 *
 * Through `listInstances` because bazarr, radarr and sonarr may each be a list
 * of named instances: reading `.url` off the raw value skipped every one of
 * them, and the catch below hid that it had.
 */
export function hostsOf(config: Config): string[] {
    const out = new Set<string>();
    for (const instance of listInstances(config)) {
        try {
            const url = new URL(instance.config.url);
            out.add(url.host);
            out.add(url.hostname);
        } catch {
            // A url that does not parse cannot appear in a message either.
        }
    }
    return [...out].sort((a, b) => b.length - a.length);
}

/** Every configured credential, so a post-write scan can look for them exactly. */
export function secretsOf(config: Config): string[] {
    const out: string[] = [];
    for (const instance of listInstances(config)) {
        const service = instance.config as { api_key?: string; password?: string };
        if (service.api_key) out.push(service.api_key);
        if (service.password) out.push(service.password);
    }
    return out;
}

/** Replaces every configured host with a placeholder, wherever it appears in `text`. */
export function redactHosts(text: string, hosts: readonly string[]): string {
    return hosts.reduce((acc, host) => acc.split(host).join(PLACEHOLDER), text);
}
