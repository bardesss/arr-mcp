import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design spec §17 asks contract tests to catch upstream drift before users do.
 *
 * This asserts that the response fields each adapter *reads* still exist —
 * deliberately not that every fixture validates against its whole spec schema.
 * The generated *arr specs are loose about nullability and upstream adds fields
 * routinely, so whole-schema validation would go red for drift that cannot
 * affect us. A check that cries wolf is a check that gets skipped, which costs
 * exactly the protection §17 is buying.
 */
const ROOT = join(import.meta.dirname, '..');
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

type Dependency = {
    /** OpenAPI path, when the service publishes a spec. */
    path?: string;
    method?: 'get' | 'post';
    fixture: string;
    /** Dotted paths the adapter reads. */
    fields: string[];
};

type ServiceContract = { spec?: string; dependencies: Dependency[] };

/** Does one sample (never itself an array — see `fixtureHasField`) carry this dotted path? */
function sampleHasField(sample: unknown, dotted: string): boolean {
    if (sample === undefined || sample === null) return false;

    let node: unknown = sample;
    for (const part of dotted.split('.')) {
        const here = Array.isArray(node) ? node[0] : node;
        if (here === null || typeof here !== 'object' || !(part in here)) return false;
        node = (here as Record<string, unknown>)[part];
    }
    return true;
}

/**
 * Does the recorded response actually carry this dotted path?
 *
 * A top-level array checks *every* element, not just the first: a field a
 * real service only ever populates on some rows (Radarr's `movieFile`, only
 * present once a movie actually has one) would otherwise never be
 * contractable at all against a whole-library fixture whose first movie
 * happens to have none — a check that appears to pass or fail is not the
 * same as a check that actually exercises the field (whole-phase review item
 * 6: "a path that passes for the wrong reason guards nothing"). Interior
 * arrays reached partway through a dotted path (e.g. Jellyfin's nested
 * `Items`) still use only their first element, matching what every existing
 * contract entry already relies on.
 */
export function fixtureHasField(fixture: unknown, dotted: string): boolean {
    const samples = Array.isArray(fixture) ? fixture : [fixture];
    return samples.some(sample => sampleHasField(sample, dotted));
}

const deref = (spec: Record<string, unknown>, node: unknown): unknown => {
    let current = node;
    for (let hops = 0; hops < 10; hops += 1) {
        const ref = (current as Record<string, unknown> | undefined)?.['$ref'];
        if (typeof ref !== 'string' || !ref.startsWith('#/')) return current;
        current = ref
            .slice(2)
            .split('/')
            .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], spec);
    }
    return current;
};

/** Declared property names of a 200 response body, unwrapping $refs and arrays. */
export function resolveResponseFields(spec: unknown, path: string, method: string): Set<string> | undefined {
    const doc = spec as Record<string, never>;
    const operation = (doc.paths as Record<string, never> | undefined)?.[path]?.[method];
    if (operation === undefined) return undefined;

    const responses = (operation as Record<string, never>).responses as Record<string, never> | undefined;
    const ok = responses?.['200'] ?? responses?.default;
    const content = (ok as Record<string, never> | undefined)?.content as Record<string, never> | undefined;
    const media = content?.['application/json'] ?? Object.values(content ?? {})[0];

    let schema = deref(doc, (media as Record<string, never> | undefined)?.schema);
    if ((schema as Record<string, unknown> | undefined)?.type === 'array') {
        schema = deref(doc, (schema as Record<string, unknown>).items);
    }

    const properties = (schema as Record<string, unknown> | undefined)?.properties as
        | Record<string, unknown>
        | undefined;
    return properties === undefined ? undefined : new Set(Object.keys(properties));
}

/**
 * Health dependencies are deliberately absent for Radarr, Sonarr and Bazarr:
 * all three returned `[]` during the capture run because the stack is healthy,
 * so there is no recorded row to assert against. Design spec §21.7 stays open
 * rather than being closed on an assumption. Add them the first time a real
 * instance reports a problem.
 */
const CONTRACTS: Record<string, ServiceContract> = {
    radarr: {
        spec: 'specs/radarr.json',
        dependencies: [
            { path: '/api/v3/system/status', method: 'get', fixture: 'test/fixtures/radarr/system-status.json', fields: ['version'] },
            { path: '/api/v3/diskspace', method: 'get', fixture: 'test/fixtures/radarr/diskspace.json', fields: ['path', 'label', 'freeSpace', 'totalSpace'] },
            { path: '/api/v3/system/task', method: 'get', fixture: 'test/fixtures/radarr/system-task.json', fields: ['taskName', 'lastExecution'] },
            { fixture: 'test/fixtures/radarr/calendar.json', fields: ['id', 'title', 'hasFile', 'monitored'] },
            {
                // `movieFile.size` and `movieFile.quality.quality.name` are
                // only ever present on a row that actually has a file — the
                // whole-library fixture's first movie does not, so these are
                // only assertable at all because `fixtureHasField` now checks
                // every element, not just the first. They feed
                // `acquisition.sizeBytes`/`acquisition.quality`, and
                // `get_library`'s `quality` filter runs on the latter — an
                // upstream rename would silently make that filter match
                // nothing, with a green suite, if these went uncontracted.
                fixture: 'test/fixtures/radarr/movie.json',
                fields: [
                    'id',
                    'title',
                    'year',
                    'monitored',
                    'hasFile',
                    'tmdbId',
                    'ratings',
                    'genres',
                    'movieFile.size',
                    'movieFile.quality.quality.name'
                ]
            },
            { fixture: 'test/fixtures/radarr/movie-lookup.json', fields: ['title', 'tmdbId'] }
            // No `queue` entry: the queue was empty at capture time, and an
            // empty array confirms nothing. Add it when something is downloading.
        ]
    },
    sonarr: {
        spec: 'specs/sonarr.json',
        dependencies: [
            { path: '/api/v3/system/status', method: 'get', fixture: 'test/fixtures/sonarr/system-status.json', fields: ['version'] },
            { path: '/api/v3/diskspace', method: 'get', fixture: 'test/fixtures/sonarr/diskspace.json', fields: ['path', 'label', 'freeSpace', 'totalSpace'] },
            { path: '/api/v3/system/task', method: 'get', fixture: 'test/fixtures/sonarr/system-task.json', fields: ['taskName', 'lastExecution'] },
            {
                fixture: 'test/fixtures/sonarr/calendar.json',
                fields: ['id', 'title', 'seasonNumber', 'episodeNumber', 'airDateUtc', 'hasFile', 'monitored']
            },
            {
                // `ratings` here is flat — { votes, value } — not Radarr's
                // per-source map. §21.2, resolved by the capture run.
                //
                // `statistics.episodeFileCount` is read by listLibrary to
                // derive hasFile — a series has no single file, so this count
                // stands in for it. Without this entry an upstream rename
                // would make every series report hasFile: false with a green
                // suite: the bare `statistics` key would still resolve.
                // `statistics.sizeOnDisk` feeds `acquisition.sizeBytes`,
                // displayed by get_library/get_media_details — uncontracted
                // before this phase turned display text into a filter input
                // elsewhere in this same object (`statistics.episodeFileCount`,
                // just above).
                //
                // The `seasons[]` fields are the same argument one level down.
                // `seasonNumber` is what every season row is keyed and merged
                // on, and the three counts become `onDisk`, `aired` and
                // `total` — with `total` the denominator `complete` is
                // computed against. A rename of `totalEpisodeCount` would make
                // `complete` vanish library-wide, silently, since every unit
                // test builds its own fixture and would keep passing.
                fixture: 'test/fixtures/sonarr/series.json',
                fields: [
                    'id',
                    'title',
                    'monitored',
                    'tvdbId',
                    'ratings',
                    'statistics',
                    'statistics.episodeFileCount',
                    'statistics.sizeOnDisk',
                    'genres',
                    'seasons.seasonNumber',
                    'seasons.statistics.episodeFileCount',
                    'seasons.statistics.episodeCount',
                    'seasons.statistics.totalEpisodeCount'
                ]
            },
            {
                // `episodeFileId` is what delete_episode_files.ts resolves an
                // episode id to a file id through — it reads the field off
                // `EpisodeSummary`, itself mapped straight from this one.
                // Without this entry an upstream rename would make every
                // episode look fileless to that tool: it would report
                // "nothing to delete" for a season that plainly has files, a
                // silent no-op nobody notices with a green suite.
                fixture: 'test/fixtures/sonarr/episode.json',
                fields: ['id', 'seasonNumber', 'episodeNumber', 'title', 'hasFile', 'monitored', 'episodeFileId']
            },
            { fixture: 'test/fixtures/sonarr/series-lookup.json', fields: ['title', 'tvdbId'] }
        ]
    },
    prowlarr: {
        spec: 'specs/prowlarr.json',
        dependencies: [
            { path: '/api/v1/system/status', method: 'get', fixture: 'test/fixtures/prowlarr/system-status.json', fields: ['version'] },
            {
                fixture: 'test/fixtures/prowlarr/indexer.json',
                fields: ['id', 'name', 'enable', 'protocol', 'priority']
            },
            {
                // Records carry `successful` and `data`, but `data` has **no
                // reason field** — the adapter describes the event instead.
                fixture: 'test/fixtures/prowlarr/history.json',
                fields: ['records']
            },
            { fixture: 'test/fixtures/prowlarr/indexerstats.json', fields: ['indexers'] }
            // No `search` entry: the capture used a deliberately unmatchable
            // query, so no release shape was recorded. Publishing real release
            // names to catch this would cost more than it is worth.
        ]
    },
    // No spec: Jellyfin's is vendored, but the adapter uses local narrow types,
    // so the fixture is what these are checked against.
    jellyfin: {
        dependencies: [
            { fixture: 'test/fixtures/jellyfin/system-info.json', fields: ['Version'] },
            { fixture: 'test/fixtures/jellyfin/users.json', fields: ['Id', 'Name'] },
            { fixture: 'test/fixtures/jellyfin/scheduled-tasks.json', fields: ['Key', 'State', 'LastExecutionResult'] },
            { fixture: 'test/fixtures/jellyfin/sessions.json', fields: ['UserId', 'PlayState'] },
            { fixture: 'test/fixtures/jellyfin/items-search.json', fields: ['Items'] },
            {
                // Only assertable now that the capture requests Fields=ProviderIds.
                // The resolver joins on these; an upstream change here breaks the
                // three-way join silently.
                fixture: 'test/fixtures/jellyfin/items-search.json',
                fields: ['Items.Id', 'Items.Name', 'Items.ProviderIds']
            },
            {
                // `Items.Genres` is read by listUserLibrary and fenced into
                // the merged item's genre list — omitted here, an upstream
                // rename would silently make every item report no genres.
                //
                // The bare `Items.UserData` entry only asserts the container
                // exists — `listUserLibrary` reads the two sub-fields below
                // directly, and `get_library`'s `watched` filter runs on both,
                // so a rename to either would silently make that filter match
                // nothing with a green suite.
                fixture: 'test/fixtures/jellyfin/items-library.json',
                fields: [
                    'Items.Id',
                    'Items.Name',
                    'Items.Type',
                    'Items.ProviderIds',
                    'Items.UserData',
                    'Items.UserData.Played',
                    'Items.UserData.PlayCount',
                    'Items.Genres'
                ]
            }
        ]
    },
    seerr: {
        dependencies: [
            { fixture: 'test/fixtures/seerr/status.json', fields: ['version'] },
            { fixture: 'test/fixtures/seerr/user.json', fields: ['results'] },
            {
                // `results.media.tvdbId` is read as the diagnose matcher's
                // fallback when a request carries no tmdbId (Task 7 Finding
                // B). Present but null on every recorded row, since the
                // capture happens to hold only movie requests — nullability
                // is confirmed against specs/seerr.json's MediaInfo schema.
                fixture: 'test/fixtures/seerr/request.json',
                fields: ['results', 'results.media.tvdbId']
            },
            { fixture: 'test/fixtures/seerr/discover-movies.json', fields: ['results'] }
        ]
    },
    bazarr: {
        dependencies: [
            { fixture: 'test/fixtures/bazarr/system-status.json', fields: ['data.bazarr_version'] },
            // `status` is "Good" with a capital G; `retry` is "-" when idle.
            { fixture: 'test/fixtures/bazarr/providers.json', fields: ['data.name', 'data.status', 'data.retry'] },
            {
                fixture: 'test/fixtures/bazarr/movies-wanted.json',
                fields: ['data.radarrId', 'data.title', 'data.sceneName', 'data.missing_subtitles']
            },
            {
                // `episode_number` is a combined "5x2" string — there are no
                // separate season and episode fields.
                fixture: 'test/fixtures/bazarr/episodes-wanted.json',
                fields: ['data.sonarrEpisodeId', 'data.seriesTitle', 'data.episode_number', 'data.missing_subtitles']
            }
        ]
    },
    sabnzbd: {
        dependencies: [
            { fixture: 'test/fixtures/sabnzbd/version.json', fields: ['version'] },
            { fixture: 'test/fixtures/sabnzbd/queue.json', fields: ['queue.diskspace1', 'queue.diskspacetotal1'] }
        ]
    },
    transmission: {
        dependencies: [
            {
                fixture: 'test/fixtures/transmission/session-get.json',
                fields: ['result', 'arguments.version', 'arguments.download-dir', 'arguments.download-dir-free-space']
            }
        ]
    }
};

describe('adapter contracts', () => {
    for (const [service, contract] of Object.entries(CONTRACTS)) {
        describe(service, () => {
            for (const dep of contract.dependencies) {
                const label = dep.path ?? dep.fixture.split('/').pop();

                it(`${label} still returns the fields the adapter reads`, () => {
                    const fixture = read(dep.fixture);
                    const missing = dep.fields.filter(f => !fixtureHasField(fixture, f));
                    expect(missing, `missing from the recorded response`).toEqual([]);
                });

                // Bound outside the closure: narrowing on `contract.spec` does
                // not survive into a callback TypeScript cannot prove runs now.
                const spec = contract.spec;
                const path = dep.path;
                const method = dep.method ?? 'get';

                if (spec !== undefined && path !== undefined) {
                    it(`${label} still declares those fields in the vendored spec`, () => {
                        const declared = resolveResponseFields(read(spec), path, method);
                        expect(declared, `no ${method} ${path} in ${spec}`).toBeDefined();

                        const missing = dep.fields.filter(f => !declared?.has(f.split('.')[0] ?? f));
                        expect(missing, 'upstream renamed or removed a field we read').toEqual([]);
                    });
                }
            }
        });
    }
});

describe('fixtureHasField', () => {
    it('finds a top-level field on an object response', () => {
        expect(fixtureHasField({ version: '1.0' }, 'version')).toBe(true);
    });

    it('checks the first element of an array response', () => {
        expect(fixtureHasField([{ freeSpace: 1 }], 'freeSpace')).toBe(true);
    });

    it('walks a dotted path', () => {
        expect(fixtureHasField({ a: { b: 2 } }, 'a.b')).toBe(true);
    });

    it('reports a missing field', () => {
        expect(fixtureHasField({ a: 1 }, 'b')).toBe(false);
    });

    it('treats an empty array as unable to confirm, not as confirmed', () => {
        // This is why the health dependencies are absent rather than passing.
        expect(fixtureHasField([], 'anything')).toBe(false);
    });

    // Whole-phase review item 6: a field a real service only populates on
    // some rows (Radarr's movieFile, present only once a movie has a file)
    // must still be contractable against a whole-library array fixture whose
    // first element happens not to carry it.
    it('finds a field present on a later element, not just the first, of an array response', () => {
        expect(fixtureHasField([{ hasFile: false }, { hasFile: true, movieFile: { size: 1 } }], 'movieFile.size')).toBe(true);
    });

    it('still reports false when no element of the array carries the field, not just the first', () => {
        expect(fixtureHasField([{ a: 1 }, { a: 2 }, { a: 3 }], 'movieFile.size')).toBe(false);
    });
});
