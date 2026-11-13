/**
 * The stack the screenshots show. Invented, and deliberately so.
 *
 * The pages render token names, an MCP endpoint host and every configured
 * service URL, and `screenshots/` is committed to a public repo — so the shots
 * are built from data that never touched `config.yaml` rather than from a live
 * instance with the secrets blanked afterwards. Nothing here is a credential,
 * so nothing here can leak one.
 *
 * Every timestamp is frozen. The pages put these through `shortTime`, and a
 * live clock would rewrite all eight PNGs on every run, which turns "the UI
 * changed" into a question you have to answer by eye.
 *
 * Typed against the page functions' own parameters: when a page gains a
 * required field, `npm run typecheck` fails here rather than the script
 * rendering a page that quietly no longer matches production.
 */
import { readFileSync } from 'node:fs';
import type { Config } from '../../src/config/schema.ts';
import type { LogRow } from '../../src/core/logs.ts';
import { groupDisks, type DiskGroup } from '../../src/core/disks.ts';
import type { ConnectionDiagnosis, HealthCheck, ScanState } from '../../src/services/types.ts';
import type { AuditRow } from '../../src/core/audit.ts';
import { hashToken } from '../../src/core/secrets.ts';
import type { MediaCards } from '../../src/ui/mediaCards.ts';

/** Frozen like the rest; the expiring token is dated relative to it. */
export const NOW = new Date('2026-08-13T09:45:00Z');
const THREE_DAYS_OUT = new Date(NOW.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);

/** Names of fixture tokens the dashboard reports as still plaintext on disk. */
export const FIXTURE_PLAINTEXT_ON_DISK = ['phone-assistant'];

/** Only its hash reaches the fixture config. Self-describing in case it is
 *  ever photographed. */
export const FIXTURE_TOKEN = 'screenshot-fixture-token-not-a-real-credential'.padEnd(64, '-');

const HOST = 'media-host';

/** Read rather than written down: hardcoded, it photographed 1.7.0 into every
 *  screenshot for three releases after that one. */
export const VERSION: string = (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/**
 * Every supported service, all reachable. A dashboard is not the place to
 * demonstrate a failure — the Problems table below it is, and it does, so the
 * hero shot shows a working stack while the page still shows what a problem
 * looks like. Seventeen tiles run past the fixed viewport, which cuts off that
 * table in the committed PNG; the full page is one `fullPage` capture away.
 */
export const DIAGNOSES: ConnectionDiagnosis[] = [
    { ok: true, service: 'bazarr', latency_ms: 26, version: '1.6.0' },
    { ok: true, service: 'cleanuparr', latency_ms: 18, version: '2.10.12' },
    { ok: true, service: 'dispatcharr', latency_ms: 21, version: '0.33.0' },
    { ok: true, service: 'jellyfin', latency_ms: 9, version: '10.11.11' },
    { ok: true, service: 'lidarr', latency_ms: 31, version: '3.1.6.5079' },
    { ok: true, service: 'nzbget', latency_ms: 12, version: '26.3' },
    { ok: true, service: 'plex', latency_ms: 16, version: '1.43.5' },
    { ok: true, service: 'profilarr', latency_ms: 22, version: '2.2.0' },
    { ok: true, service: 'prowlarr', latency_ms: 35, version: '2.5.2.5491' },
    { ok: true, service: 'qbittorrent', latency_ms: 11, version: '5.3.0' },
    { ok: true, service: 'radarr', latency_ms: 24, version: '6.3.0.10514' },
    { ok: true, service: 'reclaimerr', latency_ms: 19, version: '0.6.5' },
    { ok: true, service: 'sabnzbd', latency_ms: 10, version: '5.1.0' },
    { ok: true, service: 'seerr', latency_ms: 29, version: '3.4.1' },
    { ok: true, service: 'sonarr', latency_ms: 13, version: '4.0.19.2979' },
    { ok: true, service: 'transmission', latency_ms: 9, version: '4.1.3 (838877323f)' },
    { ok: true, service: 'whisparr', latency_ms: 27, version: '2.2.0.108' }
];

export const CONFIGURED = DIAGNOSES.map(d => d.service);

/** Real-shaped health checks: these are the strings these services actually
 *  emit, which is what makes the Problems table worth showing at all. */
export const FAILURES: HealthCheck[] = [
    {
        service: 'sonarr',
        source: 'IndexerStatusCheck',
        type: 'warning',
        message: 'Indexers unavailable due to failures for more than 6 hours: Prowlarr (NZBgeek)'
    },
    {
        service: 'radarr',
        source: 'ImportListStatusCheck',
        type: 'warning',
        message: 'Lists unavailable due to failures: Trakt Watchlist'
    }
];

/** Two services reporting one filesystem, grouped the way `buildStackHealth`
 *  hands them to the page, so the folding is visible rather than implied. */
export const DISKS: DiskGroup[] = groupDisks([
    { service: 'radarr', label: 'media', freeSpace: 4_812_364_546_048, totalSpace: 20_000_588_955_648 },
    { service: 'sonarr', label: 'media', freeSpace: 4_812_369_395_712, totalSpace: 20_000_588_955_648 },
    { service: 'transmission', label: 'downloads', freeSpace: 812_364_546_048 }
]);

export const SCANS: ScanState[] = [
    { service: 'jellyfin', lastCompleted: '2026-08-12T03:14:07', running: false },
    { service: 'sonarr', lastCompleted: '2026-08-13T06:00:11', running: true }
];

export const IMDB = { ingestedAt: '2026-08-10T04:02:55', titles: 11_842_309, ratings: 1_574_882 };

export const WRITE_COUNTS = { applied: 47, denied: 3, total: 50 };

export const MCP_URL = `http://${HOST}:6060/mcp`;

/**
 * Two Radarrs, so the multi-instance naming the config page exists to handle is
 * on screen rather than described. The keys are fixture strings: the page never
 * renders a credential back, but there is no reason for a real one to be in the
 * file that builds a public screenshot.
 */
export const CONFIG: Config = {
    auth: {
        tokens: [
            { name: 'claude-desktop', tier: 'destructive', hash: hashToken(FIXTURE_TOKEN) },
            { name: 'phone-assistant', tier: 'read', hash: hashToken('p'.repeat(40)), expires: THREE_DAYS_OUT }
        ],
        username: 'admin',
        password_hash: 'scrypt$fixture$fixture',
        allow_token_in_url: false,
        allowed_hosts: []
    },
    services: {
        radarr: [
            {
                name: 'hd',
                url: `http://${HOST}:7878`,
                api_key: 'fixture-key',
                timeout_ms: 10_000,
                permissions: { safe_write: true, destructive: false }
            },
            {
                name: '4k',
                url: `http://${HOST}:7879`,
                api_key: 'fixture-key',
                timeout_ms: 10_000,
                permissions: { safe_write: true, destructive: false }
            }
        ],
        sonarr: {
            url: `http://${HOST}:8989`,
            api_key: 'fixture-key',
            timeout_ms: 10_000,
            permissions: { safe_write: true, destructive: false }
        },
        jellyfin: {
            url: `http://${HOST}:8096`,
            api_key: 'fixture-key',
            timeout_ms: 10_000,
            default_user: 'media-user',
            allow_other_users: false,
            permissions: { safe_write: false, destructive: false }
        },
        transmission: {
            url: `http://${HOST}:9091`,
            timeout_ms: 10_000,
            permissions: { safe_write: true, destructive: true }
        }
    },
    metadata: { imdb: { enabled: true } }
};

export const LOG_SERVICES = ['jellyfin', 'radarr/4k', 'radarr/hd', 'sonarr', 'transmission'];

export const LOG_ROWS: LogRow[] = [
    {
        id: 812,
        at: '2026-08-13T09:41:02.114Z',
        level: 30,
        levelName: 'info',
        service: null,
        msg: 'configuration reloaded',
        fields: '{"services":8}'
    },
    {
        id: 811,
        at: '2026-08-13T09:40:58.902Z',
        level: 40,
        levelName: 'warn',
        service: 'radarr/4k',
        msg: 'connection failed — timed out after 10000 ms',
        fields: '{"kind":"timeout"}'
    },
    {
        id: 810,
        at: '2026-08-13T09:40:44.317Z',
        level: 30,
        levelName: 'info',
        service: 'sonarr',
        msg: 'search triggered for The Expanse (2015) S04',
        fields: '{"tool":"trigger_search"}'
    },
    {
        id: 809,
        at: '2026-08-13T09:38:20.006Z',
        level: 30,
        levelName: 'info',
        service: 'jellyfin',
        msg: 'library scan completed in 4m 12s',
        fields: '{"tool":"get_stack_health"}'
    },
    {
        id: 808,
        at: '2026-08-13T09:31:55.771Z',
        level: 50,
        levelName: 'error',
        service: 'transmission',
        msg: 'session handshake rejected — 409 without a session id',
        fields: '{"kind":"auth"}'
    }
];

export const AUDIT_ROWS: AuditRow[] = [
    {
        id: 3,
        at: '2026-08-13T09:40:44.317Z',
        tool: 'trigger_search',
        service: 'sonarr',
        operation: 'search',
        tier: 'safe_write',
        target: 'The Expanse (2015) S04',
        args: '{"series_id":114,"season":4}',
        outcome: 'applied',
        detail: null,
        settled_at: '2026-08-13T09:40:44.552Z',
        caller: 'oauth:desktop-client'
    },
    {
        id: 2,
        at: '2026-08-13T09:22:10.550Z',
        tool: 'manage_queue',
        service: 'radarr/hd',
        operation: 'remove',
        tier: 'destructive',
        target: 'Dune.Part.Two.2024.2160p',
        args: '{"queue_id":88,"blocklist":true}',
        outcome: 'denied',
        detail: 'destructive writes are off for radarr/hd',
        settled_at: '2026-08-13T09:22:10.551Z',
        caller: 'bearer'
    },
    {
        id: 1,
        at: '2026-08-13T08:57:41.208Z',
        tool: 'manage_requests',
        service: 'seerr',
        operation: 'approve',
        tier: 'safe_write',
        target: 'request 412 — Poor Things (2023)',
        args: '{"request_id":412,"verdict":"approve"}',
        outcome: 'applied',
        detail: null,
        settled_at: '2026-08-13T08:57:41.402Z',
        // The third shape the page has to render: a row written before the
        // caller column existed. Null means that and nothing else.
        caller: null
    }
];

/**
 * The MCP Apps poster cards (`src/ui/mediaCards.ts`), for invented titles.
 *
 * The image URLs are on the hosts the view allows, and never fetched: the
 * screenshot script answers them with generated artwork, so the shots need no
 * network and photograph nobody's poster.
 */
const poster = (name: string): string => `https://image.tmdb.org/t/p/w342/${name}.jpg`;
const fenced = (service: string, field: string, value: string): string => `<<untrusted:${service}.${field}>>${value}<</>>`;

export const CARD_DETAIL: MediaCards = {
    view: 'detail',
    total: 1,
    items: [
        {
            type: 'series',
            title: fenced('sonarr', 'title', 'The Lighthouse Keepers'),
            year: 2024,
            ids: { tvdb: 900001, tmdb: 900001, imdb: 'tt9000001' },
            status: 'monitored',
            qualityProfile: 'HD-1080p',
            poster: poster('fixture-lighthouse'),
            backdrop: 'https://image.tmdb.org/t/p/w780/fixture-lighthouse-backdrop.jpg',
            overview: fenced(
                'sonarr',
                'overview',
                'Three keepers on a storm-bound island find the logbook of the crew they replaced, and the last entry is dated tomorrow. Every season covers one winter, and every winter the supply boat is a day later than the one before.'
            ),
            genres: [fenced('sonarr', 'genre', 'Drama'), fenced('sonarr', 'genre', 'Mystery')],
            seasonCount: 2,
            episodes: { onDisk: 14, aired: 18 },
            links: { tmdb: 'https://www.themoviedb.org/tv/900001', imdb: 'https://www.imdb.com/title/tt9000001/' },
            ref: { service: 'sonarr', id: '42' }
        }
    ]
};

const tile = (title: string, year: number, type: 'movie' | 'series', status: MediaCards['items'][number]['status'], image?: string) => ({
    type,
    title: fenced(type === 'movie' ? 'radarr' : 'sonarr', 'title', title),
    year,
    ids: {},
    status,
    ...(image === undefined ? {} : { poster: poster(image) })
});

export const CARD_GRID: MediaCards = {
    view: 'grid',
    total: 23,
    items: [
        tile('Paper Satellites', 2023, 'movie', 'downloaded', 'fixture-satellites'),
        tile('The Lighthouse Keepers', 2024, 'series', 'monitored', 'fixture-lighthouse'),
        tile('Night Ferry to Tallinn', 2021, 'movie', 'downloading', 'fixture-ferry'),
        tile('Copper & Salt', 2019, 'series', 'downloaded', 'fixture-copper'),
        tile('A Quiet Orbit', 2025, 'movie', 'absent', 'fixture-orbit'),
        tile('Glasshouse', 2018, 'movie', 'unmonitored', 'fixture-glasshouse'),
        // No artwork: what a card looks like when its image cannot load.
        tile('The Cartographer’s Daughter', 2022, 'movie', 'monitored'),
        tile('Low Tide', 2020, 'series', 'downloaded', 'fixture-tide')
    ]
};
