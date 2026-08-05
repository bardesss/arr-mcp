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

/** Does the recorded response actually carry this dotted path? */
export function fixtureHasField(fixture: unknown, dotted: string): boolean {
    const sample = Array.isArray(fixture) ? fixture[0] : fixture;
    if (sample === undefined || sample === null) return false;

    let node: unknown = sample;
    for (const part of dotted.split('.')) {
        const here = Array.isArray(node) ? node[0] : node;
        if (here === null || typeof here !== 'object' || !(part in here)) return false;
        node = (here as Record<string, unknown>)[part];
    }
    return true;
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
                fixture: 'test/fixtures/radarr/movie.json',
                fields: ['id', 'title', 'year', 'monitored', 'hasFile', 'tmdbId', 'ratings']
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
                fixture: 'test/fixtures/sonarr/series.json',
                fields: ['id', 'title', 'monitored', 'tvdbId', 'ratings', 'statistics']
            },
            {
                fixture: 'test/fixtures/sonarr/episode.json',
                fields: ['id', 'seasonNumber', 'episodeNumber', 'title', 'hasFile', 'monitored']
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
            }
        ]
    },
    seerr: {
        dependencies: [
            { fixture: 'test/fixtures/seerr/status.json', fields: ['version'] },
            { fixture: 'test/fixtures/seerr/user.json', fields: ['results'] },
            { fixture: 'test/fixtures/seerr/request.json', fields: ['results'] },
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
});
