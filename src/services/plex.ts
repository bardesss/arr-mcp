/**
 * Every Plex response wraps in `MediaContainer`, with rows under a key that
 * depends on what was asked: `Metadata` for items, `Directory` for library
 * sections, `Account` for accounts.
 */
type MediaContainer = { MediaContainer?: Record<string, unknown> };

export type RawPlexItem = {
    ratingKey?: string;
    key?: string;
    type?: string;
    title?: string;
    grandparentTitle?: string;
    parentIndex?: number;
    index?: number;
    year?: number;
    summary?: string;
    duration?: number;
    viewOffset?: number;
    viewCount?: number;
    lastViewedAt?: number;
    addedAt?: number;
    Genre?: { tag?: string }[];
    Media?: { Part?: { file?: string; size?: number }[] }[];
    /** Modern agents. */
    Guid?: { id?: string }[];
    /** Legacy agents, e.g. `com.plexapp.agents.imdb://tt0111161?lang=en`. */
    guid?: string;
};

export const unwrap = <T>(body: unknown, key: string): T[] => {
    const rows = (body as MediaContainer | null)?.MediaContainer?.[key];
    return Array.isArray(rows) ? (rows as T[]) : [];
};

/** Plex counts milliseconds; Jellyfin counts 100ns ticks. Nothing shared. */
export const msToSeconds = (ms: number | undefined): number | undefined =>
    typeof ms === 'number' ? Math.round(ms / 1000) : undefined;

/** Plex timestamps are unix epoch **seconds**. `lastPlayed` is consumed as ISO. */
export const epochToIso = (seconds: number | undefined): string | undefined =>
    typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : undefined;

/** Digits required, not just finiteness — `Number('')` is 0 and would join
 *  against every other item missing an id. */
const numericId = (value: string | undefined): number | undefined =>
    value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;

const LEGACY_AGENTS: Record<string, 'imdb' | 'tmdb' | 'tvdb'> = {
    imdb: 'imdb',
    themoviedb: 'tmdb',
    thetvdb: 'tvdb'
};

/**
 * The join with Radarr and Sonarr is on these three ids, and Plex reports them
 * in two mutually exclusive shapes depending on the agent the library was built
 * with. A library on a legacy agent whose ids were dropped would produce items
 * with no ids at all — indistinguishable from a Plex library that genuinely
 * shares nothing, which would make `get_library` report every film as
 * `arr_only`. Both shapes are read for that reason.
 */
export function externalIds(item: RawPlexItem): { tmdb?: number; tvdb?: number; imdb?: string } {
    const out: { tmdb?: number; tvdb?: number; imdb?: string } = {};

    if (Array.isArray(item.Guid) && item.Guid.length > 0) {
        for (const g of item.Guid) {
            const m = /^(imdb|tmdb|tvdb):\/\/(.+)$/.exec(g.id ?? '');
            if (m === null) continue;
            const [, scheme, value] = m as unknown as [string, string, string];
            if (scheme === 'imdb') out.imdb = value;
            else {
                const n = numericId(value.split('/')[0]);
                if (n !== undefined) out[scheme as 'tmdb' | 'tvdb'] = n;
            }
        }
        return out;
    }

    const legacy = /^com\.plexapp\.agents\.([a-z]+):\/\/([^?]+)/.exec(item.guid ?? '');
    if (legacy === null) return out;
    const [, agent, rest] = legacy as unknown as [string, string, string];
    const kind = LEGACY_AGENTS[agent];
    if (kind === undefined) return out;
    const value = (rest.split('/')[0] ?? '').trim();
    if (kind === 'imdb') {
        if (value !== '') out.imdb = value;
    } else {
        const n = numericId(value);
        if (n !== undefined) out[kind] = n;
    }
    return out;
}
