import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import type { IndexInput } from '../core/resolver.ts';
import { readProfileNames } from './arrAdd.ts';
import { arrVersion } from './arrSystem.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type LibraryCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
} from './types.ts';

/**
 * The fields `listLibrary` reads. Named after `AlbumResource` in
 * `specs/lidarr.json`; anything not listed here is not needed by that mapper.
 */
type RawAlbum = {
    id?: number;
    title?: string;
    foreignAlbumId?: string;
    releaseDate?: string | null;
    albumType?: string;
    monitored?: boolean;
    genres?: string[];
    statistics?: { trackFileCount?: number; sizeOnDisk?: number };
    artist?: { artistName?: string; qualityProfileId?: number; path?: string };
};

const yearOf = (releaseDate: string | null | undefined): number | undefined => {
    if (typeof releaseDate !== 'string') return undefined;
    const match = /^(\d{4})-\d{2}-\d{2}/.exec(releaseDate);
    return match?.[1] === undefined ? undefined : Number(match[1]);
};

/**
 * The album's own MusicBrainz id, and the only external id Lidarr reports.
 * Nothing is invented as a fallback: the internal `id` is Lidarr's, and
 * publishing it as an external id would let an album fuse with a film that
 * happens to carry the same integer.
 */
const albumIds = (album: RawAlbum): IndexInput['ids'] =>
    album.foreignAlbumId === undefined || album.foreignAlbumId === '' ? {} : { mbid: album.foreignAlbumId };

/** Any track on disk, which is what `has_file` means for a series too. */
const hasAnyTrack = (album: RawAlbum): boolean => (album.statistics?.trackFileCount ?? 0) > 0;

/**
 * Lidarr. It claims `LibraryCapable` and nothing else, so `get_library` lists
 * albums and no tool writes to it. `CONTRIBUTING.md` lists the API traps for the
 * adapter that adds a write, and the endpoints still waiting on a library with
 * real activity.
 *
 * An album is the row rather than a track or an artist, for the reason Radarr
 * and Sonarr row on a film and a series: it is the level Lidarr reports
 * monitoring, file state and a release date at, and it is the level a person
 * asks about. The artist name rides along on the row, so an artist-level
 * question is a filter rather than a second kind.
 */
export class LidarrAdapter implements ServiceAdapter, LibraryCapable, SearchCapable {
    readonly type: ServiceId = 'lidarr';
    readonly instance: string | undefined = undefined;
    readonly id: string = 'lidarr';

    readonly #http: ServiceHttp;

    /** The whole-album read, shared by every `listLibrary` in a snapshot. */
    readonly #libraryCache = new TtlCache();

    constructor(config: ConfigByService['lidarr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl, '/api/v1');
    }

    async getVersion(): Promise<string> {
        return arrVersion(this.#http, this.id);
    }

    /**
     * Every album in the library, unfiltered. `artistId` would narrow it to one
     * artist and was for the capture, not for this.
     */
    #allAlbums(): Promise<RawAlbum[]> {
        return this.#libraryCache.get('albums', LIBRARY_TTL_MS, () => this.#http.get<RawAlbum[]>('/api/v1/album'));
    }

    invalidateLibrary(): void {
        this.#libraryCache.clear();
    }

    async listLibrary(): Promise<IndexInput[]> {
        const [albums, profileNames] = await Promise.all([this.#allAlbums(), readProfileNames(this.#http, this.id, this.#libraryCache)]);

        return albums.map(album => {
            const artist = album.artist;
            const qualityProfileId = artist?.qualityProfileId;
            return {
                kind: 'album' as const,
                title: fenceText(album.title ?? '', { service: this.id, field: 'title' }),
                ...(artist?.artistName === undefined
                    ? {}
                    : { artist: fenceText(artist.artistName, { service: this.id, field: 'artist' }) }),
                ...((year => (year === undefined ? {} : { year }))(yearOf(album.releaseDate))),
                ...(album.genres === undefined
                    ? {}
                    : { genres: album.genres.map(g => fenceText(g, { service: this.id, field: 'genre' })) }),
                ids: albumIds(album),
                acquisition: {
                    service: this.id,
                    ...(album.id === undefined || album.id <= 0 ? {} : { id: String(album.id) }),
                    // Lidarr has no run status. `albumType` is the service's own
                    // word for what this is, passed through unnormalised.
                    ...(album.albumType === undefined ? {} : { status: album.albumType }),
                    monitored: album.monitored ?? false,
                    // An album with only some tracks imported reads as present,
                    // as a part-downloaded series does; `statistics` carries
                    // `percentOfTracks` for how complete it is. There is no
                    // album-level quality, which is why that filter stays
                    // films-only.
                    hasFile: hasAnyTrack(album),
                    ...(qualityProfileId === undefined ? {} : { qualityProfileId }),
                    ...((name => (name === undefined ? {} : { qualityProfile: name }))(
                        qualityProfileId === undefined ? undefined : profileNames.get(qualityProfileId)
                    )),
                    // The artist's folder, which every album by that artist
                    // shares. Lidarr keeps the album one level below, and
                    // `AlbumResource` carries no path of its own.
                    ...(artist?.path === undefined ? {} : { path: fenceText(artist.path, { service: this.id, field: 'path' }) }),
                    ...(album.statistics?.sizeOnDisk === undefined
                        ? {}
                        : { sizeBytes: album.statistics.sizeOnDisk })
                }
            };
        });
    }

    /**
     * `library` only. Lidarr's lookup endpoints return artists to add, and
     * nothing here adds music, so a discover search has no honest answer and
     * returns none.
     *
     * Matched on the artist as well as the title, unlike Radarr and Sonarr.
     * "Do I have any Daft Punk" is a library question, and an album row is
     * where the answer lives.
     */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];

        const term = query.toLowerCase();
        const albums = await this.#allAlbums();

        return albums
            // A row with no usable id is one nothing can be asked about, so it
            // is not a hit — every other field on it would still be right.
            .filter(album => (album.id ?? 0) > 0)
            .filter(album => {
                const title = (album.title ?? '').toLowerCase();
                const artist = (album.artist?.artistName ?? '').toLowerCase();
                return title.includes(term) || artist.includes(term);
            })
            .map(album => ({
                service: this.id,
                source,
                kind: 'album' as const,
                id: String(album.id),
                title: fenceText(album.title ?? '', { service: this.id, field: 'title' }),
                ...((year => (year === undefined ? {} : { year }))(yearOf(album.releaseDate))),
                ids: albumIds(album),
                hasFile: hasAnyTrack(album),
                monitored: album.monitored ?? false
            }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
