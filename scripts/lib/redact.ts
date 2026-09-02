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

/** Replaces every configured host with a placeholder, wherever it appears in `text`.
 *  Stays a blind substring replace on purpose: this feeds terminal error text
 *  (`classifyFetchError`'s messages), which embeds a bare `host:port` with no
 *  scheme to anchor on — the authority-position fix below doesn't apply here,
 *  and these fixed-template strings don't carry a `plex://`-style guid to
 *  collide with. */
export function redactHosts(text: string, hosts: readonly string[]): string {
    return hosts.reduce((acc, host) => acc.split(host).join(PLACEHOLDER), text);
}

/** Escapes regex metacharacters, so an unescaped host like `192.168.7.37`
 *  cannot also match a look-alike such as `192a168x7y37`. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts a configured host only in authority position — immediately after a
 * scheme's `//` or an embedded-credential `@` — never as a bare substring
 * anywhere in the text.
 *
 * The previous approach (`text.split(host).join(placeholder)`, same shape as
 * `redactHosts` above) is a blind substring replace, and a host named `plex`
 * — the common Docker service name — collided with two very different
 * things: a `plex://<guid>` URI, whose scheme merely spells the same word,
 * and any brand name containing "plex" (`Aniplex`). Measured on the tester's
 * server: 500 guids corrupted, `Aniplex` became `Aniservice.example.test`.
 * `\b` alone cannot fix the scheme case — `plex` in `plex://movie` sits
 * between two word boundaries the same as a real host would, since `:` is
 * already non-word — so the anchor is authority position, not a word edge.
 *
 * VCR has had the identical bug open since 2012 (vcr/vcr#204: filtering the
 * username `admin` mangled `administrator`) and stays a substring replace
 * because its filtering must round-trip on playback. This is a record-only
 * scrubber that never un-substitutes, so that constraint doesn't apply here.
 *
 * Known gap, deliberately not closed: a bare authority with no scheme (a
 * `Host: plex:32400` header, a percent-encoded nested URL) has no `//`/`@`
 * to anchor on and passes through unredacted. Azure's test-proxy closes this
 * with a separate header-scoped sanitiser; nothing here reaches for that.
 */
function redactAuthorities(text: string, hosts: readonly string[], placeholder: string): string {
    if (hosts.length === 0) return text;
    const alternation = hosts.map(escapeRegExp).join('|');
    const re = new RegExp(`(?<=\\/\\/|@)(?:${alternation})\\.?(?=[:/?#"'\\s]|$)`, 'gi');
    return text.replace(re, placeholder);
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

/**
 * Unique-local (`fc00::/7`), link-local (`fe80::/10`) and loopback (`::1`)
 * IPv6 literals — the same class of "who and where" a service can report
 * about itself as `PRIVATE_IPV4` catches, unproven against a live server (no
 * IPv6 was seen in the tester's captures) but cheap to cover regardless. A
 * global unicast address (`2001:...`) is left alone, same as a public IPv4.
 *
 * `\b` doesn't fire on a `:`-`:` or `"`-`:` boundary (both non-word), so the
 * match is anchored with lookaround instead of `\b` at the leading edge.
 *
 * `fe[89ab][0-9a-fA-F]` is the first hextet's actual range for a /10 —
 * `fe80` through `febf` — not the single literal `fe80`; `fe81`, `fe90`,
 * `fea0` and `febf` are all in range and were previously missed.
 *
 * The tail (`(?::[0-9a-fA-F]{0,4}){1,7}`) allows a zero-length hextet, so
 * `fc00:` or `fd00:::` also match. Harmless for redaction — a token that
 * isn't a well-formed address just gets rewritten too — but this is a token
 * matcher, not a validator, on purpose: rejecting malformed input isn't the
 * job here.
 */
export const PRIVATE_IPV6 =
    /(?<![0-9a-fA-F:])(?:::1|(?:fe[89ab][0-9a-fA-F]|f[cd][0-9a-fA-F]{2})(?::[0-9a-fA-F]{0,4}){1,7})(?![0-9a-fA-F:])/gi;

/** Secrets by exact value, configured hosts by authority position, then
 *  private IPv4 literals by shape — recursively, so a nested credential
 *  cannot survive. */
export function redact(node: unknown, secrets: string[], hosts: string[]): unknown {
    if (typeof node === 'string') {
        const withoutSecrets = secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), node);
        const withoutHosts = redactAuthorities(withoutSecrets, hosts, ANONYMOUS_HOST);
        return withoutHosts.replace(PRIVATE_IPV4, '192.0.2.10').replace(PRIVATE_IPV6, '2001:db8::a');
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
 * Maps a real Plex account id to a synthetic one, stable for the lifetime of
 * one capture run — the same real id always returns the same synthetic id,
 * so an account still joins across `accounts` (`Account.id`), `sessions`
 * (`User.id`) and `history` (`accountID`), the three separate captures that
 * each carry it in a different field.
 *
 * The owner is always id 1 by Plex's own convention (`OWNER_ACCOUNT_ID` in
 * plex.ts) and stays 1: `PlexAdapter#listUsers`'s owner lookup matches on it
 * exactly, and "the owner is account 1" identifies nobody. See G2.
 *
 * Synthetic ids count down from -1 rather than up from 1001. Counting up
 * from a fixed offset meant the nth distinct non-owner id survived
 * unchanged whenever its real value was exactly 1000 + n — e.g. a first id
 * claims synthetic 1001, then a real second id of 1002 collides with its own
 * synthetic. Plex account ids are always positive, so negative synthetics
 * can never collide with a real one, fixed by construction rather than by
 * picking a less-likely offset. See N1.
 */
export function createAccountIdMapper(): (id: number) => number {
    const seen = new Map<number, number>();
    let next = -1;
    return (id: number): number => {
        if (id === 1) return 1;
        const existing = seen.get(id);
        if (existing !== undefined) return existing;
        const synthetic = next;
        next -= 1;
        seen.set(id, synthetic);
        return synthetic;
    };
}

/** A Plex account/session id as XML-derived JSON sends it — string or
 *  number depending on the row — mapped through `mapId` while preserving
 *  whichever shape it arrived in.
 *
 *  `Number()` has no safe-integer check, so two distinct digit strings above
 *  `Number.MAX_SAFE_INTEGER` would collapse onto one synthetic id. Left as
 *  is: no evidence a live Plex account id is that large, and guarding it
 *  would mean deciding what an oversized id should map to instead. See N3. */
function mappedId(value: unknown, mapId: (id: number) => number): unknown {
    if (typeof value === 'number') return mapId(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return String(mapId(Number(value.trim())));
    return value;
}

/**
 * A Plex session row carries who is watching (`User.title`, a username, and
 * `User.thumb`, whose URL can embed an account id) and where from
 * (`Player.remotePublicAddress`, the viewer's public IP — outside what the
 * private-IP regex in `redact()` reaches, since a public address is by
 * definition not in one of the private ranges it matches). `User.id` is left
 * present — the adapter resolves the current session by matching on it —
 * but its value is remapped through `mapId` when one is given, so a real
 * plex.tv account id doesn't survive next to a scrubbed `User.title`. See G2.
 */
export function redactPlexSessions(body: unknown, mapId?: (id: number) => number): unknown {
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
                                  ...('thumb' in user ? { thumb: replaceIfString(user.thumb, '') } : {}),
                                  ...(mapId !== undefined && 'id' in user ? { id: mappedId(user.id, mapId) } : {})
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

/** Cast/crew containers whose `tag` (a person's name) and `thumb` (their
 *  avatar) are personal data — unlike `Genre`/`Country`/`Collection`/`Label`,
 *  which are taxonomy and stay untouched. */
const PERSON_ARRAY_KEYS = new Set(['Role', 'Director', 'Writer', 'Producer']);

/** Free-text fields that name the exact title, series or place, wherever
 *  they occur — replaced with a deterministic per-occurrence placeholder. */
const IDENTIFYING_TEXT_KEYS = new Set([
    'title',
    'grandparentTitle',
    'parentTitle',
    'originalTitle',
    'titleSort',
    'summary',
    'tagline',
    'studio'
]);

/** Slug/URL/on-disk-path fields that can carry a real identifier, wherever
 *  they occur — blanked, same treatment already given to top-level `thumb`. */
const IDENTIFYING_SLUG_KEYS = new Set([
    'thumb',
    'art',
    'key',
    'parentThumb',
    'grandparentThumb',
    'grandparentKey',
    'parentKey',
    'grandparentArt',
    'grandparentTheme',
    'grandparentSlug',
    'slug',
    'file'
]);

/**
 * Recursively scrubs identifying data anywhere in a Plex metadata row, not
 * only at its top level. Plex nests the same kind of title/person/path data
 * inside `Media`/`Part`/`Role`/`Director`/`Writer`/`Producer`/`Guid`/`Image`
 * as often as it puts it at the row's own level — `Media[0].Part[0].file` is
 * the one that matters most, since a file path routinely encodes series,
 * season, episode title and release group in one string — so this walks the
 * whole row instead of naming each field once, which drifts the moment Plex
 * adds a nested one. Keys, array lengths and value types are preserved
 * throughout, so a fixture built from this still exercises the adapter's
 * parsing.
 *
 * `counter` threads through the whole walk (not reset per key) so two
 * occurrences of the same field name in one row still get distinguishable
 * placeholders.
 */
function anonymiseNested(node: unknown, counter: { n: number }, parentKey?: string): unknown {
    if (Array.isArray(node)) return node.map(v => anonymiseNested(v, counter, parentKey));
    if (node === null || typeof node !== 'object') return node;

    const isPersonEntry = parentKey !== undefined && PERSON_ARRAY_KEYS.has(parentKey);
    return Object.fromEntries(
        Object.entries(node as Row).map(([key, value]): [string, unknown] => {
            if (isPersonEntry && key === 'tag') return [key, replaceIfString(value, syntheticDisplayValue('Person', counter.n++))];
            if (isPersonEntry && key === 'thumb') return [key, replaceIfString(value, '')];
            // Guid.id is a scheme-prefixed external id (imdb://tt123, tmdb://456) —
            // the scheme is kept so the shape still proves externalIds() parses it,
            // only the id half (which names the exact title) is synthetic.
            if (key === 'Guid' && Array.isArray(value)) {
                return [
                    key,
                    value.map(g => {
                        const row = g as Row;
                        const match = typeof row.id === 'string' ? /^([a-z]+):\/\//i.exec(row.id) : null;
                        return match === null ? row : { ...row, id: `${match[1]}://fixture-${counter.n++}` };
                    })
                ];
            }
            if (IDENTIFYING_TEXT_KEYS.has(key)) return [key, replaceIfString(value, syntheticDisplayValue(key, counter.n++))];
            if (IDENTIFYING_SLUG_KEYS.has(key)) return [key, replaceIfString(value, '')];
            return [key, anonymiseNested(value, counter, key)];
        })
    );
}

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
 *
 * `accountID` is kept present — `PlexAdapter#getWatchHistory` filters on it —
 * but its value is remapped through `mapId` when one is given, the same
 * reasoning as `redactPlexSessions`'s `User.id`. See G2.
 *
 * The per-field scrubbing itself is `anonymiseNested` (above) — a recursive
 * walk rather than a list of top-level key names, so a title/person/path
 * value nested inside `Media`/`Part`/`Role`/`Director`/`Writer`/`Producer`/
 * `Guid` is reached the same as one sitting directly on the row. See B2.
 */
export function anonymisePlexHistory(body: unknown, mapId?: (id: number) => number): unknown {
    const neutralised = neutralisePlexWatchState(body) as MetadataContainer;
    const container = neutralised.MediaContainer;
    if (!Array.isArray(container?.Metadata)) return neutralised;
    return {
        ...(neutralised as Row),
        MediaContainer: {
            ...container,
            Metadata: container.Metadata.map(item => {
                const scrubbed = anonymiseNested(item, { n: 0 }) as Row;
                return {
                    ...scrubbed,
                    ...(mapId !== undefined && 'accountID' in item ? { accountID: mappedId(item.accountID, mapId) } : {})
                };
            })
        }
    };
}

/**
 * The token owner's account name — the same identity as Jellyfin's `users`
 * capture, anonymised for the same reason. `id` is present on every row and
 * is what `PlexAdapter#listUsers` matches the owner on, so it stays present
 * too, but its value is remapped through `mapId`: the tester's live
 * `/accounts` carried real plex.tv account ids on rows whose `name` this
 * already scrubbed. See G2.
 */
export function anonymisePlexAccounts(body: unknown, mapId: (id: number) => number): unknown {
    const container = (body as { MediaContainer?: { Account?: Row[] } }).MediaContainer;
    if (!Array.isArray(container?.Account)) return body;
    return {
        ...(body as Row),
        MediaContainer: {
            ...container,
            Account: container.Account.map((a, i) => ({
                ...a,
                name: replaceIfString(a.name, `Account ${i + 1}`),
                // mappedId, not a bare `typeof a.id === 'number'` check: the
                // tester's ids were all JSON numbers, but `User.id`/`accountID`
                // elsewhere already accept a numeric string too, and a stricter
                // check here was the one place a string-valued id would have
                // survived unmapped. See N4.
                ...('id' in a ? { id: mappedId(a.id, mapId) } : {})
            }))
        }
    };
}
