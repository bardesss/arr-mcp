import type { ServiceId } from '../config/schema.ts';

/**
 * One keyless GET answer, as the prober hands it to a fingerprint. Header
 * names are lower-cased and the body is capped at 64 KiB.
 */
export type ProbeResponse = { status: number; headers: Record<string, string>; body: string };

export type CatalogEntry = {
    type: ServiceId;
    /** The service's own default port. Discovery never tries another. */
    port: number;
    /** The usual container name, resolvable when arr-mcp shares a Docker network with it. */
    containerNames: readonly string[];
    /** A keyless GET that names the service. */
    path: string;
    /**
     * Returns a match only when the response could come from this service and
     * from no other in the catalog. The prober fetches each distinct
     * (port, path) once and offers that one response to every entry sharing
     * it, so this must reject its neighbours' answers.
     */
    identify(r: ProbeResponse): { version?: string } | undefined;
    /** Anything a reader of the catalog needs to know about this entry. */
    note?: string;
};

/** Services left out of discovery, and why. A wrong guess the user saves is worse than a miss. */
type Undiscoverable = { type: ServiceId; reason: string };

/** The longest version a row shows. A probed host chooses this string, so it is cut short. */
const MAX_VERSION = 64;

const matched = (version?: string): { version?: string } => (version === undefined ? {} : { version: version.slice(0, MAX_VERSION) });

const parseJson = (body: string): unknown => {
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
};

const asObject = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const jsonObject = (r: ProbeResponse): Record<string, unknown> | undefined => (r.status === 200 ? asObject(parseJson(r.body)) : undefined);

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const sameKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
    const have = Object.keys(o).sort();
    return have.length === keys.length && [...keys].sort().every((k, i) => k === have[i]);
};

/** The text of the first title element, trimmed; undefined when there is none. */
const htmlTitle = (body: string): string | undefined => /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();

/** A 200 page whose title is exactly this, ignoring case. */
const titled =
    (title: string) =>
    (r: ProbeResponse): { version?: string } | undefined =>
        r.status === 200 && htmlTitle(r.body)?.toLowerCase() === title.toLowerCase() ? matched() : undefined;

/**
 * The *arrs share a codebase, so the port says nothing. Their /login page
 * answers 200 without a key, whether forms login is on or auth is off for
 * local addresses, and names the app in its title. They give no version
 * without a key.
 */
const arr = (type: ServiceId, name: string, port: number): CatalogEntry => ({
    type,
    port,
    containerNames: [type],
    path: '/login',
    identify: titled(`Login - ${name}`)
});

export const CATALOG: readonly CatalogEntry[] = [
    arr('radarr', 'Radarr', 7878),
    arr('sonarr', 'Sonarr', 8989),
    arr('lidarr', 'Lidarr', 8686),
    arr('whisparr', 'Whisparr', 6969),
    arr('prowlarr', 'Prowlarr', 9696),
    {
        type: 'bazarr',
        port: 6767,
        containerNames: ['bazarr'],
        path: '/',
        identify: titled('Bazarr')
    },
    {
        type: 'jellyfin',
        port: 8096,
        containerNames: ['jellyfin'],
        path: '/System/Info/Public',
        identify: r => {
            const o = jsonObject(r);
            return o?.ProductName === 'Jellyfin Server' ? matched(nonEmptyString(o.Version) ? o.Version : undefined) : undefined;
        }
    },
    {
        type: 'plex',
        port: 32400,
        containerNames: ['plex'],
        path: '/identity',
        identify: r => {
            if (r.status !== 200) return undefined;
            // Plex answers XML unless the request asks for JSON; the prober does not.
            const xml = /<MediaContainer\b[^>]*>/.exec(r.body)?.[0];
            if (xml !== undefined) {
                if (!/\bmachineIdentifier="[^"]+"/.test(xml)) return undefined;
                return matched(/\bversion="([^"]+)"/.exec(xml)?.[1]);
            }
            const mc = asObject(asObject(parseJson(r.body))?.MediaContainer);
            if (mc === undefined || !nonEmptyString(mc.machineIdentifier)) return undefined;
            return matched(nonEmptyString(mc.version) ? mc.version : undefined);
        }
    },
    {
        type: 'seerr',
        port: 5055,
        containerNames: ['seerr', 'jellyseerr', 'overseerr'],
        path: '/api/v1/status',
        identify: r => {
            const o = jsonObject(r);
            if (o === undefined || !nonEmptyString(o.version)) return undefined;
            return typeof o.restartRequired === 'boolean' && typeof o.updateAvailable === 'boolean' ? matched(o.version) : undefined;
        }
    },
    {
        type: 'sabnzbd',
        port: 8080,
        containerNames: ['sabnzbd'],
        path: '/api?mode=version',
        identify: r => {
            const o = jsonObject(r);
            // The version and nothing else, so a Dispatcharr version answer
            // (which also carries a timestamp) is not mistaken for it.
            return o !== undefined && sameKeys(o, ['version']) && nonEmptyString(o.version) ? matched(o.version) : undefined;
        }
    },
    {
        type: 'nzbget',
        port: 6789,
        containerNames: ['nzbget'],
        path: '/',
        identify: r => {
            if (r.status === 401) return /realm="?NZBGet\b/i.test(r.headers['www-authenticate'] ?? '') ? matched() : undefined;
            // An empty ControlPassword serves the web UI instead of asking for a login.
            return titled('NZBGet')(r);
        }
    },
    {
        type: 'transmission',
        port: 9091,
        containerNames: ['transmission'],
        path: '/transmission/rpc',
        // The session id header on a 409 is how Transmission answers an unprimed
        // request. X-Transmission-Rpc-Version is the protocol version, not the
        // app's, so no version is reported.
        identify: r => (r.status === 409 && nonEmptyString(r.headers['x-transmission-session-id']) ? matched() : undefined)
    },
    {
        type: 'qbittorrent',
        port: 8080,
        containerNames: ['qbittorrent'],
        path: '/',
        identify: r => (r.status === 200 && /^qBittorrent\b/i.test(htmlTitle(r.body) ?? '') ? matched() : undefined)
    },
    {
        type: 'profilarr',
        port: 6868,
        containerNames: ['profilarr'],
        path: '/auth/login',
        identify: titled('Profilarr')
    },
    {
        type: 'cleanuparr',
        port: 11011,
        containerNames: ['cleanuparr'],
        path: '/',
        identify: titled('Cleanuparr')
    },
    {
        type: 'reclaimerr',
        port: 8000,
        containerNames: ['reclaimerr'],
        path: '/',
        identify: titled('Reclaimerr')
    },
    {
        type: 'dispatcharr',
        port: 9191,
        containerNames: ['dispatcharr'],
        path: '/api/core/version/',
        identify: r => {
            const o = jsonObject(r);
            return o !== undefined && sameKeys(o, ['version', 'timestamp']) && nonEmptyString(o.version) ? matched(o.version) : undefined;
        }
    },
    {
        type: 'shelfmark',
        port: 8084,
        containerNames: ['shelfmark'],
        path: '/api/health',
        identify: r => {
            const o = jsonObject(r);
            return o !== undefined && sameKeys(o, ['coordinator', 'status']) && o.status === 'ok' && nonEmptyString(o.coordinator) ? matched() : undefined;
        }
    },
    {
        type: 'grimmory',
        port: 6060,
        containerNames: ['grimmory'],
        path: '/api/v1/healthcheck',
        note: 'Grimmory defaults to 6060, the same as arr-mcp. The fingerprint rejects arr-mcp itself (a 404 at this path, or its healthz answer), so a host running both is not reported as Grimmory.',
        identify: r => {
            const o = jsonObject(r);
            const data = asObject(o?.data);
            if (o === undefined || data === undefined || o.message !== 'Pong' || data.status !== 'UP') return undefined;
            return matched(nonEmptyString(data.version) ? data.version : undefined);
        }
    }
];

export const UNDISCOVERABLE: readonly Undiscoverable[] = [];
