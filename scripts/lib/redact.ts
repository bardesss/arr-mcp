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

/** A plain JSON object — the shape every per-endpoint anonymiser in
 *  capture-fixtures.ts works with. */
export type Row = Record<string, unknown>;

/** Keeps a field present and typed, but replaces a string value. Checks
 *  `typeof`, not truthiness, so an empty string is replaced too — Plex's
 *  `/accounts` can return rows with `name: ''`. */
export function replaceIfString(value: unknown, replacement: string): unknown {
    return typeof value === 'string' ? replacement : value;
}

type MetadataContainer = { MediaContainer?: { Metadata?: Row[] } };

/**
 * A Plex session row carries who is watching (`User.title`, a username, and
 * `User.thumb`, whose URL can embed an account id) and where from
 * (`Player.remotePublicAddress`, the viewer's public IP — outside what the
 * private-IP regex in `redact()` reaches, since a public address is by
 * definition not in one of the private ranges it matches). `User.id` is left
 * alone: the adapter resolves the current session by matching on it.
 */
export function redactPlexSessions(body: unknown): unknown {
    const container = (body as MetadataContainer).MediaContainer;
    if (!Array.isArray(container?.Metadata)) return body;
    return {
        ...(body as Row),
        MediaContainer: {
            ...container,
            Metadata: container.Metadata.map(m => {
                const player = m.Player as Row | undefined;
                const user = m.User as Row | undefined;
                return {
                    ...m,
                    ...(player === undefined || !('remotePublicAddress' in player)
                        ? {}
                        : { Player: { ...player, remotePublicAddress: replaceIfString(player.remotePublicAddress, '203.0.113.10') } }),
                    ...(user === undefined
                        ? {}
                        : {
                              User: {
                                  ...user,
                                  ...('title' in user ? { title: replaceIfString(user.title, 'viewer') } : {}),
                                  ...('thumb' in user ? { thumb: replaceIfString(user.thumb, '') } : {})
                              }
                          })
                };
            })
        }
    };
}

/**
 * Resume position, watch/play counts, last-watched time and per-show
 * episode progress — the Plex analogue of `neutraliseWatchState` in
 * capture-fixtures.ts, for the shapes that carry it: `onDeck`, `history`,
 * and any per-user library listing (`PlexAdapter#paged`, so `section-all`
 * and `metadata-detail` too — Plex embeds the requesting account's view
 * state in library rows, not only in the dedicated history endpoints).
 *
 * Unlike Jellyfin, the adapter reads all four fields directly
 * (`isResume`, `#watched`, `get_watch_history`), so each is kept present and
 * typed with a deterministic alternating value rather than stripped — a
 * fixture where nothing is ever watched would stop exercising half the
 * adapter's branches. `accountID` is left alone, same reason as `User.id`
 * above: it is what history filtering matches on.
 *
 * `viewedAt` and `deviceID` are handled unconditionally alongside the fields
 * above even though only `history` rows are documented to carry them: which
 * spelling (`viewedAt` vs `lastViewedAt`) a live server actually sends is
 * unconfirmed, and guessing wrong means a real timestamp reaches a public
 * fixture. Checking both costs nothing on the shapes that have neither.
 */
export function neutralisePlexWatchState(body: unknown): unknown {
    const container = (body as MetadataContainer).MediaContainer;
    if (!Array.isArray(container?.Metadata)) return body;
    return {
        ...(body as Row),
        MediaContainer: {
            ...container,
            Metadata: container.Metadata.map((item, i) => {
                const watched = i % 2 === 0;
                const leafCount = typeof item.leafCount === 'number' ? item.leafCount : 1;
                return {
                    ...item,
                    ...('viewOffset' in item ? { viewOffset: watched ? 0 : 120_000 } : {}),
                    ...('viewCount' in item ? { viewCount: watched ? 1 : 0 } : {}),
                    ...('lastViewedAt' in item ? { lastViewedAt: 1_700_000_000 + i } : {}),
                    ...('viewedAt' in item ? { viewedAt: 1_700_000_000 + i } : {}),
                    ...('viewedLeafCount' in item ? { viewedLeafCount: watched ? leafCount : 0 } : {}),
                    ...('deviceID' in item ? { deviceID: `fixture-device-${i}` } : {})
                };
            })
        }
    };
}

/** Deterministic per-row placeholder, so re-running capture on an unchanged
 *  shape produces an unchanged fixture rather than a spurious diff. */
const syntheticDisplayValue = (label: string, i: number): string => `Fixture ${label} ${i + 1}`;

/**
 * `/status/sessions/history/all` and `/library/onDeck` are records, not
 * listings: a row exists only because someone watched, or is watching, that
 * title. `neutralisePlexWatchState` neutralises the numbers but leaves the
 * real title standing next to a fake timestamp — still the tester's complete
 * viewing record. This additionally severs the row from what it names:
 * display strings become deterministic placeholders and thumb/art/key-style
 * fields (which can carry a real slug) are blanked. Keys and types are
 * preserved throughout, so the fixture still proves the adapter parses the
 * shape.
 *
 * Deliberately not applied to `section-all`, `search` or `metadata-detail` —
 * those are library listings, where every title appears whether or not
 * anyone watched it, so a title there is not evidence of anything.
 */
export function anonymisePlexHistory(body: unknown): unknown {
    const neutralised = neutralisePlexWatchState(body) as MetadataContainer;
    const container = neutralised.MediaContainer;
    if (!Array.isArray(container?.Metadata)) return neutralised;
    return {
        ...(neutralised as Row),
        MediaContainer: {
            ...container,
            Metadata: container.Metadata.map((item, i) => ({
                ...item,
                ...('title' in item ? { title: syntheticDisplayValue('Title', i) } : {}),
                ...('grandparentTitle' in item ? { grandparentTitle: syntheticDisplayValue('Series', i) } : {}),
                ...('parentTitle' in item ? { parentTitle: syntheticDisplayValue('Season', i) } : {}),
                ...('originalTitle' in item ? { originalTitle: syntheticDisplayValue('Original Title', i) } : {}),
                ...('thumb' in item ? { thumb: replaceIfString(item.thumb, '') } : {}),
                ...('art' in item ? { art: replaceIfString(item.art, '') } : {}),
                ...('key' in item ? { key: replaceIfString(item.key, '') } : {}),
                ...('parentThumb' in item ? { parentThumb: replaceIfString(item.parentThumb, '') } : {}),
                ...('grandparentThumb' in item ? { grandparentThumb: replaceIfString(item.grandparentThumb, '') } : {}),
                ...('grandparentKey' in item ? { grandparentKey: replaceIfString(item.grandparentKey, '') } : {}),
                ...('parentKey' in item ? { parentKey: replaceIfString(item.parentKey, '') } : {})
            }))
        }
    };
}
