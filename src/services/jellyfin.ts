import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import type { IndexInput } from '../core/resolver.ts';
import { embyToken } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type MediaDetailCapable,
    type MediaDetails,
    type PlaybackEntry,
    type ScanState,
    type ScanStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter,
    type ServiceUser,
    type UserDirectoryCapable,
    type UserLibraryCapable
} from './types.ts';

/**
 * Jellyfin's generated types are a megabyte of declarations and its PascalCase
 * field names are stable across releases, so these three narrow shapes are
 * declared locally. The contract test checks them against the vendored spec,
 * which is where that checking belongs.
 */
type RawSystemInfo = { Version?: string; ServerName?: string; Id?: string };
type RawUser = { Id?: string; Name?: string };
type RawTask = {
    Key?: string;
    Name?: string;
    State?: string;
    LastExecutionResult?: { EndTimeUtc?: string; Status?: string };
};

/**
 * The task Jellyfin runs to scan libraries, confirmed against a live 10.11.11.
 *
 * Keyed on `Key`, never on `Name`, for two independent reasons. A live server
 * exposes eight library-ish keys including `LanguageTagsSetsRefreshLibraryTask`
 * and `TraktSyncLibraryTask`, so a pattern would match the wrong one — and
 * `Name` is **localised to the server language**. The instance this was
 * captured from returns "Mediabibliotheek scannen".
 */
const LIBRARY_SCAN_KEY = 'RefreshLibrary';

type RawItem = {
    Id?: string;
    Name?: string;
    SeriesName?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    RunTimeTicks?: number;
    UserData?: { PlaybackPositionTicks?: number; LastPlayedDate?: string };
};
type RawSession = {
    UserId?: string;
    UserName?: string;
    DeviceName?: string;
    NowPlayingItem?: RawItem;
    PlayState?: { PositionTicks?: number };
};
type RawItemsPage = { Items?: RawItem[] };

/** Jellyfin measures time in 100-nanosecond ticks. Nothing else in the stack does. */
const TICKS_PER_SECOND = 10_000_000;
const ticksToSeconds = (ticks: number | undefined): number | undefined =>
    typeof ticks === 'number' ? Math.round(ticks / TICKS_PER_SECOND) : undefined;

type RawItemDetail = {
    Id?: string;
    Name?: string;
    ProductionYear?: number;
    Overview?: string;
    Path?: string;
    Type?: string;
    ProviderIds?: { Tmdb?: string; Tvdb?: string; Imdb?: string };
    MediaSources?: { Size?: number }[];
    Genres?: string[];
    UserData?: { Played?: boolean; PlayCount?: number; LastPlayedDate?: string };
};

/**
 * Jellyfin stores external ids as **strings** while Radarr and Sonarr use
 * numbers. Phase 3's identity resolver joins on tmdbId and tvdbId, so a string
 * here would silently fail every join — convert at the boundary.
 */
const numericId = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

export class JellyfinAdapter
    implements
        ServiceAdapter,
        ScanStateCapable,
        UserDirectoryCapable,
        MediaDetailCapable,
        SearchCapable,
        UserLibraryCapable
{
    readonly id: ServiceId = 'jellyfin';
    readonly #http: ServiceHttp;

    constructor(config: MultiUserServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('jellyfin', config, embyToken(config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const info = await this.#http.get<RawSystemInfo>('/System/Info');
        if (!info.Version) {
            throw new ServiceError('UpstreamError', this.id, 'System/Info returned no version field');
        }
        return info.Version;
    }

    /**
     * Jellyfin identifies users by GUID while config names them by username, so
     * every per-user call resolves through this list. Typing a username by hand
     * is a guaranteed source of silent mismatches (design spec §14), which is
     * why the resolver reports the available names on a miss.
     */
    async listUsers(): Promise<ServiceUser[]> {
        const users = await this.#http.get<RawUser[]>('/Users');
        return users
            .filter((u): u is { Id: string; Name: string } => typeof u.Id === 'string' && typeof u.Name === 'string')
            .map(u => ({ id: u.Id, name: u.Name }));
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.get<RawTask[]>('/ScheduledTasks');
        const scan = tasks.find(t => t.Key === LIBRARY_SCAN_KEY);
        const lastCompleted = scan?.LastExecutionResult?.EndTimeUtc;
        return {
            service: this.id,
            running: scan?.State === 'Running',
            ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
        };
    }

    /**
     * Sessions are global — an admin key sees the whole household — so they are
     * filtered to the resolved user here. The identity gate has already decided
     * that this user may be queried; this is the mechanical narrowing, not the
     * authorization decision.
     */
    async getPlayback(user: ServiceUser): Promise<PlaybackEntry[]> {
        const fence = (field: string, value: string) => fenceText(value, { service: this.id, field });

        const [sessions, resume] = await Promise.all([
            this.#http.get<RawSession[]>('/Sessions'),
            this.#http.get<RawItemsPage>(`/Users/${encodeURIComponent(user.id)}/Items/Resume`)
        ]);

        const common = (item: RawItem) => ({
            service: this.id,
            itemId: item.Id ?? '',
            title: fence('Name', item.Name ?? ''),
            ...(item.SeriesName === undefined ? {} : { seriesTitle: fence('SeriesName', item.SeriesName) }),
            ...(item.ParentIndexNumber === undefined ? {} : { season: item.ParentIndexNumber }),
            ...(item.IndexNumber === undefined ? {} : { episode: item.IndexNumber }),
            user: user.name
        });

        const progress = (position: number | undefined, runtime: number | undefined) => ({
            ...(position === undefined ? {} : { positionSeconds: position }),
            ...(runtime === undefined ? {} : { runtimeSeconds: runtime }),
            // Guarded against a zero runtime, which would divide to Infinity.
            ...(position !== undefined && runtime !== undefined && runtime > 0
                ? { percentComplete: Math.round((position / runtime) * 100) }
                : {})
        });

        const nowPlaying: PlaybackEntry[] = sessions
            .filter(s => s.UserId === user.id && s.NowPlayingItem !== undefined)
            .map(s => {
                const item = s.NowPlayingItem as RawItem;
                return {
                    ...common(item),
                    kind: 'now_playing' as const,
                    ...progress(ticksToSeconds(s.PlayState?.PositionTicks), ticksToSeconds(item.RunTimeTicks)),
                    ...(s.DeviceName === undefined ? {} : { device: s.DeviceName })
                };
            });

        const resuming: PlaybackEntry[] = (resume.Items ?? []).map(item => ({
            ...common(item),
            kind: 'resume' as const,
            ...progress(ticksToSeconds(item.UserData?.PlaybackPositionTicks), ticksToSeconds(item.RunTimeTicks)),
            ...(item.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: item.UserData.LastPlayedDate })
        }));

        return [...nowPlaying, ...resuming];
    }

    /**
     * `/Items?ids=…`, not `/Items/{id}` — the latter answers **400 Error
     * processing request** on a live 10.11.11, and the per-user form
     * `/Users/{userId}/Items/{id}` would drag an identity into a call that has
     * no business needing one.
     *
     * `Fields` is required for anything beyond the summary: without it there
     * are no provider ids, no path and no media sources.
     */
    async getMediaDetails(id: string): Promise<MediaDetails> {
        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?ids=${encodeURIComponent(id)}&Fields=ProviderIds,Path,MediaSources,Overview`
        );
        const item = page.Items?.[0];
        if (item === undefined) {
            throw new ServiceError('NotFound', this.id, `no item with id ${id}`, {
                remedy: 'Check the id came from a Jellyfin search rather than another service.'
            });
        }

        const tmdb = numericId(item.ProviderIds?.Tmdb);
        const tvdb = numericId(item.ProviderIds?.Tvdb);

        return {
            service: this.id,
            kind: 'item',
            id,
            title: fenceText(item.Name ?? '', { service: this.id, field: 'Name' }),
            ...(item.ProductionYear === undefined ? {} : { year: item.ProductionYear }),
            ...(item.Overview === undefined
                ? {}
                : { overview: fenceText(item.Overview, { service: this.id, field: 'Overview' }) }),
            ...(item.MediaSources?.[0]?.Size === undefined ? {} : { sizeBytes: item.MediaSources[0].Size }),
            ...(item.Path === undefined ? {} : { path: fenceText(item.Path, { service: this.id, field: 'Path' }) }),
            ids: {
                ...(tmdb === undefined ? {} : { tmdb }),
                ...(tvdb === undefined ? {} : { tvdb }),
                ...(item.ProviderIds?.Imdb === undefined ? {} : { imdb: item.ProviderIds.Imdb })
            }
        };
    }

    /**
     * Jellyfin is the only service that knows what has actually been *watched*,
     * which is the gap design spec §12 says upstream never closed.
     */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];

        // `Fields=ProviderIds` is not optional decoration: Jellyfin omits
        // ProviderIds from search results entirely without it, confirmed
        // against a live 10.11.11. Every hit came back with no external ids at
        // all — which is precisely what Phase 3's resolver joins on.
        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?searchTerm=${encodeURIComponent(query)}&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds`
        );

        return (page.Items ?? [])
            .filter((i): i is RawItemDetail & { Id: string } => typeof i.Id === 'string')
            .map(i => {
                const tmdb = numericId(i.ProviderIds?.Tmdb);
                const tvdb = numericId(i.ProviderIds?.Tvdb);
                return {
                    service: this.id,
                    source: 'library' as const,
                    kind: i.Type === 'Series' ? ('series' as const) : ('item' as const),
                    id: i.Id,
                    title: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                    ...(i.ProductionYear === undefined ? {} : { year: i.ProductionYear }),
                    ids: {
                        ...(tmdb === undefined ? {} : { tmdb }),
                        ...(tvdb === undefined ? {} : { tvdb }),
                        ...(i.ProviderIds?.Imdb === undefined ? {} : { imdb: i.ProviderIds.Imdb })
                    }
                };
            });
    }

    /**
     * Per-user by construction (§4.3). `EnableUserData` is what makes `Played`
     * come back at all, and `Fields=ProviderIds` is what makes the join
     * possible — the same parameter whose absence made every Phase 2 search hit
     * arrive with no external ids.
     */
    async listUserLibrary(user: ServiceUser): Promise<IndexInput[]> {
        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?userId=${encodeURIComponent(user.id)}&Recursive=true&IncludeItemTypes=Movie,Series` +
                '&Fields=ProviderIds,Genres&EnableUserData=true'
        );

        return (page.Items ?? []).map(i => {
            const tmdb = numericId(i.ProviderIds?.Tmdb);
            const tvdb = numericId(i.ProviderIds?.Tvdb);

            return {
                kind: i.Type === 'Series' ? ('series' as const) : ('movie' as const),
                title: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                ...(i.ProductionYear === undefined ? {} : { year: i.ProductionYear }),
                ...(i.Genres === undefined
                    ? {}
                    : { genres: i.Genres.map(g => fenceText(g, { service: this.id, field: 'Genres' })) }),
                ids: {
                    ...(tmdb === undefined ? {} : { tmdb }),
                    ...(tvdb === undefined ? {} : { tvdb }),
                    ...(i.ProviderIds?.Imdb === undefined ? {} : { imdb: i.ProviderIds.Imdb })
                },
                playback: {
                    user: user.name,
                    watched: i.UserData?.Played ?? false,
                    ...(i.UserData?.PlayCount === undefined ? {} : { playCount: i.UserData.PlayCount }),
                    ...(i.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: i.UserData.LastPlayedDate })
                }
            };
        });
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
