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
import type { Config } from '../../src/config/schema.ts';

const PLACEHOLDER = '<configured-host>';

/**
 * Every host the user configured — hostname and host:port both, longest
 * first so `10.0.0.1:7878` is replaced before the bare `10.0.0.1` inside it.
 */
export function hostsOf(config: Config): string[] {
    const out = new Set<string>();
    for (const service of Object.values(config.services)) {
        if (service === undefined) continue;
        try {
            const url = new URL((service as { url: string }).url);
            out.add(url.host);
            out.add(url.hostname);
        } catch {
            // A url that does not parse cannot appear in a message either.
        }
    }
    return [...out].sort((a, b) => b.length - a.length);
}

/** Replaces every configured host with a placeholder, wherever it appears in `text`. */
export function redactHosts(text: string, hosts: readonly string[]): string {
    return hosts.reduce((acc, host) => acc.split(host).join(PLACEHOLDER), text);
}
