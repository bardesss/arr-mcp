/**
 * Captures real API responses into test/fixtures/ so CI needs no live media
 * stack (design spec §17). Run by the maintainer, never in CI.
 *
 *   npm run capture                        # reads ./config/config.yaml
 *   ARR_MCP_CAPTURE_CONFIG=/path npm run capture
 *
 * Credentials are read from the config file and never printed. Redaction is
 * secrets-only by decision (Phase 2 design §7): real titles, usernames, LAN
 * addresses and mount paths are published.
 */
import { listInstances } from '../src/config/instances.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.ts';
import type { Config, ServiceId } from '../src/config/schema.ts';
import {
    apiKeyHeader,
    embyToken,
    qbittorrentSession,
    queryParamKey,
    transmissionRpc,
    type AuthStrategy
} from '../src/core/auth.ts';
import { ServiceHttp } from '../src/core/http.ts';
import { hostsOf, redactHosts } from './lib/redact.ts';

const REDACTED = '__REDACTED__';

/**
 * `session[-_]id` is not a credential — Transmission hands one to any client
 * that asks, and that handshake is the whole point. It is redacted anyway for
 * two reasons: it rotates, so leaving it in produces a spurious diff on every
 * recapture, and it looks exactly like a secret to anyone reading the fixture.
 * The adapter reads the session id from the response *header*, never the body,
 * so nothing depends on the recorded value.
 */
const SECRET_KEY =
    /^(api_?key|apikey|token|access_?token|auth_?token|password|passwd|secret|nzb_?key|session[-_]?id)$/i;

/**
 * `path` may be a function when the endpoint needs an id from something
 * captured earlier — Sonarr's episode list needs a series id, and inventing
 * one would capture a 404 rather than a shape. It receives the fixtures
 * captured so far for the same service, keyed by endpoint name, and returning
 * undefined skips the endpoint with a reason rather than guessing.
 */
type Endpoint = {
    name: string;
    path: string | ((captured: Map<string, unknown>) => string | undefined);
    body?: unknown;
    /** The response is a bare string rather than JSON — qBittorrent only.
     *  `anonymise` is what shapes it into something writable as a fixture. */
    text?: boolean;
    anonymise?: (body: unknown) => unknown;
};

/** First numeric `id` in an array-shaped fixture. */
const firstId = (body: unknown): number | undefined => {
    const rows = Array.isArray(body) ? body : [];
    const row = rows[0] as { id?: unknown } | undefined;
    return typeof row?.id === 'number' ? row.id : undefined;
};

/**
 * First series in a captured `series` fixture that actually has files on disk.
 *
 * Deliberately not `firstId`: `/episodefile?seriesId=` for a series with
 * nothing downloaded answers `[]`, and an empty array is a fixture that guards
 * nothing — the contract test would pass forever whatever upstream renamed.
 * Undefined when no captured series has a file, like every other helper here,
 * so the endpoint is skipped with a reason rather than capturing a shape that
 * does not exist.
 */
const firstSeriesWithFiles = (body: unknown): number | undefined => {
    const rows = Array.isArray(body) ? body : [];
    for (const row of rows as { id?: unknown; statistics?: { episodeFileCount?: unknown } }[]) {
        const files = row.statistics?.episodeFileCount;
        if (typeof row.id === 'number' && typeof files === 'number' && files > 0) return row.id;
    }
    return undefined;
};

type Row = Record<string, unknown>;

/**
 * Identity scrubbing, which is a different job from secret redaction above.
 *
 * Redaction removes credentials. This removes *who and where you are*: account
 * names, email addresses, and the indexers you subscribe to. None of it is a
 * secret, all of it is permanent once committed to a public repository.
 *
 * It is deliberately declared per endpoint rather than by key name. `Name` is
 * an identity on `/Users` and a scheduled task on `/ScheduledTasks`, and a
 * blanket rule on the key would destroy the fixture that tells us which task
 * scans the library.
 */
const anonymousUrl = 'https://indexer.example.test/';

/** Replaces any absolute URL, leaving surrounding text intact. */
const scrubUrls = (value: string): string => value.replace(/https?:\/\/[^\s"',\]]+/gi, anonymousUrl);

/** Keeps a field present and typed, but replaces a string value. */
const replaceIfString = (value: unknown, replacement: string): unknown =>
    typeof value === 'string' ? replacement : value;

function anonymiseIndexer(row: Row, index: number): Row {
    const fields = Array.isArray(row.fields)
        ? (row.fields as Row[]).map(f => ({
              ...f,
              value: typeof f.value === 'string' ? scrubUrls(f.value) : f.value
          }))
        : row.fields;

    return {
        ...row,
        name: replaceIfString(row.name, `Indexer ${index + 1}`),
        description: replaceIfString(row.description, 'An indexer.'),
        definitionName: replaceIfString(row.definitionName, 'Definition'),
        indexerUrls: Array.isArray(row.indexerUrls) ? [anonymousUrl] : row.indexerUrls,
        legacyUrls: Array.isArray(row.legacyUrls) ? [] : row.legacyUrls,
        fields
    };
}

/**
 * An episode file names where the user keeps their media and who they take it
 * from — the same class of thing as an indexer name, and permanent once it is
 * in a public repository.
 *
 * The scrubbed list is every string-valued path- or release-shaped property on
 * Sonarr's own `EpisodeFileResource` (`specs/sonarr.json`): `path` (absolute,
 * so it carries the whole library layout), `relativePath` (the folder and file
 * naming scheme), `sceneName` (the release name, which names the group, the
 * tracker's conventions and often the uploader) and `releaseGroup`.
 * `originalFilePath` and `sourcePath` are not on the 4.0 schema but are
 * emitted by some import paths, and an unrecognised key surviving is worse
 * than a known one rewritten twice.
 *
 * Everything else is left exactly as captured, because it is the shape the
 * contract test reads and none of it is identifying: `id`, `seriesId`,
 * `seasonNumber`, `size`, `dateAdded`, `quality`, `languages`, `mediaInfo`,
 * `customFormats`, `customFormatScore`, `indexerFlags`, `releaseType`,
 * `qualityCutoffNotMet`. Values are replaced rather than dropped, so each
 * field keeps its presence and its type.
 */
function anonymiseEpisodeFile(row: Row, index: number): Row {
    const n = String(index + 1).padStart(2, '0');
    const file = `Series.Title.S01E${n}.1080p.WEB-DL.x264-GROUP`;
    return {
        ...row,
        path: replaceIfString(row.path, `/media/tv/Series Title/Season 01/${file}.mkv`),
        relativePath: replaceIfString(row.relativePath, `Season 01/${file}.mkv`),
        originalFilePath: replaceIfString(row.originalFilePath, `Series Title/Season 01/${file}.mkv`),
        sourcePath: replaceIfString(row.sourcePath, `/downloads/${file}/${file}.mkv`),
        sceneName: replaceIfString(row.sceneName, file),
        releaseGroup: replaceIfString(row.releaseGroup, 'GROUP')
    };
}

/** A torrent name is a release name, and an info hash identifies the release
 *  exactly — both say what the user is downloading. */
function anonymiseTorrent(row: Row, index: number): Row {
    const n = index + 1;
    return {
        ...row,
        name: replaceIfString(row.name, `Release.Name.${n}.1080p.WEB-DL.x264-GROUP`),
        hash: replaceIfString(row.hash, String(n).repeat(40).slice(0, 40)),
        save_path: replaceIfString(row.save_path, '/downloads'),
        content_path: replaceIfString(row.content_path, `/downloads/release-${n}`),
        download_path: replaceIfString(row.download_path, '/downloads'),
        magnet_uri: replaceIfString(row.magnet_uri, 'magnet:?xt=urn:btih:__REDACTED__'),
        tracker: replaceIfString(row.tracker, 'https://tracker.example.test/announce'),
        category: replaceIfString(row.category, 'category'),
        tags: replaceIfString(row.tags, '')
    };
}

const anonymiseTorrents = (body: unknown): unknown =>
    Array.isArray(body) ? (body as Row[]).map(anonymiseTorrent) : body;

function anonymiseSeerrUser(row: Row, index: number): Row {
    const n = index + 1;
    return {
        ...row,
        email: replaceIfString(row.email, `user${n}@example.test`),
        username: replaceIfString(row.username, `user${n}`),
        plexUsername: replaceIfString(row.plexUsername, `user${n}`),
        jellyfinUsername: replaceIfString(row.jellyfinUsername, `user${n}`),
        displayName: replaceIfString(row.displayName, `User ${n}`),
        // A gravatar URL embeds a hash of the email address, so leaving it
        // would undo the line above.
        avatar: replaceIfString(row.avatar, '/avatarproxy/anonymous')
    };
}

/**
 * What each adapter needs to see. Extend this when an adapter starts reading a
 * new endpoint — a fixture that does not exist cannot be tested against.
 */
const ENDPOINTS: Record<ServiceId, Endpoint[]> = {
    radarr: [
        { name: 'system-status', path: '/api/v3/system/status' },
        { name: 'diskspace', path: '/api/v3/diskspace' },
        { name: 'health', path: '/api/v3/health' },
        { name: 'system-task', path: '/api/v3/system/task' },
        { name: 'queue', path: '/api/v3/queue' },
        { name: 'calendar', path: '/api/v3/calendar' },
        { name: 'movie', path: '/api/v3/movie' },
        // The detail endpoint returns the same shape as a list element, so the
        // list is what the contract test needs — but capturing one detail
        // response proves the path and the id type.
        {
            name: 'movie-detail',
            path: captured => {
                const id = firstId(captured.get('movie'));
                return id === undefined ? undefined : `/api/v3/movie/${id}`;
            }
        },
        { name: 'movie-lookup', path: '/api/v3/movie/lookup?term=matrix' }
    ],
    sonarr: [
        { name: 'system-status', path: '/api/v3/system/status' },
        { name: 'diskspace', path: '/api/v3/diskspace' },
        { name: 'health', path: '/api/v3/health' },
        { name: 'system-task', path: '/api/v3/system/task' },
        { name: 'queue', path: '/api/v3/queue' },
        { name: 'calendar', path: '/api/v3/calendar' },
        { name: 'series', path: '/api/v3/series' },
        {
            name: 'episode',
            path: captured => {
                const id = firstId(captured.get('series'));
                return id === undefined ? undefined : `/api/v3/episode?seriesId=${id}`;
            }
        },
        {
            // delete_episode_files resolves its whole delete set from this
            // payload — `id`, `seasonNumber` and `size` — and none of the three
            // is contracted, because until now no fixture existed to contract
            // them against. A rename of `seasonNumber` would put every file in
            // season 0, so `delete_episode_files { season: 1 }` would delete
            // nothing at all with a green suite.
            name: 'episodefile',
            path: captured => {
                const id = firstSeriesWithFiles(captured.get('series'));
                return id === undefined ? undefined : `/api/v3/episodefile?seriesId=${id}`;
            },
            anonymise: body => (Array.isArray(body) ? (body as Row[]).map(anonymiseEpisodeFile) : body)
        },
        { name: 'series-lookup', path: '/api/v3/series/lookup?term=breaking%20bad' }
    ],
    prowlarr: [
        { name: 'system-status', path: '/api/v1/system/status' },
        { name: 'health', path: '/api/v1/health' },
        { name: 'diskspace', path: '/api/v1/diskspace' },
        {
            name: 'indexer',
            path: '/api/v1/indexer',
            anonymise: body => (Array.isArray(body) ? (body as Row[]).map(anonymiseIndexer) : body)
        },
        { name: 'indexerstatus', path: '/api/v1/indexerstatus' },
        { name: 'indexerstats', path: '/api/v1/indexerstats' },
        { name: 'history', path: '/api/v1/history?pageSize=20' },
        // Deliberately a query nothing will match well: this is captured for
        // its *shape*, and a popular term would pull hundreds of release names
        // into a public repository for no extra information.
        { name: 'search', path: '/api/v1/search?query=zzzq' }
    ],
    bazarr: [
        { name: 'system-status', path: '/api/system/status' },
        { name: 'system-health', path: '/api/system/health' },
        { name: 'providers', path: '/api/providers' },
        { name: 'movies-wanted', path: '/api/movies/wanted' },
        { name: 'episodes-wanted', path: '/api/episodes/wanted' }
    ],
    jellyfin: [
        { name: 'system-info', path: '/System/Info' },
        {
            name: 'users',
            path: '/Users',
            anonymise: body =>
                Array.isArray(body)
                    ? (body as Row[]).map((u, i) => ({ ...u, Name: replaceIfString(u.Name, `User ${i + 1}`) }))
                    : body
        },
        // Deliberately NOT anonymised: `Name` here is a scheduled task, and
        // this is the fixture that identifies the library-scan task.
        { name: 'scheduled-tasks', path: '/ScheduledTasks' },
        { name: 'sessions', path: '/Sessions' },
        {
            name: 'items-search',
            // Must match what JellyfinAdapter.search actually requests. Without
            // Fields, Jellyfin returns no ProviderIds at all — which is exactly
            // what the resolver joins on.
            path: '/Items?searchTerm=a&Recursive=true&IncludeItemTypes=Movie,Series&Limit=5&Fields=ProviderIds'
        },
        {
            name: 'items-library',
            // Per-user, because UserData — the watched state — only comes back
            // when Jellyfin knows who is asking. The id is read from the users
            // fixture captured a moment earlier.
            path: captured => {
                const users = captured.get('users');
                const id = Array.isArray(users) ? (users[0] as { Id?: string } | undefined)?.Id : undefined;
                // EnableImages=false is capture-only trim: the adapter reads
                // none of ImageTags/BackdropImageTags/ImageBlurHashes, and a
                // flat-colour blurhash is long, alphanumeric-only, and
                // undelimited — exactly the shape the fixture secret guard in
                // test/fixtures.test.ts treats as a possible credential.
                return id === undefined
                    ? undefined
                    : `/Items?userId=${id}&Recursive=true&IncludeItemTypes=Movie,Series` +
                      '&Fields=ProviderIds,Genres&EnableUserData=true&EnableImages=false&Limit=20';
            },
            // Watch history is the one genuinely personal thing in the fixture
            // set — the library titles are already public in radarr/movie.json,
            // but who has watched what is not. Keys and types are preserved,
            // which is all the contract test reads; the values are synthetic.
            //
            // A live 10.11.11 response carries more per-item watch signal than
            // Played/PlayCount/LastPlayedDate: PlaybackPositionTicks (exact
            // resume point), PlayedPercentage and UnplayedItemCount (partial
            // series progress) and IsFavorite are all real behavioural data
            // that the adapter never reads, so they are neutralised here too
            // rather than left to leak past the three fields the adapter does.
            anonymise: body => {
                const page = body as { Items?: Row[] };
                if (!Array.isArray(page.Items)) return body;
                return {
                    ...page,
                    Items: page.Items.map((item, i) => ({
                        ...item,
                        UserData:
                            item.UserData === undefined
                                ? undefined
                                : {
                                      ...(item.UserData as Row),
                                      Played: i % 2 === 0,
                                      PlayCount: i % 2 === 0 ? 1 : 0,
                                      LastPlayedDate: undefined,
                                      PlaybackPositionTicks: 0,
                                      IsFavorite: false,
                                      ...('PlayedPercentage' in (item.UserData as Row)
                                          ? { PlayedPercentage: i % 2 === 0 ? 100 : 0 }
                                          : {}),
                                      ...('UnplayedItemCount' in (item.UserData as Row)
                                          ? { UnplayedItemCount: i % 2 === 0 ? 0 : 1 }
                                          : {})
                                  }
                    }))
                };
            }
        }
    ],
    seerr: [
        { name: 'status', path: '/api/v1/status' },
        {
            name: 'user',
            path: '/api/v1/user',
            anonymise: body => {
                const page = body as { results?: Row[] };
                return Array.isArray(page.results)
                    ? { ...page, results: page.results.map(anonymiseSeerrUser) }
                    : body;
            }
        },
        { name: 'settings-about', path: '/api/v1/settings/about' },
        {
            name: 'request',
            path: '/api/v1/request?take=20',
            // Requests name who made them, which is identity, not a secret.
            anonymise: body => {
                const page = body as { results?: Row[] };
                return Array.isArray(page.results)
                    ? {
                          ...page,
                          results: page.results.map((r, i) => ({
                              ...r,
                              requestedBy: anonymiseSeerrUser((r.requestedBy ?? {}) as Row, i)
                          }))
                      }
                    : body;
            }
        },
        { name: 'search', path: '/api/v1/search?query=matrix' },
        { name: 'discover-movies', path: '/api/v1/discover/movies' }
    ],
    sabnzbd: [
        { name: 'version', path: '/api?mode=version&output=json' },
        { name: 'queue', path: '/api?mode=queue&output=json' },
        { name: 'server-stats', path: '/api?mode=server_stats&output=json' }
    ],
    transmission: [{ name: 'session-get', path: '/transmission/rpc', body: { method: 'session-get' } }],
    qbittorrent: [
        { name: 'version', path: '/api/v2/app/version', text: true, anonymise: body => ({ version: body }) },
        { name: 'torrents-info', path: '/api/v2/torrents/info', anonymise: anonymiseTorrents },
        // Trimmed to `server_state`: the rest of maindata is the same torrent
        // list again, keyed by hash.
        {
            name: 'maindata',
            path: '/api/v2/sync/maindata',
            anonymise: body => ({ server_state: (body as { server_state?: unknown }).server_state ?? {} })
        },
        // Trimmed to the one field the adapter reads. The full preferences
        // object carries `web_ui_password`, proxy credentials and RSS feeds,
        // and `SECRET_KEY` matches none of those key names.
        {
            name: 'preferences',
            path: '/api/v2/app/preferences',
            anonymise: body => ({ save_path: (body as { save_path?: unknown }).save_path ?? '' })
        }
    ]
};

function strategyFor(id: ServiceId, service: NonNullable<Config['services'][ServiceId]>): AuthStrategy {
    if (id === 'transmission') {
        const t = service as { username?: string; password?: string };
        return transmissionRpc({
            ...(t.username === undefined ? {} : { username: t.username }),
            ...(t.password === undefined ? {} : { password: t.password })
        });
    }
    if (id === 'qbittorrent') {
        const q = service as { url: string; timeout_ms: number; username?: string; password?: string };
        return qbittorrentSession({
            url: q.url,
            timeoutMs: q.timeout_ms,
            ...(q.username === undefined ? {} : { username: q.username }),
            ...(q.password === undefined ? {} : { password: q.password })
        });
    }
    const key = (service as { api_key: string }).api_key;
    if (id === 'jellyfin') return embyToken(key);
    if (id === 'sabnzbd') return queryParamKey('apikey', key);
    if (id === 'bazarr') return apiKeyHeader('X-API-KEY', key);
    return apiKeyHeader('X-Api-Key', key);
}

const ANONYMOUS_HOST = 'service.example.test';

// `hostsOf` is shared with `integration.ts` (`scripts/lib/redact.ts`) — both
// scripts need the same "every host the user configured" list, one to
// anonymise fixture files, the other to keep a live error message off the
// terminal, and a second hand-written copy is exactly the kind of drift this
// phase exists to eliminate.

/** Every configured credential, so the post-write scan can look for them exactly. */
function secretsOf(config: Config): string[] {
    const out: string[] = [];
    for (const service of Object.values(config.services)) {
        if (service === undefined) continue;
        const s = service as { api_key?: string; password?: string };
        if (s.api_key) out.push(s.api_key);
        if (s.password) out.push(s.password);
    }
    return out;
}

/**
 * Private and loopback IPv4 literals, for addresses a service reports about
 * *itself* rather than ones we configured — Jellyfin's `LocalAddress` is its
 * Docker bridge address, which no host substitution would ever match.
 *
 * Restricted to RFC1918, loopback and link-local on purpose. A blanket IPv4
 * pattern would rewrite version strings; scoping it to ranges that cannot be a
 * version number keeps that impossible. Replaced with TEST-NET-1, which is
 * reserved for documentation.
 */
const PRIVATE_IPV4 =
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

function redact(node: unknown, secrets: string[], hosts: string[]): unknown {
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

const configDir = process.env.ARR_MCP_CAPTURE_CONFIG ?? './config';
// `persist: false` — capturing fixtures reads the user's config; it must never
// write to the file holding their credentials.
const { config } = await loadConfig(configDir, { persist: false });
const secrets = secretsOf(config);
const hosts = hostsOf(config);

if (secrets.length === 0) {
    console.error(`No credentials found in ${configDir}/config.yaml — nothing to capture.`);
    process.exit(1);
}

let captured = 0;
let skipped = 0;

// One instance per service type. Fixtures are recorded per service, not per
// instance — `test/fixtures/radarr` describes what a Radarr says, and an HD and
// a 4K instance answer the same shapes — so capturing both would mean the
// second silently overwrote the first.
const capturedTypes = new Set<ServiceId>();

for (const instance of listInstances(config)) {
    if (capturedTypes.has(instance.type)) {
        console.log(`  skipping ${instance.id}: already captured ${instance.type}`);
        continue;
    }
    capturedTypes.add(instance.type);

    const id = instance.type;
    const service = instance.config;

    const http = new ServiceHttp(id, service, strategyFor(id, service));
    const dir = join('test', 'fixtures', id);
    await mkdir(dir, { recursive: true });

    // Fixtures captured for this service so far, so an endpoint needing an id
    // can take a real one rather than inventing a 404.
    const soFar = new Map<string, unknown>();

    for (const endpoint of ENDPOINTS[id]) {
        const path = typeof endpoint.path === 'function' ? endpoint.path(soFar) : endpoint.path;
        if (path === undefined) {
            console.warn(`skipped  ${id}/${endpoint.name}: needs an id from an endpoint that did not capture`);
            skipped += 1;
            continue;
        }

        try {
            const raw = endpoint.text
                ? await http.getText(path)
                : endpoint.body === undefined
                  ? await http.get<unknown>(path)
                  : await http.post<unknown>(path, endpoint.body);
            soFar.set(endpoint.name, raw);

            // Anonymise identity first, then redact credentials — so a value
            // the anonymiser rewrites is still checked for leaked secrets.
            const identified = endpoint.anonymise === undefined ? raw : endpoint.anonymise(raw);
            const serialised = JSON.stringify(redact(identified, secrets, hosts), null, 2);

            // The gate. If a configured credential or host survived, refuse to
            // write rather than trusting a reviewer to spot it in a diff.
            if (secrets.some(s => serialised.includes(s))) {
                console.error(`REFUSING TO WRITE ${id}/${endpoint.name}: a configured credential survived redaction`);
                process.exit(1);
            }
            const leakedHost = hosts.find(h => serialised.includes(h));
            if (leakedHost !== undefined) {
                console.error(`REFUSING TO WRITE ${id}/${endpoint.name}: a configured host survived redaction`);
                process.exit(1);
            }

            await writeFile(join(dir, `${endpoint.name}.json`), `${serialised}\n`);
            console.log(`captured ${id}/${endpoint.name}`);
            captured += 1;
        } catch (err) {
            // A missing endpoint is information, not a failure: it tells us the
            // service does not have that capability. Record and continue.
            //
            // `classifyFetchError` (src/core/errors.ts) deliberately embeds the
            // host in a Timeout/Unreachable ServiceError's own `.message` — the
            // fixture-writing path below never sees that (it redacts hosts out
            // of *captured response bodies*), but this line prints the error
            // itself, straight to the terminal, unredacted otherwise.
            console.warn(`skipped  ${id}/${endpoint.name}: ${redactHosts((err as Error).message, hosts)}`);
            skipped += 1;
        }
    }
}

console.log(`\n${captured} captured, ${skipped} skipped.`);
console.log('Review `git diff test/fixtures/` before committing — redaction is secrets-only by design.');
