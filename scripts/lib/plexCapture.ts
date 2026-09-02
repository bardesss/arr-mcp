/**
 * Row-selection and path-building helpers for `capture-fixtures.ts`'s Plex
 * endpoints, split out so they can be unit tested against `PlexAdapter`
 * (src/services/plex.ts) directly — `capture-fixtures.ts` itself runs a
 * top-level `loadConfig()` on import and can't be pulled into a test.
 */

/**
 * The `history` endpoint's exact query form. Must mirror every param
 * `PlexAdapter#getWatchHistory` sends except `X-Plex-Container-Size`,
 * deliberately smaller here — five rows proves the shape without pulling the
 * tester's whole server-wide history onto disk.
 *
 * A previous fix added `sort=viewedAt:desc` to the adapter (newest first, so
 * the page cap truncates from the least useful end) and left this behind:
 * capture's unsorted read and the adapter's descending one landed on
 * opposite ends of the tester's history with zero row overlap. See G1.
 */
export const plexHistoryPath = (start: number, size: number): string =>
    `/status/sessions/history/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}&sort=viewedAt:desc`;

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
