import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
import { PlayHistory, playsFrom, type PlayRecord } from '../src/core/playHistory.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import type { PlaybackEntry } from '../src/services/types.ts';

const user = { id: 'u1', name: 'Sam' };

const film = (itemId: string, title: string, lastPlayed?: string): PlaybackEntry => ({
    service: 'jellyfin',
    kind: 'watched',
    source: 'marked_played',
    itemId,
    title,
    user: 'Sam',
    ...(lastPlayed === undefined ? {} : { lastPlayed })
});

const record = (entry: PlaybackEntry, extra: Partial<PlayRecord> = {}): PlayRecord => ({
    entry,
    kind: entry.seriesTitle === undefined ? 'movie' : 'episode',
    ...extra
});

describe('PlayHistory', () => {
    it('keeps a play after the server stops returning it', () => {
        const store = PlayHistory.ephemeral();
        store.record('jellyfin', user, [record(film('a', 'Alpha', '2026-01-01T00:00:00.000Z'))]);
        store.record('jellyfin', user, []);
        expect(store.read('jellyfin', 'u1').map(r => r.entry.itemId)).toEqual(['a']);
    });

    it('reads newest first, undated last, and only for that server and user', () => {
        const store = PlayHistory.ephemeral();
        store.record('jellyfin', user, [
            record(film('old', 'Old', '2025-01-01T00:00:00.000Z')),
            record(film('none', 'Undated')),
            record(film('new', 'New', '2026-01-01T00:00:00.000Z'))
        ]);
        store.record('plex', user, [record(film('p', 'Plex one', '2026-02-01T00:00:00.000Z'))]);
        store.record('jellyfin', { id: 'u2' }, [record(film('k', 'Kim one', '2026-02-01T00:00:00.000Z'))]);
        expect(store.read('jellyfin', 'u1').map(r => r.entry.itemId)).toEqual(['new', 'old', 'none']);
    });

    it('keeps the newest lastPlayed of the two', () => {
        const store = PlayHistory.ephemeral();
        store.record('jellyfin', user, [record(film('a', 'Alpha', '2026-03-01T00:00:00.000Z'))]);
        store.record('jellyfin', user, [record(film('a', 'Alpha', '2026-01-01T00:00:00.000Z'))]);
        expect(store.read('jellyfin', 'u1')[0]?.entry.lastPlayed).toBe('2026-03-01T00:00:00.000Z');
    });

    it('keeps ids and year a later read without them would lose', () => {
        const store = PlayHistory.ephemeral();
        store.record('jellyfin', user, [record(film('a', 'Alpha'), { year: 1999, ids: { tmdb: 603, imdb: 'tt0133093' } })]);
        store.record('jellyfin', user, [record(film('a', 'Alpha', '2026-01-01T00:00:00.000Z'))]);
        const [row] = store.read('jellyfin', 'u1');
        expect(row?.year).toBe(1999);
        expect(row?.ids).toEqual({ tmdb: 603, imdb: 'tt0133093' });
    });

    it('keeps the real title when the item later comes back only as a removed log row', () => {
        const store = PlayHistory.ephemeral();
        store.record('jellyfin', user, [
            record(
                {
                    ...film('a', 'Alpha', '2026-01-01T00:00:00.000Z'),
                    seriesTitle: 'Show',
                    season: 1,
                    episode: 2
                },
                { year: 2010, ids: { tvdb: 7 } }
            )
        ]);
        store.record('jellyfin', user, [
            record({
                service: 'jellyfin',
                kind: 'watched',
                source: 'activity_log',
                removedFromLibrary: true,
                itemId: 'a',
                title: 'Sam has finished playing Alpha',
                user: 'Sam',
                lastPlayed: '2026-02-01T00:00:00.000Z'
            })
        ]);
        const [row] = store.read('jellyfin', 'u1');
        expect(row?.kind).toBe('episode');
        expect(row?.entry).toMatchObject({
            title: 'Alpha',
            seriesTitle: 'Show',
            season: 1,
            episode: 2,
            removedFromLibrary: true,
            lastPlayed: '2026-02-01T00:00:00.000Z'
        });
        expect(row?.year).toBe(2010);
        expect(row?.ids).toEqual({ tvdb: 7 });
    });

    it('drops the removed flag when the item is seen in the library again', () => {
        const store = PlayHistory.ephemeral();
        store.record('jellyfin', user, [record({ ...film('a', 'gone'), source: 'activity_log', removedFromLibrary: true })]);
        store.record('jellyfin', user, [record(film('a', 'Alpha'))]);
        expect(store.read('jellyfin', 'u1')[0]?.entry.removedFromLibrary).toBeUndefined();
    });

    it('keys a row with no item id on its title, so two of them do not collide', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(film('', 'Deleted one')), record(film('', 'Deleted two'))]);
        expect(store.read('plex', 'u1').map(r => r.entry.title).sort()).toEqual(['Deleted one', 'Deleted two']);
    });

    it('summarises per server and user, lists the newest plays, and clears', () => {
        const store = PlayHistory.ephemeral();
        store.record('jellyfin', user, [
            record(film('a', 'Alpha', '2026-01-01T00:00:00.000Z')),
            record(film('b', 'Beta', '2026-03-01T00:00:00.000Z'))
        ]);
        store.record('plex', user, [record({ ...film('c', 'Gamma', '2026-02-01T00:00:00.000Z'), service: 'plex' })]);
        store.markSynced('jellyfin', '2026-03-02T00:00:00.000Z');

        expect(store.summary()).toEqual([
            { server: 'jellyfin', user: 'Sam', plays: 2, lastPlayed: '2026-03-01T00:00:00.000Z' },
            { server: 'plex', user: 'Sam', plays: 1, lastPlayed: '2026-02-01T00:00:00.000Z' }
        ]);
        expect(store.recent(2).map(r => r.entry.itemId)).toEqual(['b', 'c']);
        expect(store.syncs()).toEqual({ jellyfin: '2026-03-02T00:00:00.000Z' });

        store.clear();
        expect(store.summary()).toEqual([]);
        expect(store.syncs()).toEqual({});
    });

    it('survives a reopen of the same file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'plays-'));
        try {
            const first = PlayHistory.open(dir);
            first.record('jellyfin', user, [record(film('a', 'Alpha'))]);
            first.close();
            const second = PlayHistory.open(dir);
            expect(second.read('jellyfin', 'u1')).toHaveLength(1);
            second.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('PlayHistory across a deletion', () => {
    const plexFilm = (itemId: string, title: string, lastPlayed: string): PlaybackEntry => ({ ...film(itemId, title, lastPlayed), service: 'plex' });
    const episode = (itemId: string, lastPlayed: string): PlaybackEntry => ({
        ...plexFilm(itemId, 'Pilot', lastPlayed),
        seriesTitle: 'A Show',
        season: 1,
        episode: 1
    });
    const keys = (store: PlayHistory) => store.read('plex', 'u1').map(r => r.entry.itemId);

    it('folds the title row of a deleted film into the row it had while it existed', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(plexFilm('42', 'Dune', '2026-01-01T00:00:00.000Z'), { year: 2021, ids: { tmdb: 438631 } })]);
        store.record('plex', user, [record(plexFilm('', 'Dune', '2026-02-01T00:00:00.000Z'), { year: 2021 })]);
        const rows = store.read('plex', 'u1');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ year: 2021, ids: { tmdb: 438631 }, entry: { lastPlayed: '2026-02-01T00:00:00.000Z' } });
    });

    it('matches a year either side, since a release date and a library year can differ', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(plexFilm('42', 'Dune', '2026-01-01T00:00:00.000Z'), { year: 2021 })]);
        store.record('plex', user, [record(plexFilm('', 'Dune', '2026-02-01T00:00:00.000Z'), { year: 2020 })]);
        expect(keys(store)).toHaveLength(1);
    });

    it('moves a title row onto the item id when the same film is seen live', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(plexFilm('', 'Dune', '2026-01-01T00:00:00.000Z'), { year: 2021 })]);
        store.record('plex', user, [record(plexFilm('42', 'Dune', '2026-02-01T00:00:00.000Z'), { year: 2021 })]);
        expect(keys(store)).toEqual(['42']);
    });

    it('joins a film added back under a new id to the row it had before its deletion', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(plexFilm('42', 'Dune', '2026-01-01T00:00:00.000Z'), { year: 2021 })]);
        store.record('plex', user, [record(plexFilm('', 'Dune', '2026-02-01T00:00:00.000Z'), { year: 2021 })]);
        store.record('plex', user, [record(plexFilm('99', 'Dune', '2026-03-01T00:00:00.000Z'), { year: 2021 })]);
        expect(keys(store)).toEqual(['99']);
    });

    it('keeps a remake with the same title apart', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(plexFilm('42', 'Dune', '2026-01-01T00:00:00.000Z'), { year: 1984 })]);
        store.record('plex', user, [record(plexFilm('', 'Dune', '2026-02-01T00:00:00.000Z'), { year: 2021 })]);
        expect(keys(store)).toHaveLength(2);
    });

    it('does not join a film with no year to anything, since that is a guess', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(plexFilm('42', 'Dune', '2026-01-01T00:00:00.000Z'), { year: 2021 })]);
        store.record('plex', user, [record(plexFilm('', 'Dune', '2026-02-01T00:00:00.000Z'))]);
        expect(keys(store)).toHaveLength(2);
    });

    it('folds a deleted episode on its series, season and episode number', () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [record(episode('7', '2026-01-01T00:00:00.000Z'))]);
        store.record('plex', user, [record(episode('', '2026-02-01T00:00:00.000Z'))]);
        store.record('plex', user, [record({ ...episode('', '2026-02-01T00:00:00.000Z'), episode: 2 })]);
        expect(keys(store)).toHaveLength(2);
    });

    it('replaces what a server and user hold when asked, and leaves other users alone', () => {
        const store = PlayHistory.ephemeral();
        const other = { id: 'u2', name: 'Kim' };
        store.record('plex', user, [record(plexFilm('t1', 'A Song', '2026-01-01T00:00:00.000Z'))]);
        store.record('plex', other, [record(plexFilm('k1', 'Hers', '2026-01-01T00:00:00.000Z'))]);
        store.record('plex', user, [record(plexFilm('42', 'Dune', '2026-01-01T00:00:00.000Z'))], { replace: true });
        expect(keys(store)).toEqual(['42']);
        expect(store.read('plex', 'u2')).toHaveLength(1);
    });

    it('remembers the full read per server and user, and forgets it on clear', () => {
        const store = PlayHistory.ephemeral();
        expect(store.needsBackfill('plex', 'u1')).toBe(true);
        store.markBackfilled('plex', 'u1', '2026-01-01T00:00:00.000Z');
        expect(store.needsBackfill('plex', 'u1')).toBe(false);
        expect(store.needsBackfill('plex', 'u2')).toBe(true);
        store.clear();
        expect(store.needsBackfill('plex', 'u1')).toBe(true);
    });
});

describe('playsFrom', () => {
    const libraryFilm = (itemId: string, title: string, watched: boolean, extra: Partial<IndexInput> = {}): IndexInput => ({
        kind: 'movie',
        title,
        year: 1999,
        ids: { tmdb: 603, imdb: 'tt0133093' },
        playback: { user: 'Sam', itemId, watched },
        ...extra
    });

    it('takes a film play its ids and year from the library row with the same item id', () => {
        const [play] = playsFrom('jellyfin', user, [film('a', 'Alpha', '2026-01-01T00:00:00.000Z')], [libraryFilm('a', 'Alpha', true)]);
        expect(play).toMatchObject({ kind: 'movie', year: 1999, ids: { tmdb: 603, imdb: 'tt0133093' } });
    });

    it("gives a deleted film its history row's release year, and keeps that field out of the stored row", () => {
        const [play] = playsFrom('plex', user, [{ ...film('', 'Gone'), releaseYear: 2021 }], []);
        expect(play).toMatchObject({ kind: 'movie', year: 2021 });
        expect(play?.entry).not.toHaveProperty('releaseYear');
    });

    it('calls a deleted row with no series and no release year unknown, not a film', () => {
        const [play] = playsFrom('plex', user, [film('', 'Pilot')], []);
        expect(play?.kind).toBe('unknown');
    });

    it("prefers the library's year over the history row's", () => {
        const [play] = playsFrom('jellyfin', user, [{ ...film('a', 'Alpha'), releaseYear: 2001 }], [libraryFilm('a', 'Alpha', true)]);
        expect(play?.year).toBe(1999);
    });

    it("gives an episode its series' ids, matched on the series title", () => {
        const series: IndexInput = { kind: 'series', title: 'The Show', year: 2010, ids: { tvdb: 42 }, playback: { user: 'Sam', itemId: 's' } };
        const [play] = playsFrom('jellyfin', user, [{ ...film('e', 'Pilot'), seriesTitle: 'the show', season: 1, episode: 1 }], [series]);
        expect(play).toMatchObject({ kind: 'episode', year: 2010, ids: { tvdb: 42 } });
    });

    it('matches the series when each title is fenced under a different field', () => {
        const series: IndexInput = {
            kind: 'series',
            title: fenceText('The Show', { service: 'jellyfin', field: 'Name' }),
            ids: { tvdb: 42 },
            playback: { user: 'Sam', itemId: 's' }
        };
        const episode = { ...film('e', 'Pilot'), seriesTitle: fenceText('The Show', { service: 'jellyfin', field: 'SeriesName' }) };
        expect(playsFrom('jellyfin', user, [episode], [series])[0]?.ids).toEqual({ tvdb: 42 });
    });

    it('calls a play first seen after its deletion unknown, not a film', () => {
        const removed = { ...film('x', 'Sam has finished playing something'), source: 'activity_log' as const, removedFromLibrary: true as const };
        expect(playsFrom('jellyfin', user, [removed], [])[0]?.kind).toBe('unknown');
    });

    it('adds watched films the history did not return, and leaves unwatched ones out', () => {
        const plays = playsFrom('jellyfin', user, [], [
            libraryFilm('w', 'Watched', true, { playback: { user: 'Sam', itemId: 'w', watched: true, lastPlayed: '2024-05-01T00:00:00.000Z' } }),
            libraryFilm('n', 'Not watched', false)
        ]);
        expect(plays).toHaveLength(1);
        expect(plays[0]).toMatchObject({
            kind: 'movie',
            year: 1999,
            entry: { service: 'jellyfin', kind: 'watched', source: 'marked_played', itemId: 'w', title: 'Watched', user: 'Sam', lastPlayed: '2024-05-01T00:00:00.000Z' }
        });
    });

    it('does not add a watched film twice when the history already has it', () => {
        expect(playsFrom('jellyfin', user, [film('a', 'Alpha')], [libraryFilm('a', 'Alpha', true)])).toHaveLength(1);
    });
});
