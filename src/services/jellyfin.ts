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
    type UserLibraryCapable,
    type UserSeasonsCapable,
    type WatchStateCapable,
    type WatchTarget,
    type CommandHandle
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
    /** Per-install GUID. Only `startLibraryScan` needs it; `getScanState`
     *  matches on `Key`, which is stable across installs. */
    Id?: string;
    Key?: string;
    Name?: string;
    State?: string;
    LastExecutionResult?: { EndTimeUtc?: string; Status?: string };
};

/**
 * The library-scan task, confirmed against a live 10.11.11.
 *
 * Keyed on `Key`, never `Name`, for two reasons: a server exposes eight
 * library-ish keys including `TraktSyncLibraryTask`, so a pattern matches the
 * wrong one — and `Name` is localised, returning "Mediabibliotheek scannen" on
 * the instance this came from.
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

type RawEpisodeItem = {
    Id?: string;
    Name?: string;
    SeriesId?: string;
    /** Jellyfin's season number. `IndexNumber` is the episode's. */
    ParentIndexNumber?: number;
    IndexNumber?: number;
    UserData?: { Played?: boolean; LastPlayedDate?: string };
};

/**
 * Jellyfin stores external ids as **strings** while Radarr and Sonarr use
 * numbers. The identity resolver joins on tmdbId and tvdbId, so a string
 * here would silently fail every join — convert at the boundary.
 */
const numericId = (value: string | undefined): number | undefined => {
    // Digits required, not just finiteness: `Number('')` is 0 and passes
    // `Number.isFinite`, so an empty provider id — which Jellyfin does emit —
    // became `tmdb: 0` and joined against every other item missing one.
    // Same trap `yearOf` documents in seerr.ts.
    if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
    return Number(value.trim());
};

export class JellyfinAdapter
    implements
        ServiceAdapter,
        ScanStateCapable,
        UserDirectoryCapable,
        MediaDetailCapable,
        SearchCapable,
        UserLibraryCapable,
        UserSeasonsCapable,
        WatchStateCapable
{
    readonly type: ServiceId = 'jellyfin';
    readonly id: string = 'jellyfin';
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
     * every per-user call resolves through this list — and the resolver reports
     * the available names on a miss, because a hand-typed username is a
     * guaranteed source of silent mismatches.
     */
    async listUsers(): Promise<ServiceUser[]> {
        const users = await this.#http.get<RawUser[]>('/Users');
        return users
            .filter((u): u is { Id: string; Name: string } => typeof u.Id === 'string' && typeof u.Name === 'string')
            .map(u => ({ id: u.Id, name: u.Name }));
    }

    /**
     * Start the library scan — this adapter's only write.
     *
     * The task id is looked up rather than hard-coded, by the same
     * `Key === LIBRARY_SCAN_KEY` match `getScanState` uses: Jellyfin's ids are
     * per-install GUIDs, and the localised task *name* is no good either (a
     * Dutch install returns "Mediabibliotheek scannen"). Matching on the key
     * once, in one place, is what stops the two disagreeing about which task
     * this is.
     *
     * Jellyfin answers this with 204 and no body, so there is no command id to
     * report back — unlike the *arrs, which return one. The handle says so
     * rather than inventing a number that would look like something you could
     * poll.
     */
    async startLibraryScan(): Promise<CommandHandle> {
        const tasks = await this.#http.get<RawTask[]>('/ScheduledTasks');
        const scan = tasks.find(t => t.Key === LIBRARY_SCAN_KEY);

        if (scan?.Id === undefined) {
            throw new ServiceError('NotFound', this.id, 'Jellyfin did not report a library scan task', {
                remedy: 'The task is called RefreshLibrary. If this Jellyfin has it disabled, start the scan from its dashboard instead.'
            });
        }

        await this.#http.post(`/ScheduledTasks/Running/${encodeURIComponent(scan.Id)}`, undefined, true);

        return { service: this.id, commandId: 0, name: LIBRARY_SCAN_KEY, status: 'started' };
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
    #fence(field: string, value: string): string {
        return fenceText(value, { service: this.id, field });
    }

    #commonPlayback(user: ServiceUser, item: RawItem) {
        return {
            service: this.id,
            itemId: item.Id ?? '',
            title: this.#fence('Name', item.Name ?? ''),
            ...(item.SeriesName === undefined ? {} : { seriesTitle: this.#fence('SeriesName', item.SeriesName) }),
            ...(item.ParentIndexNumber === undefined ? {} : { season: item.ParentIndexNumber }),
            ...(item.IndexNumber === undefined ? {} : { episode: item.IndexNumber }),
            user: user.name
        };
    }

    #progress(position: number | undefined, runtime: number | undefined) {
        return {
            ...(position === undefined ? {} : { positionSeconds: position }),
            ...(runtime === undefined ? {} : { runtimeSeconds: runtime }),
            // Guarded against a zero runtime, which would divide to Infinity.
            ...(position !== undefined && runtime !== undefined && runtime > 0
                ? { percentComplete: Math.round((position / runtime) * 100) }
                : {})
        };
    }

    async getPlayback(user: ServiceUser): Promise<PlaybackEntry[]> {
        const [sessions, resume] = await Promise.all([
            this.#http.get<RawSession[]>('/Sessions'),
            /**
             * `/Users/{id}/Items/Resume` is the supported way to ask for the
             * resumable set. `/Items?IsResumable=true` looks like the right query
             * but is silently ignored by Jellyfin 10.11 — it returns the entire
             * library, not just resumable items.
             *
             * `Limit=500` ensures truncation is decided by `applyLimit` in the
             * contract layer, which reports it, rather than by an undocumented
             * server default page size, which does not.
             */
            this.#http.get<RawItemsPage>(`/Users/${encodeURIComponent(user.id)}/Items/Resume?Limit=500`)
        ]);

        const nowPlaying: PlaybackEntry[] = sessions
            .filter(s => s.UserId === user.id && s.NowPlayingItem !== undefined)
            .map(s => {
                const item = s.NowPlayingItem as RawItem;
                return {
                    ...this.#commonPlayback(user, item),
                    kind: 'now_playing' as const,
                    ...this.#progress(ticksToSeconds(s.PlayState?.PositionTicks), ticksToSeconds(item.RunTimeTicks)),
                    ...(s.DeviceName === undefined ? {} : { device: s.DeviceName })
                };
            });

        const resuming: PlaybackEntry[] = (resume.Items ?? []).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'resume' as const,
            ...this.#progress(ticksToSeconds(item.UserData?.PlaybackPositionTicks), ticksToSeconds(item.RunTimeTicks)),
            ...(item.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: item.UserData.LastPlayedDate })
        }));

        return [...nowPlaying, ...resuming];
    }

    /**
     * `/Shows/NextUp` is Jellyfin's own per-user answer to "what next" — one
     * row per series with an unwatched episode after the last one this user
     * finished. Confirmed against a live 10.11.11: 19 rows for a household
     * with several in-progress shows.
     */
    async getNextUp(user: ServiceUser): Promise<PlaybackEntry[]> {
        const page = await this.#http.get<RawItemsPage>(`/Shows/NextUp?userId=${encodeURIComponent(user.id)}`);
        return (page.Items ?? []).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'next_up' as const
        }));
    }

    /**
     * Recently watched movies and episodes, newest first. `Filters=IsPlayed`
     * plus the DatePlayed sort are both real — confirmed against a live
     * 10.11.11 with an invented-parameter control, since Jellyfin silently
     * ignores a query param it does not recognise. `Limit=500` matches
     * `getPlayback`'s resumable read: truncation is decided by `applyLimit`,
     * not an undocumented server page size.
     */
    async getWatchHistory(user: ServiceUser): Promise<PlaybackEntry[]> {
        const page = await this.#http.get<RawItemsPage>(
            `/Items?userId=${encodeURIComponent(user.id)}&SortBy=DatePlayed&SortOrder=Descending` +
                '&Filters=IsPlayed&IncludeItemTypes=Episode,Movie&Recursive=true&Limit=500&Fields=UserData'
        );
        return (page.Items ?? []).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'watched' as const,
            ...(item.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: item.UserData.LastPlayedDate })
        }));
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

    /** Jellyfin is the only service that knows what has actually been watched. */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];

        // `Fields=ProviderIds` is not optional decoration: Jellyfin omits
        // ProviderIds from search results entirely without it, confirmed
        // against a live 10.11.11. Every hit came back with no external ids at
        // all — which is precisely what the resolver joins on.
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
     * Per-user by construction. `EnableUserData` is what makes `Played`
     * come back at all, and `Fields=ProviderIds` is what makes the join
     * possible — the same parameter whose absence once made every search hit
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

    /**
     * Per-season watch state for every series this user has episodes of.
     *
     * Two calls, and the series call is deliberately **not** shared with
     * `listUserLibrary`: sharing it would couple the two sources, and
     * independent failure is the entire reason they are separate. It is cheap —
     * ids only, no genres and no user data.
     *
     * Episodes are collapsed here rather than returned, so a 10,000-episode
     * library costs one object per season in the snapshot instead of 10,000.
     * Jellyfin's internal `Id` never leaves this method; the resolver keeps
     * joining on external ids alone.
     */
    /**
     * Jellyfin item ids are 32 lowercase hex characters. Checked before any
     * network call, because the ids a caller is most likely to reach for by
     * mistake — a Radarr movie id, a Sonarr series id — are small integers,
     * and sending one on produces a 404 that names nothing useful.
     */
    #itemId(id: string): string {
        const clean = id.trim().toLowerCase();
        if (!/^[0-9a-f]{32}$/.test(clean)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Jellyfin item id`, {
                remedy:
                    'Jellyfin item ids are 32 hex characters, and are not Radarr or Sonarr ids. Take one from the `itemId` get_playback reports, or from a jellyfin hit in search_media.'
            });
        }
        return clean;
    }

    async readWatchTarget(user: ServiceUser, itemId: string): Promise<WatchTarget> {
        const id = this.#itemId(itemId);
        const item = await this.#http.get<RawItemDetail & { Type?: string; UserData?: { Played?: boolean } }>(
            `/Items/${id}?userId=${encodeURIComponent(user.id)}`
        );

        const KINDS: Record<string, WatchTarget['kind']> = { Movie: 'movie', Series: 'series', Episode: 'episode' };
        return {
            id,
            title: fenceText(item.Name ?? '', { service: this.id, field: 'Name' }),
            kind: KINDS[item.Type ?? ''] ?? 'item',
            watched: item.UserData?.Played === true
        };
    }

    /**
     * `season` is Jellyfin's own parameter name, confirmed by sending an
     * invented one and getting the unfiltered count back — Jellyfin ignores
     * query parameters it does not recognise, so a wrong spelling looks
     * exactly like a working filter.
     */
    async listEpisodeItems(user: ServiceUser, seriesItemId: string, season?: number): Promise<WatchTarget[]> {
        const id = this.#itemId(seriesItemId);
        const page = await this.#http.get<{ Items?: RawEpisodeItem[] }>(
            `/Shows/${id}/Episodes?userId=${encodeURIComponent(user.id)}&EnableUserData=true` +
                (season === undefined ? '' : `&season=${season}`)
        );

        return (page.Items ?? [])
            .filter((e): e is RawEpisodeItem & { Id: string } => typeof e.Id === 'string')
            .map(e => ({
                id: e.Id,
                title: fenceText(e.Name ?? '', { service: this.id, field: 'Name' }),
                kind: 'episode' as const,
                watched: e.UserData?.Played === true,
                ...(e.ParentIndexNumber === undefined ? {} : { season: e.ParentIndexNumber }),
                ...(e.IndexNumber === undefined ? {} : { episode: e.IndexNumber })
            }));
    }

    /**
     * POST marks played, DELETE unmarks. Both answer with the item's user
     * data, which nothing here reads — the tool re-reads state through
     * `readWatchTarget` when it needs it.
     *
     * `userId` is a query parameter, and Jellyfin ignores parameters it does
     * not recognise: a misspelling here would silently mark the item for
     * whoever the API key belongs to instead. Proved correct by sending an
     * invented parameter alongside and confirming the response was unchanged.
     */
    async setWatched(user: ServiceUser, itemId: string, watched: boolean): Promise<void> {
        const path = `/UserPlayedItems/${this.#itemId(itemId)}?userId=${encodeURIComponent(user.id)}`;
        if (watched) {
            await this.#http.post(path, undefined, true);
        } else {
            await this.#http.delete(path);
        }
    }

    async listUserSeasons(user: ServiceUser): Promise<IndexInput[]> {
        const series = await this.#http.get<{ Items?: RawItemDetail[] }>(
            '/Items?Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds'
        );
        const episodes = await this.#http.get<{ Items?: RawEpisodeItem[] }>(
            `/Items?userId=${encodeURIComponent(user.id)}&Recursive=true&IncludeItemTypes=Episode` +
                '&EnableUserData=true'
        );

        const bySeries = new Map<string, Map<number, { watched: number; lastPlayed?: string }>>();
        for (const episode of episodes.Items ?? []) {
            const seriesId = episode.SeriesId;
            const season = episode.ParentIndexNumber;
            if (seriesId === undefined || season === undefined) continue;

            const seasons = bySeries.get(seriesId) ?? new Map<number, { watched: number; lastPlayed?: string }>();
            bySeries.set(seriesId, seasons);

            const row = seasons.get(season) ?? { watched: 0 };
            if (episode.UserData?.Played === true) row.watched += 1;
            const played = episode.UserData?.LastPlayedDate;
            // Compared as strings: ISO 8601 sorts lexicographically in the order
            // it sorts chronologically, and `new Date()` on a malformed value
            // yields NaN, which compares false against everything.
            if (played !== undefined && (row.lastPlayed === undefined || played > row.lastPlayed)) {
                row.lastPlayed = played;
            }
            seasons.set(season, row);
        }

        return (series.Items ?? [])
            .filter((s): s is RawItemDetail & { Id: string } => typeof s.Id === 'string' && bySeries.has(s.Id))
            .map(s => {
                const tmdb = numericId(s.ProviderIds?.Tmdb);
                const tvdb = numericId(s.ProviderIds?.Tvdb);
                return {
                    kind: 'series' as const,
                    title: fenceText(s.Name ?? '', { service: this.id, field: 'Name' }),
                    ids: {
                        ...(tmdb === undefined ? {} : { tmdb }),
                        ...(tvdb === undefined ? {} : { tvdb }),
                        ...(s.ProviderIds?.Imdb === undefined ? {} : { imdb: s.ProviderIds.Imdb })
                    },
                    seasons: [...(bySeries.get(s.Id) ?? new Map<number, { watched: number; lastPlayed?: string }>()).entries()]
                        .map(([season, row]) => ({
                            season,
                            watched: row.watched,
                            ...(row.lastPlayed === undefined ? {} : { lastPlayed: row.lastPlayed })
                        }))
                        .sort((a, b) => a.season - b.season)
                };
            })
            // A row with no external id can never join. `LibraryIndex.build`
            // keys on tmdb/tvdb/imdb, so a seasons-only row carrying none of
            // them matches nothing and becomes a **new** library item — the
            // same id-less series `listUserLibrary` already returned, appearing
            // a second time with no playback, no acquisition and
            // `presence: 'unknown'`, inflating `get_library`'s `total` and
            // duplicating the title. Dropped rather than emitted: seasons with
            // nothing to attach them to answer no question anyone can ask.
            .filter(row => Object.keys(row.ids).length > 0);
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
