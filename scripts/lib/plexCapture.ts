/**
 * Row-selection and path-building helpers for `capture-fixtures.ts`'s Plex
 * endpoints, split out so they can be unit tested against `PlexAdapter`
 * (src/services/plex.ts) directly — `capture-fixtures.ts` itself runs a
 * top-level `loadConfig()` on import and can't be pulled into a test.
 */

/**
 * Server-side field trim, adopted only on `history` and `onDeck`: not
 * fetching `Media`/`Part` (a file path), cast/crew `Role` and `summary` is
 * strictly better than fetching and then scrubbing them, and `#commonPlayback`
 * (src/services/plex.ts — the mapper every `history`/`onDeck` row goes
 * through) never reads any of the three. Verified on the tester's server:
 * `onDeck` dropped `Media[].Part[].file`, `Role` and `summary`; `history` had
 * none of the three to begin with, so the params are a no-op there but
 * harmless. Deliberately NOT applied to `section-all`/`metadata-detail` —
 * `getMediaDetails` genuinely reads `Media[0].Part[0].file`/`.size`, and
 * excluding `Media` from `section-all`'s raw capture would also break
 * `firstPartBearingSectionAll` (N5), which picks `metadata-detail`'s
 * ratingKey out of that same raw body. See B3.
 */
const PLEX_UNWATCHED_ELEMENTS = 'excludeElements=Media,Role&excludeFields=summary';

/**
 * The `history` endpoint's exact query form. Must mirror every param
 * `PlexAdapter#getWatchHistory` sends except `X-Plex-Container-Size`,
 * deliberately smaller here — five rows proves the shape without pulling the
 * tester's whole server-wide history onto disk. `excludeElements`/
 * `excludeFields` are a capture-only trim (see `PLEX_UNWATCHED_ELEMENTS`),
 * not a mirror of the adapter, same reasoning as the smaller page size.
 *
 * A previous fix added `sort=viewedAt:desc` to the adapter (newest first, so
 * the page cap truncates from the least useful end) and left this behind:
 * capture's unsorted read and the adapter's descending one landed on
 * opposite ends of the tester's history with zero row overlap. See G1.
 */
export const plexHistoryPath = (start: number, size: number): string =>
    `/status/sessions/history/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}&sort=viewedAt:desc&${PLEX_UNWATCHED_ELEMENTS}`;

/** `onDeck`'s query form. `PlexAdapter#getPlayback`/`#getNextUp` send no
 *  query at all — the exclusion params are a pure capture-only trim, same
 *  reasoning as `plexHistoryPath`'s. See B3. */
export const plexOnDeckPath = (): string => `/library/onDeck?${PLEX_UNWATCHED_ELEMENTS}`;

/**
 * `section-all`'s exact query form, mirroring `PlexAdapter#pagedSection`
 * (`#paged` called with no `type`, the form `listUserLibrary` uses).
 * `X-Plex-Container-Size` is deliberately smaller than `PAGE_SIZE`, same
 * reasoning as `plexHistoryPath`.
 */
export const plexSectionAllPath = (key: string, start: number, size: number): string =>
    `/library/sections/${key}/all?includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;

/** `search`'s exact query form, mirroring `PlexAdapter#search`. */
export const plexSearchPath = (query: string): string => `/search?query=${encodeURIComponent(query)}&includeGuids=1`;

/**
 * `accounts`'s query form. Unlike the others, `PlexAdapter#listUsers` sends
 * no paging at all — it reads `/accounts` unbounded to find the one owner
 * row it needs. Capping here is a capture-only privacy trim, not a mirror of
 * the adapter: the tester's server answers ~103 rows uncapped, most of it
 * other households' account names. See G2.
 */
export const plexAccountsPath = (start: number, size: number): string =>
    `/accounts?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;

type PartBearingRow = { ratingKey?: unknown; Media?: { Part?: unknown[] }[] };

const hasPart = (row: PartBearingRow): boolean =>
    Array.isArray(row.Media) && row.Media.length > 0 && Array.isArray(row.Media[0]?.Part) && (row.Media[0]?.Part?.length ?? 0) > 0;

/**
 * The `ratingKey` of the first row in a captured Plex `MediaContainer`
 * fixture that carries a `Media[0].Part` — falling back to the first row when
 * none do, so the `metadata-detail` capture is deterministic either way.
 *
 * `getMediaDetails` (src/services/plex.ts) reads `Media[0].Part[0].file` and
 * `.size`. Without this, the fixture is built from whatever row a section
 * happens to list first — on the tester's server, the TV section's first row
 * was a bare `show` container with no `Media`/`Part`/`file` at all, so a
 * fixture built from it never contracts the mapping it exists to prove. See G3.
 */
export const firstRatingKeyWithPart = (body: unknown): string | undefined => {
    const rows = (body as { MediaContainer?: { Metadata?: unknown } } | undefined)?.MediaContainer?.Metadata;
    const list = (Array.isArray(rows) ? rows : []) as PartBearingRow[];
    const row = list.find(hasPart) ?? list[0];
    return typeof row?.ratingKey === 'string' ? row.ratingKey : undefined;
};

const hasPartBearingRow = (body: unknown): boolean => {
    const rows = (body as { MediaContainer?: { Metadata?: unknown } } | undefined)?.MediaContainer?.Metadata;
    const list = (Array.isArray(rows) ? rows : []) as PartBearingRow[];
    return list.some(hasPart);
};

/**
 * Every movie/show library section's `key`, in the order `/library/sections`
 * lists them — filtered to `type` the same way `PlexAdapter#listUserLibrary`
 * filters its own section read (`#sections('movie', 'show')`,
 * src/services/plex.ts). Without the filter, a photo or music section can
 * still be walked below: every photo carries `Media[0].Part[0]` the same
 * shape an episode does, so `firstPartBearingSectionAll`'s search for a
 * Part-bearing row can land on one, and the walk-only-looking-for-shape
 * fixture ends up publishing real photo titles and file paths. See I3.
 */
export const sectionKeys = (body: unknown): string[] => {
    const rows = (body as { MediaContainer?: { Directory?: unknown } } | undefined)?.MediaContainer?.Directory;
    const list = (Array.isArray(rows) ? rows : []) as { key?: unknown; type?: unknown }[];
    return list
        .filter((r): r is { key: string; type: string } => typeof r.key === 'string' && (r.type === 'movie' || r.type === 'show'))
        .map(r => r.key);
};

/**
 * Walks a server's library sections in listed order, fetching a small page
 * of each via `fetchPage` until one contains a Part-bearing row — falling
 * back to the first section's own page when none do, so `section-all`'s
 * capture is deterministic either way rather than silently landing on
 * whichever section happens to be listed first.
 *
 * `#pagedSection` reads every section indiscriminately in production
 * (`listUserLibrary`), so trying more than the first here is a capture-only
 * search for a *good* fixture, not a mirror of the adapter. See N5: on the
 * tester's server the first section (a TV library) listed 364 rows, every
 * one `type: "show"` with no `Media`/`Part`/`file` at all — seasons carry
 * none either, only episodes do — so a fixture built from just the first
 * section never contracted `getMediaDetails`'s `Media[0].Part[0].file`/
 * `.size` mapping.
 */
export async function firstPartBearingSectionAll(
    keys: readonly string[],
    fetchPage: (key: string) => Promise<unknown>
): Promise<{ key: string; body: unknown } | undefined> {
    let fallback: { key: string; body: unknown } | undefined;
    for (const key of keys) {
        const body = await fetchPage(key);
        if (fallback === undefined) fallback = { key, body };
        if (hasPartBearingRow(body)) return { key, body };
    }
    return fallback;
}
