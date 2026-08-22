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

export const REDACTED = '__REDACTED__';
export const ANONYMOUS_HOST = 'service.example.test';

/**
 * `session[-_]id` is not a credential — Transmission hands one to any client
 * that asks, and that handshake is the whole point. It is redacted anyway for
 * two reasons: it rotates, so leaving it in produces a spurious diff on every
 * recapture, and it looks exactly like a secret to anyone reading the fixture.
 * The adapter reads the session id from the response *header*, never the body,
 * so nothing depends on the recorded value.
 */
export const SECRET_KEY =
    /^(api_?key|apikey|token|access_?token|auth_?token|password|passwd|secret|nzb_?key|session[-_]?id)$/i;

/**
 * Private and loopback IPv4 literals, for addresses a service reports about
 * *itself* rather than ones we configured. Restricted to RFC1918, loopback and
 * link-local on purpose: a blanket IPv4 pattern would rewrite version strings,
 * and scoping it to ranges that cannot be a version number keeps that
 * impossible. Replaced with TEST-NET-1, reserved for documentation.
 */
export const PRIVATE_IPV4 =
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

/** Secrets by exact value, configured hosts by exact value, then private IPv4
 *  literals by shape — recursively, so a nested credential cannot survive. */
export function redact(node: unknown, secrets: string[], hosts: string[]): unknown {
    if (typeof node === 'string') {
        const withoutSecrets = secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), node);
        const withoutHosts = hosts.reduce((acc, host) => acc.split(host).join(ANONYMOUS_HOST), withoutSecrets);
        return withoutHosts.replace(PRIVATE_IPV4, '192.0.2.10');
    }
    if (Array.isArray(node)) return node.map(v => redact(v, secrets, hosts));
    if (node !== null && typeof node === 'object') {
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [
                key,
                SECRET_KEY.test(key) && value !== null && value !== '' ? REDACTED : redact(value, secrets, hosts)
            ])
        );
    }
    return node;
}
