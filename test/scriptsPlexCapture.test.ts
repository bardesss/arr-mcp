import { describe, expect, it } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { PlexAdapter } from '../src/services/plex.ts';
import {
    firstPartBearingSectionAll,
    firstRatingKeyWithPart,
    plexHistoryPath,
    plexOnDeckPath,
    plexSearchPath,
    plexSectionAllPath,
    sectionKeys
} from '../scripts/lib/plexCapture.ts';
import { jsonResponse } from './helpers/serve.ts';

const container = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

const config: MultiUserServiceConfig = {
    url: 'http://192.0.2.10:32400',
    api_key: 'tok',
    timeout_ms: 10_000,
    allow_other_users: false,
    permissions: { safe_write: false, destructive: false }
};

/** Captures the exact URL PlexAdapter sends for one call, so the capture
 *  script's own path builders can be asserted against it directly rather
 *  than against a second, hand-copied string that can quietly drift. */
const sentUrl = async (run: (adapter: PlexAdapter) => Promise<unknown>): Promise<URL> => {
    let sent: URL | undefined;
    const fetchImpl = (async (input: string | URL | Request) => {
        sent = new URL(input instanceof Request ? input.url : String(input));
        return jsonResponse({ MediaContainer: { Metadata: [] } });
    }) as unknown as typeof fetch;
    await run(new PlexAdapter(config, fetchImpl));
    if (sent === undefined) throw new Error('adapter made no request');
    return sent;
};

/**
 * The tester's TV section listed a `show` row first — `type: show`, no
 * `Media`/`Part`/`file` at all — with a file-bearing episode further down the
 * same page. A fixture built from the first row alone never exercises
 * `getMediaDetails`'s `Media[0].Part[0].file`/`.size` mapping. See G3.
 */
describe('firstRatingKeyWithPart', () => {
    it('picks the first row that carries a Media/Part over an earlier row that does not', () => {
        const body = container([
            { ratingKey: '211802', type: 'show' },
            { ratingKey: '211900', type: 'episode', Media: [{ Part: [{ file: '/media/tv/x.mkv', size: 123 }] }] }
        ]);
        expect(firstRatingKeyWithPart(body)).toBe('211900');
    });

    it('falls back to the first row when nothing carries a Part', () => {
        const body = container([{ ratingKey: '1', type: 'show' }, { ratingKey: '2', type: 'show' }]);
        expect(firstRatingKeyWithPart(body)).toBe('1');
    });

    it('treats an empty Part array the same as no Part at all', () => {
        const body = container([
            { ratingKey: '1', Media: [{ Part: [] }] },
            { ratingKey: '2', Media: [{ Part: [{ file: '/x.mkv' }] }] }
        ]);
        expect(firstRatingKeyWithPart(body)).toBe('2');
    });

    it('returns undefined when the fixture carries no rows at all', () => {
        expect(firstRatingKeyWithPart(container([]))).toBeUndefined();
    });

    it('returns undefined on a body with no MediaContainer.Metadata', () => {
        expect(firstRatingKeyWithPart({ MediaContainer: {} })).toBeUndefined();
    });
});

/**
 * B3: `#commonPlayback` (src/services/plex.ts) reads only titles, indices
 * and progress off a history/onDeck row — never `Media`/`Part`, cast/crew or
 * `summary` — so these two endpoints ask the server not to send them at all,
 * rather than fetching and then scrubbing them. `section-all` and
 * `metadata-detail` deliberately do NOT get the same trim — `getMediaDetails`
 * reads `Media[0].Part[0].file`/`.size`, and excluding `Media` from
 * `section-all`'s raw capture would also break `firstPartBearingSectionAll`
 * (N5), which picks `metadata-detail`'s ratingKey out of that same raw body.
 */
describe('history and onDeck ask the server to omit data #commonPlayback never reads (B3)', () => {
    it('plexHistoryPath excludes Media/Part, Role and the other cast/crew elements, and the summary field', () => {
        const path = plexHistoryPath(0, 5);
        expect(path).toContain('excludeElements=Media,Role,Writer,Director,Producer');
        expect(path).toContain('excludeFields=summary');
    });

    it('plexOnDeckPath excludes the same elements and fields as plexHistoryPath', () => {
        const path = plexOnDeckPath();
        expect(path).toContain('excludeElements=Media,Role,Writer,Director,Producer');
        expect(path).toContain('excludeFields=summary');
    });

    /**
     * `Writer`/`Director`/`Producer` entries carry `tagKey`, the plex.tv
     * person id, next to `tag` (the name) — a real capture had `tag`
     * scrubbed by `anonymiseNested` while `tagKey` survived and resolved
     * straight back to the real person. Not fetching the arrays at all beats
     * fetching and then teaching the scrubber a new field, same reasoning as
     * `Role` already being excluded here.
     */
    it('plexHistoryPath and plexOnDeckPath also exclude Writer, Director and Producer, whose tagKey identifies a real person', () => {
        expect(plexHistoryPath(0, 5)).toContain('Writer,Director,Producer');
        expect(plexOnDeckPath()).toContain('Writer,Director,Producer');
    });

    it('plexSectionAllPath does not exclude anything — getMediaDetails reads Media/Part from this shape', () => {
        expect(plexSectionAllPath('1', 0, 5)).not.toContain('exclude');
    });
});

describe('sectionKeys', () => {
    it('returns every movie/show section key in listed order', () => {
        const body = { MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'show' }] } };
        expect(sectionKeys(body)).toEqual(['1', '2']);
    });

    it('skips a row whose key is not a string', () => {
        const body = { MediaContainer: { Directory: [{ key: 1, type: 'movie' }, { key: '2', type: 'show' }] } };
        expect(sectionKeys(body)).toEqual(['2']);
    });

    it('returns an empty list when there is no Directory array', () => {
        expect(sectionKeys({ MediaContainer: {} })).toEqual([]);
        expect(sectionKeys(undefined)).toEqual([]);
    });

    /**
     * I3: `firstPartBearingSectionAll` searches for any row with
     * `Media[0].Part[0]` — a shape every photo has too. Sections ordered
     * TV → Music → Photos → Movies would land `section-all`/`metadata-detail`
     * on real photos (titles, file paths) unless the photo/music sections
     * never reach the walk in the first place.
     */
    it('excludes a section whose type is neither movie nor show, e.g. a photo library', () => {
        const body = {
            MediaContainer: {
                Directory: [
                    { key: '1', type: 'show' },
                    { key: '2', type: 'artist' },
                    { key: '3', type: 'photo' },
                    { key: '4', type: 'movie' }
                ]
            }
        };
        expect(sectionKeys(body)).toEqual(['1', '4']);
    });
});

/**
 * N5: `section-all` was built only from the first section's key. On the
 * tester's server the first (TV) section listed 364 rows — all `type:
 * "show"`, none with `Media`/`Part` (seasons have none either; only episodes
 * do) — so a fixture built from it never contracted `getMediaDetails`'s
 * `Media[0].Part[0].file`/`.size` mapping. This walks sections in order
 * until one's page has a Part-bearing row.
 */
describe('firstPartBearingSectionAll', () => {
    const container = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });
    const partBearing = container([{ ratingKey: '1', Media: [{ Part: [{ file: '/x.mkv' }] }] }]);
    const partLess = container([{ ratingKey: '1', type: 'show' }, { ratingKey: '2', type: 'show' }]);

    it('picks the first section whose page has a Part-bearing row over an earlier Part-less one', async () => {
        const pages: Record<string, unknown> = { tv: partLess, movies: partBearing };
        const fetched: string[] = [];
        const result = await firstPartBearingSectionAll(['tv', 'movies'], async key => {
            fetched.push(key);
            return pages[key];
        });
        expect(result?.key).toBe('movies');
        expect(result?.body).toBe(partBearing);
    });

    it('stops walking once a Part-bearing section is found, rather than fetching every section', async () => {
        const pages: Record<string, unknown> = { movies: partBearing, tv: partLess };
        const fetched: string[] = [];
        await firstPartBearingSectionAll(['movies', 'tv'], async key => {
            fetched.push(key);
            return pages[key];
        });
        expect(fetched).toEqual(['movies']);
    });

    it('falls back to the first section when none carry a Part-bearing row', async () => {
        const pages: Record<string, unknown> = { tv: partLess, music: container([{ ratingKey: '9', type: 'artist' }]) };
        const result = await firstPartBearingSectionAll(['tv', 'music'], async key => pages[key]);
        expect(result?.key).toBe('tv');
        expect(result?.body).toBe(partLess);
    });

    it('returns undefined when there are no sections to walk', async () => {
        const result = await firstPartBearingSectionAll([], async () => {
            throw new Error('should not be called');
        });
        expect(result).toBeUndefined();
    });
});

/**
 * The class of drift G1 exists to fix: a previous round added
 * `sort=viewedAt:desc` to `PlexAdapter#getWatchHistory` and the capture
 * script's own `history` endpoint was never updated, so it recorded the
 * opposite end of the tester's history from the one production reads —
 * zero overlap between the two 5-row windows. These compare the capture's
 * path builders against what the adapter actually sends, not a second
 * hand-copied string, so a future adapter change trips this test instead of
 * silently drifting again.
 */
describe('capture-vs-adapter request parity', () => {
    it('history: sends the same pathname, start and sort as PlexAdapter#getWatchHistory', async () => {
        const adapterUrl = await sentUrl(a => a.getWatchHistory({ id: '1', name: 'X' }));
        const captureUrl = new URL(`http://x${plexHistoryPath(0, 5)}`);

        expect(captureUrl.pathname).toBe(adapterUrl.pathname);
        expect(captureUrl.searchParams.get('X-Plex-Container-Start')).toBe(adapterUrl.searchParams.get('X-Plex-Container-Start'));
        expect(captureUrl.searchParams.get('sort')).toBe(adapterUrl.searchParams.get('sort'));
        expect(captureUrl.searchParams.get('sort')).not.toBeNull();
        // Container-Size intentionally differs: 5 for a shape fixture, PAGE_SIZE (500) in production.
    });

    it('section-all: sends the same pathname, includeGuids and start as PlexAdapter#listUserLibrary', async () => {
        const fetchImpl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/library/sections') {
                return jsonResponse({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
            }
            return jsonResponse({ MediaContainer: { Metadata: [] } });
        }) as unknown as typeof fetch;
        let sent: URL | undefined;
        const wrapped = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname.startsWith('/library/sections/')) sent = url;
            return fetchImpl(input);
        }) as unknown as typeof fetch;

        const adapter = new PlexAdapter(config, wrapped);
        await adapter.listUserLibrary({ id: '1', name: 'X' });
        if (sent === undefined) throw new Error('adapter made no section-all request');

        const captureUrl = new URL(`http://x${plexSectionAllPath('1', 0, 5)}`);
        expect(captureUrl.pathname).toBe(sent.pathname);
        expect(captureUrl.searchParams.get('includeGuids')).toBe(sent.searchParams.get('includeGuids'));
        expect(captureUrl.searchParams.get('X-Plex-Container-Start')).toBe(sent.searchParams.get('X-Plex-Container-Start'));
    });

    it('search: sends the identical query PlexAdapter#search sends', async () => {
        const adapterUrl = await sentUrl(a => a.search('a', 'library'));
        const captureUrl = new URL(`http://x${plexSearchPath('a')}`);
        expect(captureUrl.pathname + captureUrl.search).toBe(adapterUrl.pathname + adapterUrl.search);
    });
});
