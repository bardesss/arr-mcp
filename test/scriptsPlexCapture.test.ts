import { describe, expect, it } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { PlexAdapter } from '../src/services/plex.ts';
import { firstRatingKeyWithPart, plexHistoryPath, plexSearchPath, plexSectionAllPath } from '../scripts/lib/plexCapture.ts';
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
