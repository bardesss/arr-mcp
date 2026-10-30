/**
 * Lidarr row scrubbing and path building for `capture-fixtures.ts`, split out so
 * it can be unit tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 * Same reason `plexCapture.ts` exists.
 *
 * Fixture policy is titles in, people out. Titles, mount paths and external ids
 * are published as the Radarr and Sonarr blocks publish theirs. The exceptions
 * are `artist.members[]` and `overview`, which name real people, and cover-art
 * URLs, which resolve to the release and embed the slug.
 */
import { anonymiseImages, ANONYMOUS_URL, isRow, replaceIfString, type Row } from './redact.ts';

/** A band credits people, not characters. */
export const anonymiseLidarrMembers = (members: unknown): unknown =>
    Array.isArray(members)
        ? (members as Row[]).map((member, i) => ({
              ...member,
              ...(member.name === undefined ? {} : { name: replaceIfString(member.name, `Member ${i + 1}`) }),
              ...(member.instrument === undefined
                  ? {}
                  : { instrument: replaceIfString(member.instrument, `Instrument ${i + 1}`) }),
              ...(member.images === undefined ? {} : { images: anonymiseImages(member.images) })
          }))
        : members;

/**
 * A MusicBrainz biography names the band's members, their instruments and their
 * home town. An empty one is left alone: most rows carry `""`, and filling that
 * would invent text the service did not send.
 */
const scrubOverview = (row: Row, placeholder: string): Row =>
    typeof row.overview === 'string' && row.overview !== '' ? { overview: placeholder } : {};

/**
 * `ArtistResource`. `lastAlbum` and `nextAlbum` are whole albums, each carrying
 * an artist again, so both scrubbers recurse. A field is replaced only when the
 * response carried it.
 */
export const anonymiseLidarrArtist = (row: Row): Row => ({
    ...row,
    ...scrubOverview(row, 'An artist.'),
    ...(row.images === undefined ? {} : { images: anonymiseImages(row.images) }),
    ...(row.remotePoster === undefined ? {} : { remotePoster: replaceIfString(row.remotePoster, ANONYMOUS_URL) }),
    ...(row.members === undefined ? {} : { members: anonymiseLidarrMembers(row.members) }),
    ...(isRow(row.lastAlbum) ? { lastAlbum: anonymiseLidarrAlbum(row.lastAlbum) } : {}),
    ...(isRow(row.nextAlbum) ? { nextAlbum: anonymiseLidarrAlbum(row.nextAlbum) } : {})
});

/** `AlbumResource`, and the `artist` it nests, which carries its albums again. */
export const anonymiseLidarrAlbum = (row: Row): Row => ({
    ...row,
    ...scrubOverview(row, 'An album.'),
    ...(row.images === undefined ? {} : { images: anonymiseImages(row.images) }),
    ...(row.remoteCover === undefined ? {} : { remoteCover: replaceIfString(row.remoteCover, ANONYMOUS_URL) }),
    ...(isRow(row.artist) ? { artist: anonymiseLidarrArtist(row.artist) } : {})
});

/** `QueueResource` nests both an `artist` and an `album`. */
export const anonymiseLidarrQueueRow = (row: Row): Row => ({
    ...row,
    ...(isRow(row.artist) ? { artist: anonymiseLidarrArtist(row.artist) } : {}),
    ...(isRow(row.album) ? { album: anonymiseLidarrAlbum(row.album) } : {})
});

/** `HistoryResource` nests a third object, and `track.artist` survives an artist-and-album scrub. */
export const anonymiseLidarrHistoryRow = (row: Row): Row => {
    const track = isRow(row.track) ? row.track : undefined;
    return {
        ...anonymiseLidarrQueueRow(row),
        ...(track === undefined
            ? {}
            : { track: { ...track, ...(isRow(track.artist) ? { artist: anonymiseLidarrArtist(track.artist) } : {}) } })
    };
};

/** `BlocklistResource` carries `artist` and an `albumIds` array, with no nested album. */
export const anonymiseLidarrBlocklistRow = (row: Row): Row => ({
    ...row,
    ...(isRow(row.artist) ? { artist: anonymiseLidarrArtist(row.artist) } : {})
});

/**
 * Capture paths that need nothing from an earlier response, keyed by fixture
 * name. A literal object, so a typo in a key is a compile error rather than an
 * `undefined` path. `test/scriptsLidarrCapture.test.ts` checks every value and
 * every query parameter against `specs/lidarr.json`.
 */
export const LIDARR_STATIC_PATHS = {
    'system-status': '/api/v1/system/status',
    diskspace: '/api/v1/diskspace',
    health: '/api/v1/health',
    'system-task': '/api/v1/system/task',
    command: '/api/v1/command',
    // `includeArtist` and `includeAlbum` both default to false. Omitted, rows
    // arrive flat and the row scrubbers above find nothing. Still HTTP 200.
    queue: '/api/v1/queue?includeUnknownArtistItems=true&includeArtist=true&includeAlbum=true',
    blocklist: '/api/v1/blocklist?page=1&pageSize=10',
    calendar: '/api/v1/calendar',
    artist: '/api/v1/artist',
    // A neutral term: the query string is captured alongside the results.
    'artist-lookup': '/api/v1/artist/lookup?term=artist',
    'wanted-missing': '/api/v1/wanted/missing?page=1&pageSize=10&includeArtist=true',
    'wanted-cutoff': '/api/v1/wanted/cutoff?page=1&pageSize=10',
    history: '/api/v1/history?page=1&pageSize=10',
    rootfolder: '/api/v1/rootfolder',
    qualityprofile: '/api/v1/qualityprofile',
    // Lidarr's second profile type: it decides which album types and release
    // statuses get monitored at all.
    metadataprofile: '/api/v1/metadataprofile',
    tag: '/api/v1/tag',
    indexer: '/api/v1/indexer'
} as const satisfies Record<string, string>;

export const lidarrArtistDetailPath = (artistId: number | string): string => `/api/v1/artist/${artistId}`;

/**
 * `artistId` is singular, and a plural is not a typo it forgives: an undeclared
 * `artistIds` is ignored and answers every album in the library.
 * `includeAllArtistAlbums` has no description upstream.
 */
export const lidarrAlbumPath = (artistId: number | string): string =>
    `/api/v1/album?artistId=${artistId}&includeAllArtistAlbums=true`;

/** The GET filters on `albumId` or `artistId`. `guid` belongs to the POST that grabs. */
export const lidarrReleasePath = (albumId: number | string): string => `/api/v1/release?albumId=${albumId}`;

/**
 * A calendar window spanning the library's own release dates, padded a day each
 * side. Only monitored releases appear, so an unmonitored artist answers `[]`.
 * With no dates to work from, fall back to a year back and six months forward.
 */
export const lidarrCalendarPath = (albums: readonly { releaseDate?: string | null }[]): string => {
    const dates = albums
        .map(a => a.releaseDate)
        .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d))
        .map(d => d.slice(0, 10))
        .sort();

    const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const shift = (iso: string, days: number): string =>
        new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

    const first = dates.at(0);
    const last = dates.at(-1);
    return first === undefined || last === undefined
        ? `/api/v1/calendar?start=${day(-365)}&end=${day(180)}`
        : `/api/v1/calendar?start=${shift(first, -1)}&end=${shift(last, 1)}`;
};
