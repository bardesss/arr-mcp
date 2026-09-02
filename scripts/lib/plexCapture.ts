/**
 * Row-selection helpers for `capture-fixtures.ts`'s Plex endpoints, split out
 * so they can be unit tested — `capture-fixtures.ts` itself runs a top-level
 * `loadConfig()` on import and can't be pulled into a test.
 */

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
