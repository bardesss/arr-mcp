import { describe, expect, it } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
import { listText } from '../src/core/shape.ts';
import { blocklistLine } from '../src/tools/getBlocklist.ts';
import { calendarLine } from '../src/tools/getCalendar.ts';
import { historyLine } from '../src/tools/getHistory.ts';
import { indexerLine } from '../src/tools/getIndexers.ts';
import { libraryLine } from '../src/tools/getLibrary.ts';
import { metadataIssueLine } from '../src/tools/getMetadataIssues.ts';
import { playbackLine } from '../src/tools/getPlayback.ts';
import { queueLine } from '../src/tools/getQueue.ts';
import { releaseLine } from '../src/tools/getReleases.ts';
import { requestLine } from '../src/tools/getRequests.ts';
import { subtitleLine } from '../src/tools/getSubtitles.ts';
import { wantedLine } from '../src/tools/getWanted.ts';
import { searchLine } from '../src/tools/searchMedia.ts';

/**
 * #234: every list tool put its count in the text `content` block and its items
 * only in `structuredContent`, so a client that forwards one and not the other
 * could not name a single thing in the library it had just successfully read.
 *
 * The contract each formatter owes, asserted per tool rather than per field:
 * the line names the item, and it carries the id a follow-up call needs. The
 * exact wording is free to change — pinning it word for word would make this
 * a change-detector rather than a test.
 */

const fenced = (title: string, service = 'radarr'): string => fenceText(title, { service, field: 'title' });

/** Every formatter under one name, with a representative item apiece. */
const CASES: { tool: string; text: string; names: string; id: string }[] = [
    {
        tool: 'get_library',
        text: libraryLine({
            kind: 'movie',
            title: fenced('Inception'),
            year: 2010,
            ids: { tmdb: 27205 },
            acquisition: { service: 'radarr', id: '412', monitored: true, hasFile: true }
        } as never),
        names: 'Inception',
        id: 'radarr:412'
    },
    {
        tool: 'search_media',
        text: searchLine({
            service: 'sonarr',
            source: 'library',
            kind: 'series',
            id: '31',
            title: fenced('Severance', 'sonarr'),
            year: 2022,
            ids: { tvdb: 371980 }
        } as never),
        names: 'Severance',
        id: 'sonarr:31'
    },
    {
        tool: 'get_queue',
        text: queueLine({
            service: 'radarr',
            id: '9',
            title: fenced('Dune'),
            status: 'downloading',
            importState: 'importBlocked'
        } as never),
        names: 'Dune',
        id: 'radarr:9'
    },
    {
        tool: 'get_calendar',
        text: calendarLine({
            service: 'sonarr',
            kind: 'episode',
            id: 44,
            title: fenced('Pilot', 'sonarr'),
            seriesTitle: fenced('Some Show', 'sonarr'),
            season: 1,
            episode: 2,
            date: '2026-09-20',
            hasFile: false,
            monitored: true
        } as never),
        names: 'Some Show',
        id: 'sonarr:44'
    },
    {
        tool: 'get_history',
        text: historyLine({
            service: 'radarr',
            id: 'h1',
            at: '2026-09-01T00:00:00Z',
            event: 'grabbed',
            title: fenced('Arrival'),
            mediaId: '88'
        } as never),
        names: 'Arrival',
        id: 'radarr:88'
    },
    {
        tool: 'get_blocklist',
        text: blocklistLine({
            service: 'radarr',
            id: '5',
            title: fenced('Some Release'),
            at: '2026-09-01T00:00:00Z',
            reason: fenced('Unknown quality', 'radarr')
        } as never),
        names: 'Some Release',
        id: 'radarr:5'
    },
    {
        tool: 'get_wanted',
        text: wantedLine({
            service: 'sonarr',
            kind: 'series',
            id: '31',
            title: fenced('Some Show', 'sonarr'),
            season: 2,
            episode: 5,
            monitored: true
        } as never),
        names: 'Some Show',
        id: 'sonarr:31'
    },
    {
        tool: 'get_subtitles',
        text: subtitleLine({
            service: 'bazarr',
            kind: 'episode',
            id: 77,
            title: fenced('Some Show', 'bazarr'),
            season: 1,
            episode: 1,
            missing: [{ name: 'English', code2: 'en', forced: false, hearingImpaired: false }]
        } as never),
        names: 'Some Show',
        id: 'bazarr:77'
    },
    {
        tool: 'get_indexers',
        text: indexerLine({
            service: 'prowlarr',
            id: 3,
            name: fenceText('Some Indexer', { service: 'prowlarr', field: 'name' }),
            enabled: true,
            protocol: 'usenet',
            priority: 25
        } as never),
        names: 'Some Indexer',
        id: 'prowlarr:3'
    },
    {
        tool: 'get_releases',
        text: releaseLine({
            service: 'radarr',
            indexer: fenceText('Some Indexer', { service: 'radarr', field: 'indexer' }),
            title: fenced('Some.Release.2026.1080p'),
            rejected: false,
            seeders: 12
        } as never),
        names: 'Some.Release.2026.1080p',
        id: 'Some Indexer'
    },
    {
        tool: 'get_requests',
        text: requestLine({
            service: 'seerr',
            id: 7,
            status: 'pending',
            mediaType: 'movie',
            title: fenced('Nope', 'seerr'),
            tmdbId: 762504,
            requestedBy: 'Bartus'
        } as never),
        names: 'Nope',
        id: 'seerr:7'
    },
    {
        tool: 'get_playback',
        text: playbackLine({
            service: 'jellyfin',
            kind: 'now_playing',
            itemId: 'abc',
            title: fenced('Pilot', 'jellyfin'),
            seriesTitle: fenced('Some Show', 'jellyfin'),
            season: 1,
            episode: 1,
            user: 'Bartus',
            percentComplete: 42.4
        } as never),
        names: 'Some Show',
        id: 'Bartus'
    },
    {
        tool: 'get_metadata_issues',
        text: metadataIssueLine({
            service: 'jellyfin',
            itemId: 'xyz',
            kind: 'series',
            title: fenced('Some Show', 'jellyfin'),
            mismatches: 3,
            remedy: 'refresh',
            fix: 'fix_metadata({ item_id: "xyz" })'
        } as never),
        names: 'Some Show',
        id: 'jellyfin:xyz'
    }
];

describe('every list tool names its items in the text block', () => {
    for (const { tool, text, names, id } of CASES) {
        it(`${tool} names the item`, () => {
            expect(text).toContain(names);
        });

        it(`${tool} carries the id a follow-up call needs`, () => {
            expect(text).toContain(id);
        });

        /**
         * The fence is the "this is service data, not instruction" marker, and
         * the text block is the half a client puts straight in front of the
         * model — so it is the last place to drop it. `unfenced()` is for
         * matching and sorting, never for output.
         */
        it(`${tool} keeps the untrusted-data fence around the title`, () => {
            expect(text).toContain('<<untrusted:');
            expect(text).toContain('<</untrusted>>');
        });

        it(`${tool} stays on one line`, () => {
            expect(listText('summary.', [0], () => text).split('\n')).toHaveLength(2);
        });
    }
});
