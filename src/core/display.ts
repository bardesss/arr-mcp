/**
 * What a poster card shows and no answer needs: artwork, the synopsis, the
 * runtime and episode progress.
 *
 * Carried beside an item rather than on it. A model reads the items, and two
 * image URLs and a paragraph on every row of a fifty-row page is context spent
 * on nothing it can use; `get_library` dropped folder paths for less (#518).
 * The adapters fill this, `ui/mediaCards.ts` reads it, and every tool strips it
 * from what it returns (`withoutDisplay`), so the only place it surfaces is the
 * `cards` list an MCP Apps host renders.
 *
 * Text fields stay fenced: `cards` travel in `structuredContent`, which a
 * client may hand to a model, so the view unfences them, not the server.
 */
export type Display = {
    /** A public poster URL, already sized for a card. Never an *arr's own URL. */
    poster?: string;
    /** A public backdrop URL, sized for the detail view. */
    backdrop?: string;
    /** Fenced. */
    overview?: string;
    /** Films only. */
    runtimeMinutes?: number;
    /** Series only, from Sonarr's statistics. */
    seasonCount?: number;
    /** Series only: episodes with a file, against what has aired. */
    episodes?: { onDisk: number; aired: number };
    /**
     * A lookup hit only: whether the *arr that answered already manages it. A
     * lookup returns the library's own record for a title it holds, and the
     * hit's `id` cannot say which one it got (it falls back to the tmdb id).
     */
    inLibrary?: boolean;
};

/**
 * Hosts an image may come from.
 *
 * The *arrs return two URLs per image: `url`, a path on the *arr itself
 * (`/MediaCover/340/poster.jpg`), and `remoteUrl`, the metadata provider's.
 * Only the second may ever reach a card; the first would hand a client the
 * service's internal address, and would not load inside a sandboxed view
 * anyway. Radarr's provider is TMDB and Sonarr's is TheTVDB, so both are
 * allowed, and are the domains the view's CSP declares (`mcp/apps.ts`).
 */
export const IMAGE_HOSTS = ['image.tmdb.org', 'artworks.thetvdb.com'] as const;

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
export const POSTER_SIZE = 'w342';
export const BACKDROP_SIZE = 'w780';

/** The URL, if it is HTTPS on an allowed host; otherwise nothing. */
export function publicImageUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value === '') return undefined;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    if (!(IMAGE_HOSTS as readonly string[]).includes(url.hostname)) return undefined;
    return url.href;
}

/**
 * A TMDB image at the size a card needs.
 *
 * Radarr's `remoteUrl` asks for `original`, several megabytes for a poster
 * shown 150 pixels wide; TMDB serves the same file at fixed widths under the
 * same path, so the size segment is swapped. Any other URL passes through.
 */
export function resizeTmdb(url: string, size: string): string {
    const parsed = new URL(url);
    if (parsed.hostname !== 'image.tmdb.org') return url;
    const match = /^\/t\/p\/[^/]+\/(.+)$/.exec(parsed.pathname);
    return match === null ? url : `${TMDB_IMAGE_BASE}/${size}/${match[1]}`;
}

/**
 * A TMDB `poster_path` or `backdrop_path` (`/abc.jpg`) as a URL; what Seerr,
 * being TMDB-backed, hands over on every search hit. Anything that is not a
 * bare file name is refused rather than concatenated.
 */
export function tmdbImageUrl(path: unknown, size: string): string | undefined {
    if (typeof path !== 'string') return undefined;
    const name = path.replace(/^\//, '');
    if (!/^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(name)) return undefined;
    return `${TMDB_IMAGE_BASE}/${size}/${name}`;
}

export type RawImage = { coverType?: string | null; url?: string | null; remoteUrl?: string | null };

/**
 * Poster and backdrop from an *arr's `images`, by `remoteUrl` only. Sonarr
 * and Radarr both call the backdrop `fanart`.
 */
export function artworkFromImages(images: readonly RawImage[] | null | undefined): Pick<Display, 'poster' | 'backdrop'> {
    const pick = (type: string, size: string): string | undefined => {
        const url = publicImageUrl(images?.find(i => i.coverType === type)?.remoteUrl);
        return url === undefined ? undefined : resizeTmdb(url, size);
    };
    const poster = pick('poster', POSTER_SIZE);
    const backdrop = pick('fanart', BACKDROP_SIZE);
    return {
        ...(poster === undefined ? {} : { poster }),
        ...(backdrop === undefined ? {} : { backdrop })
    };
}

/** Drops empty values, and the whole object when nothing is left. */
export function compactDisplay(display: Display): Display | undefined {
    const out = Object.fromEntries(Object.entries(display).filter(([, v]) => v !== undefined && v !== '')) as Display;
    return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * The item as a tool returns it: without `display`. Every tool that hands an
 * adapter's search hit or details back routes it through here.
 */
export function withoutDisplay<T extends { display?: Display }>(item: T): Omit<T, 'display'> {
    if (!('display' in item)) return item;
    const { display: _d, ...rest } = item;
    return rest;
}
