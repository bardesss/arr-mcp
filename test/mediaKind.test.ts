import { describe, expect, it } from 'vitest';
import type { LibraryKind } from '../src/core/resolver.ts';
import { splitYear } from '../src/core/titleMatch.ts';
import type { CalendarEntry, QueueItem, SearchHit, ServiceAdapter } from '../src/services/types.ts';
import { buildGetCalendar } from '../src/tools/getCalendar.ts';
import { explainMiss, NotInLibrary } from '../src/tools/getMediaDetails.ts';
import { buildGetQueue } from '../src/tools/getQueue.ts';
import { buildSearchMedia } from '../src/tools/searchMedia.ts';

/**
 * A service that records whether it was asked. `held` stands in for the
 * `queueKind` the *arrs, Shelfmark and Grimmory declare; leaving it out is
 * Seerr, a media server or a download client.
 */
function fake(id: string, opts: { held?: LibraryKind; hits?: Omit<SearchHit, 'service' | 'source'>[]; queue?: boolean; calendar?: boolean }) {
    const asked: string[] = [];
    const adapter = {
        id,
        type: id,
        testConnection: () => Promise.reject(new Error('unused')),
        getVersion: () => Promise.resolve('1'),
        search: (query: string) => {
            asked.push(query);
            return Promise.resolve((opts.hits ?? []).map(h => ({ ...h, service: id, source: 'discover' as const })));
        },
        ...(opts.held === undefined ? {} : { queueKind: opts.held }),
        ...(opts.queue === true
            ? {
                  getQueue: () => {
                      asked.push('queue');
                      return Promise.resolve<QueueItem[]>([{ service: id, id: '1', title: `${id} download`, status: 'downloading' }]);
                  }
              }
            : {}),
        ...(opts.calendar === true
            ? {
                  getCalendar: () => {
                      asked.push('calendar');
                      return Promise.resolve<CalendarEntry[]>([
                          { service: id, kind: 'movie', id: 1, title: id, date: '2026-11-10', hasFile: false, monitored: true }
                      ]);
                  }
              }
            : {})
    };
    return { adapter: adapter as unknown as ServiceAdapter, asked };
}

describe('splitYear', () => {
    const now = new Date('2026-11-09T00:00:00Z');

    it.each([
        ['Paranormal Activity 2027', 'Paranormal Activity', 2027],
        ['Paranormal Activity (2027)', 'Paranormal Activity', 2027],
        ['Dune [2021]', 'Dune', 2021]
    ])('takes the year off %s', (query, title, year) => {
        expect(splitYear(query, now)).toEqual({ title, year });
    });

    it.each(['Blade Runner 2049', '1917', 'Paranormal Activity', 'Room 237'])('leaves %s whole', query => {
        expect(splitYear(query, now)).toEqual({ title: query });
    });
});

describe('kind on search_media', () => {
    const film = { kind: 'movie' as const, id: '1', title: 'Paranormal Activity', year: 2027, ids: { tmdb: 1 } };

    function stack() {
        const radarr = fake('radarr', { held: 'movie', hits: [film] });
        const sonarr = fake('sonarr', { held: 'series', hits: [{ kind: 'series', id: '2', title: 'Paranormal Activity Series', ids: {} }] });
        const lidarr = fake('lidarr', { held: 'artist', hits: [{ kind: 'artist', id: '3', title: 'Paranormal', ids: {} }] });
        const shelfmark = fake('shelfmark', { held: 'book', hits: [{ kind: 'book', id: '4', title: 'A Paranormal Activity', ids: {} }] });
        const seerr = fake('seerr', {
            hits: [
                { ...film, id: '10' },
                { kind: 'series', id: '11', title: 'Paranormal Activity Series', ids: {} }
            ]
        });
        return { radarr, sonarr, lidarr, shelfmark, seerr, all: [radarr, sonarr, lidarr, shelfmark, seerr].map(f => f.adapter) };
    }

    it('asks only the services that may hold the kind, and keeps only that kind', async () => {
        const s = stack();
        const result = await buildSearchMedia(s.all, { source: 'discover', query: 'Paranormal Activity', detail: 'full', limit: 50, kinds: ['movie'] });

        expect(s.radarr.asked).toHaveLength(1);
        expect(s.seerr.asked).toHaveLength(1);
        expect([...s.sonarr.asked, ...s.lidarr.asked, ...s.shelfmark.asked]).toEqual([]);
        expect(result.items.map(h => h.kind)).toEqual(['movie', 'movie']);
        expect(Object.keys(result.counts).sort()).toEqual(['radarr', 'seerr']);
    });

    it('asks everyone without a kind, as before', async () => {
        const s = stack();
        const result = await buildSearchMedia(s.all, { source: 'discover', query: 'Paranormal Activity', detail: 'full', limit: 50 });
        expect(new Set(result.items.map(h => h.kind))).toEqual(new Set(['movie', 'series', 'artist', 'book']));
    });

    it('sends the title without its year and ranks that year first', async () => {
        const original = { kind: 'movie' as const, id: '5', title: 'Paranormal Activity', year: 2009, ids: {} };
        const radarr = fake('radarr', { held: 'movie', hits: [original, film] });
        const result = await buildSearchMedia([radarr.adapter], { query: 'Paranormal Activity 2027', source: 'discover', detail: 'full', limit: 50 });

        expect(radarr.asked).toEqual(['Paranormal Activity']);
        expect(result.items.map(h => h.year)).toEqual([2027, 2009]);
    });

    it('still puts a title that ends in its own number above the shorter one', async () => {
        const radarr = fake('radarr', {
            held: 'movie',
            hits: [
                { kind: 'movie', id: '1', title: 'Wonder Woman', year: 2017, ids: {} },
                { kind: 'movie', id: '2', title: 'Wonder Woman 1984', year: 2020, ids: {} }
            ]
        });
        const result = await buildSearchMedia([radarr.adapter], { query: 'Wonder Woman 1984', source: 'discover', detail: 'full', limit: 50 });
        expect(result.items.map(h => h.title)).toEqual(['Wonder Woman 1984', 'Wonder Woman']);
    });

    it('keeps the year in an indexer search', async () => {
        const prowlarr = fake('prowlarr', { hits: [] });
        await buildSearchMedia([prowlarr.adapter], { query: 'Paranormal Activity 2027', source: 'indexers', detail: 'full', limit: 50 });
        expect(prowlarr.asked).toEqual(['Paranormal Activity 2027']);
    });
});

describe('a library miss explained', () => {
    it('finds the film even when five books and artists outrank it', async () => {
        const noise = Array.from({ length: 5 }, (_, i) => ({ kind: 'book' as const, id: `b${i}`, title: `Paranormal Activity ${'I'.repeat(i + 1)}`, ids: {} }));
        const shelfmark = fake('shelfmark', { held: 'book', hits: noise });
        const radarr = fake('radarr', {
            held: 'movie',
            hits: [{ kind: 'movie', id: '1', title: 'Paranormal Activity: Next of Kin', year: 2021, ids: { tmdb: 1 } }]
        });

        const err = await explainMiss([shelfmark.adapter, radarr.adapter], new NotInLibrary('Paranormal Activity', ''));
        expect(err.message).toContain('Next of Kin');
        expect(shelfmark.asked).toEqual([]);
    });
});

describe('kind on get_queue and get_calendar', () => {
    it('reads only the queue of the services holding that kind, not the download clients', async () => {
        const radarr = fake('radarr', { held: 'movie', queue: true });
        const lidarr = fake('lidarr', { held: 'artist', queue: true });
        const qbit = fake('qbittorrent', { queue: true });

        const result = await buildGetQueue([radarr.adapter, lidarr.adapter, qbit.adapter], { detail: 'standard', limit: 50, kind: 'movie' });
        expect(result.items.map(i => i.service)).toEqual(['radarr']);
        expect([...lidarr.asked, ...qbit.asked]).toEqual([]);
    });

    it('reads every queue without a kind', async () => {
        const radarr = fake('radarr', { held: 'movie', queue: true });
        const qbit = fake('qbittorrent', { queue: true });
        const result = await buildGetQueue([radarr.adapter, qbit.adapter], { detail: 'standard', limit: 50 });
        expect(result.total).toBe(2);
    });

    it('reads only the calendar of the services holding that kind', async () => {
        const radarr = fake('radarr', { held: 'movie', calendar: true });
        const sonarr = fake('sonarr', { held: 'series', calendar: true });
        const result = await buildGetCalendar([radarr.adapter, sonarr.adapter], {
            detail: 'standard',
            limit: 50,
            daysBack: 1,
            daysAhead: 7,
            kind: 'series',
            now: () => new Date('2026-11-09T00:00:00Z')
        });
        expect(result.items.map(i => i.service)).toEqual(['sonarr']);
        expect(radarr.asked).toEqual([]);
    });
});
