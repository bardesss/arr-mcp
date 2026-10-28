import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { LIBRARY_TTL_MS, TtlCache } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import type { IndexInput } from '../core/resolver.ts';
import { readProfileNames } from './arrAdd.ts';
import { arrVersion } from './arrSystem.ts';
import {
    diagnoseConnection,
    type ArtistMonitorCapable,
    type ArtistMonitorNewItems,
    type ArtistMonitorPolicy,
    type ConnectionDiagnosis,
    type LibraryCapable,
    type MonitoringCapable,
    type MonitoringTarget,
    type MonitorState,
    type MonitorStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
} from './types.ts';

/**
 * Whether Lidarr named a policy this code knows. Anything else stays `unknown`
 * rather than being read as the safe value.
 */
const isKnownNewItems = (value: string | undefined): value is ArtistMonitorNewItems =>
    value === 'all' || value === 'none' || value === 'new';

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
    artist?: { id?: number; artistName?: string; qualityProfileId?: number; path?: string };
};

type RawArtist = {
    id?: number;
    artistName?: string;
    monitored?: boolean;
    monitorNewItems?: string;
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
 * Lidarr. It claims `LibraryCapable`, `SearchCapable` and `MonitoringCapable`.
 * `CONTRIBUTING.md` lists the API traps for the adapter that adds the next
 * write, and the endpoints still waiting on a library with real activity.
 *
 * An album is the row rather than a track or an artist, for the reason Radarr
 * and Sonarr row on a film and a series: it is the level Lidarr reports
 * monitoring, file state and a release date at, and it is the level a person
 * asks about. The artist name rides along on the row, so an artist-level
 * question is a filter rather than a second kind.
 */
export class LidarrAdapter
    implements ServiceAdapter, LibraryCapable, SearchCapable, MonitoringCapable, MonitorStateCapable, ArtistMonitorCapable
{
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
                // Lidarr's internal artist id, so an artist-level write has an
                // address to take. Omitted, not zeroed, when the row has none.
                ...(artist?.id === undefined || artist.id <= 0 ? {} : { artistId: String(artist.id) }),
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

    /**
     * The two facts `set_monitoring` needs about one album, read from the album
     * itself rather than from the whole-library cache: a write must preview
     * against what Lidarr holds *now*, and a stale TTL row would let a stale
     * `monitored` stand in for the truth and report a real change as a no-op.
     */
    async getMonitorState(id: string): Promise<MonitorState> {
        const albumId = this.#numericId(id, 'album');
        const album = await this.#http.get<RawAlbum>(`/api/v1/album/${albumId}`);
        const title = fenceText(album.title ?? '', { service: this.id, field: 'title' });
        const artist = album.artist?.artistName;
        const year = yearOf(album.releaseDate);

        return {
            label: `${title}${artist === undefined ? '' : ` — ${fenceText(artist, { service: this.id, field: 'artist' })}`}${
                year === undefined ? '' : ` (${year})`
            }`,
            monitored: album.monitored ?? false
        };
    }

    /**
     * One album's own flag, via the endpoint built for it. Lidarr's album monitor
     * route takes a list; a single id is the one-element case rather than a
     * special one, so the bulk form stays available without a second path.
     *
     * `season` and `episodeIds` are refused rather than ignored: an album has
     * neither, and a write that accepted them would report success while having
     * monitored the whole album the caller meant to leave alone.
     */
    async setMonitoring(id: string, opts: MonitoringTarget): Promise<void> {
        if (opts.season !== undefined || opts.episodeIds !== undefined) {
            throw new ServiceError('NotFound', this.id, 'A Lidarr album has no seasons and no episode ids', {
                remedy: 'An album is monitored whole: send only `monitored`. Track-level selection is not a Lidarr concept.'
            });
        }

        const albumId = this.#numericId(id, 'album');
        await this.#http.put('/api/v1/album/monitor', { albumIds: [albumId], monitored: opts.monitored }, true);
        this.#libraryCache.clear();
    }

    /**
     * Every artist's standing policy. Read whole rather than one at a time: the
     * question is always "is anything still set to auto-monitor", which is a
     * question about the set, and Lidarr has no filtered artist read.
     */
    async listArtistMonitorPolicies(): Promise<ArtistMonitorPolicy[]> {
        const artists = await this.#http.get<RawArtist[]>('/api/v1/artist');

        return artists
            .filter((a): a is RawArtist & { id: number } => typeof a.id === 'number' && a.id > 0)
            .map(a => ({
                artistId: String(a.id),
                artistName: fenceText(a.artistName ?? '', { service: this.id, field: 'artist' }),
                monitored: a.monitored ?? false,
                monitorNewItems: isKnownNewItems(a.monitorNewItems) ? a.monitorNewItems : 'unknown'
            }));
    }

    /**
     * Lidarr's Artist Editor, which is the bulk path: one call reaches every
     * artist named, which is the only way a library of a thousand artists reaches
     * a stable policy without a thousand writes.
     *
     * An empty list issues nothing, for the same reason `deleteEpisodeFiles`
     * gives: an editor call naming no artist is a request with no purpose, and
     * Lidarr's behaviour for it is not worth discovering against a live library.
     */
    async setArtistMonitorPolicy(
        artistIds: string[],
        policy: { monitored?: boolean; monitorNewItems?: ArtistMonitorNewItems }
    ): Promise<void> {
        if (artistIds.length === 0) return;

        const ids = artistIds.map(id => this.#numericId(id, 'artist'));
        await this.#http.put(
            '/api/v1/artist/editor',
            {
                artistIds: ids,
                ...(policy.monitored === undefined ? {} : { monitored: policy.monitored }),
                ...(policy.monitorNewItems === undefined ? {} : { monitorNewItems: policy.monitorNewItems })
            },
            true
        );
        this.#libraryCache.clear();
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    #numericId(value: string, what: string): number {
        const id = Number(value);
        if (!Number.isInteger(id)) {
            throw new ServiceError('NotFound', this.id, `"${value}" is not a Lidarr ${what} id`, {
                remedy: `Lidarr ${what} ids are integers. Take one from \`acquisition.id\` on get_library.`
            });
        }
        return id;
    }
}
