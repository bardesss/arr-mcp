/**
 * The adapter Jellyfin and Emby share. Emby is the server Jellyfin was forked
 * from, and the two answer the same API apart from what `MediaBrowserDialect`
 * lists: `jellyfin.ts` and `emby.ts` each hold one dialect and a constructor.
 */
import { aliasesOf } from '../core/titleMatch.ts';
import { MEDIA_SERVER_NAMES, type MultiUserServiceConfig, type ServiceId } from '../config/schema.ts';
import type { EpisodeRecord, ItemLocks, MovieRecord } from '../core/episodeMismatch.ts';
import type { IndexInput } from '../core/resolver.ts';
import { embyToken } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { article } from '../core/labels.ts';
import { logger } from '../core/logger.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type LockLoss,
    type MediaDetailCapable,
    type MediaDetails,
    type MetadataInspectCapable,
    type MetadataRepairCapable,
    type PlaybackEntry,
    type PlaybackCapable,
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
 * The identify half of a metadata repair is a *synchronous* remote provider
 * lookup (Jellyfin holds the request open while it talks to TVDB and rebuilds
 * the item) so it does not fit the per-service read timeout. A live run
 * against a 69-episode series blew the configured 10s and the repair never
 * landed, which is exactly the shape `RELEASE_SEARCH_TIMEOUT_MS` already
 * documents for the *arrs' indexer sweeps.
 *
 * Deliberately generous rather than tuned: too short reports a repair that is
 * still running as a failure, and a caller who retries that starts a second
 * full rematch.
 */
export const METADATA_REPAIR_TIMEOUT_MS = 120_000;

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
 * wrong one, and `Name` is localised, returning "Mediabibliotheek scannen" on
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
    /** Only the activity-log read uses it, to drop live TV and the like. */
    Type?: string;
    UserData?: { PlaybackPositionTicks?: number; LastPlayedDate?: string; Played?: boolean };
};
type RawActivityEntry = { Name?: string; Type?: string; ItemId?: string | null; Date?: string; UserId?: string };
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

/** Library reads are paged: a large library has thousands of items, and one
 *  unpaged read would be the slowest call in a library build. */
const PAGE_SIZE = 500;
/** Backstop for `#pagedItems`: 400 pages is 200,000 items. Also as far as a catch-up reads a log that is never trimmed. */
const MAX_PAGES = 400;
const ticksToSeconds = (ticks: number | undefined): number | undefined =>
    typeof ticks === 'number' ? Math.round(ticks / TICKS_PER_SECOND) : undefined;

const PLAYED_ITEMS = 'SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Episode,Movie&Recursive=true';

/** The newest stops a history read takes from the activity log; `full` takes them all. */
const LOGGED_STOPS = 500;
/** How far a history read pages a log it cannot ask for stops alone: 5,000 entries. `full` reads up to MAX_PAGES. */
const LOG_PAGES = 10;

/** `/Items?ids=` reads in flight at once, so a full history read is not hundreds of requests at the same moment. */
const LOGGED_ITEMS_PARALLEL = 5;

/** Ids per `/Items?ids=` read, keeping the URL well short of proxy limits. */
const LOGGED_ITEMS_CHUNK = 100;

const HISTORY_TYPES = new Set(['Episode', 'Movie']);

type RawItemDetail = {
    Id?: string;
    Name?: string;
    /** Only with `Fields=OriginalTitle`. */
    OriginalTitle?: string | null;
    ProductionYear?: number;
    Overview?: string;
    Path?: string;
    Type?: string;
    /** `MusicBrainzArtist` is what joins an album artist to Lidarr. `IMDB`
     *  is Emby's spelling on a series or an episode: see `imdbField`. */
    ProviderIds?: { Tmdb?: string; Tvdb?: string; Imdb?: string; IMDB?: string; MusicBrainzArtist?: string };
    MediaSources?: { Size?: number }[];
    Genres?: string[];
    UserData?: { Played?: boolean; PlayCount?: number; LastPlayedDate?: string };
    /** Only with `Fields=RecursiveItemCount` and a user: on a series, its episodes (seasons are not counted). */
    RecursiveItemCount?: number;
    /** Both only with `Fields=Settings`. */
    LockData?: boolean;
    LockedFields?: string[];
};

type RawEpisodeItem = {
    Id?: string;
    Name?: string;
    SeriesId?: string;
    /** Jellyfin's season number. `IndexNumber` is the episode's. */
    ParentIndexNumber?: number;
    IndexNumber?: number;
    /** Only present when the read asks for it via `Fields=Path`. */
    Path?: string;
    /** Likewise `Fields=ProviderIds`. An episode carrying one is pinned to it
     *  across refreshes: see `pinnedToProvider`. */
    ProviderIds?: Record<string, string>;
    UserData?: { Played?: boolean; LastPlayedDate?: string };
    LockData?: boolean;
    LockedFields?: string[];
};

/**
 * Jellyfin's locks in the detector's terms. `LockData` makes a refresh skip
 * every provider, so it holds everything; `Name` is the only per-field lock a
 * mismatch can be about, since Jellyfin has none for the year. Checked against
 * MetadataService.cs at v12.1.
 */
const lockedFields = (item: { LockData?: boolean; LockedFields?: string[] }): string[] | undefined =>
    item.LockData === true ? ['title', 'year'] : item.LockedFields?.includes('Name') === true ? ['title'] : undefined;

const withLocks = (item: { LockData?: boolean; LockedFields?: string[] }): { lockedFields?: string[] } => {
    const locked = lockedFields(item);
    return locked === undefined ? {} : { lockedFields: locked };
};

/**
 * Jellyfin stores external ids as **strings** while Radarr and Sonarr use
 * numbers. The identity resolver joins on tmdbId and tvdbId, so a string
 * here would silently fail every join: convert at the boundary.
 */
const numericId = (value: string | undefined): number | undefined => {
    // Digits required, not just finiteness: `Number('')` is 0 and passes
    // `Number.isFinite`, so an empty provider id, which Jellyfin does emit,
    // became `tmdb: 0` and joined against every other item missing one.
    // Same trap `yearOf` documents in seerr.ts.
    if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
    return Number(value.trim());
};

/**
 * An item's IMDb id as a spread. Jellyfin spells the key `Imdb`; Emby does too
 * on a film but spells it `IMDB` on a series and an episode (seen live on Emby
 * 4.9.1.80, 4.9.5.0 and 4.10.2.0), so a read of `Imdb` alone loses every
 * series' IMDb id there.
 */
const imdbField = (ids: { Imdb?: string; IMDB?: string } | undefined): { imdb?: string } => {
    const imdb = ids?.Imdb ?? ids?.IMDB;
    return imdb === undefined ? {} : { imdb };
};

/**
 * What Jellyfin and Emby, the server Jellyfin was forked from, answer
 * differently among the requests this adapter makes. Every other request is
 * the same on both, with the same answer, but for a series' IMDb key, which
 * `imdbField` reads under either spelling.
 */
export type MediaBrowserDialect = {
    readonly type: 'jellyfin' | 'emby';
    /** One item as a user sees it, with that user's watch state. */
    readonly item: (userId: string, itemId: string) => string;
    /** The user's resumable items. */
    readonly resume: (userId: string) => string;
    /** Whether a row of the resume read is part-watched, rather than something else the server put there. */
    readonly resumable: (item: RawItem) => boolean;
    /** The user's next episode per series. */
    readonly nextUp: (userId: string) => string;
    /** Where POST marks an item played and DELETE unmarks it. */
    readonly played: (userId: string, itemId: string) => string;
    /**
     * What an item id looks like, how a refusal describes one, and whether a
     * Radarr or Sonarr id has the same shape, so that no check can refuse one.
     */
    readonly itemId: { readonly pattern: RegExp; readonly described: string; readonly likeArrIds: boolean };
    /** Added to `Fields` on each read that maps a year: what makes the server send `ProductionYear`. */
    readonly yearField: string;
    /**
     * The activity log's playback stops: the route, the test for a stop among
     * what it returns, and whether the route returns video stops alone. A log
     * that also holds music cannot say what a deleted item was, so a stop
     * whose item is gone is kept only where it is filtered.
     */
    readonly stops: { readonly route: string; readonly isStop: (entry: RawActivityEntry) => boolean; readonly filtered: boolean };
    /**
     * How the activity log names a user: by the id `/Users` gives, or by an
     * internal number, which `/Users/{n}` resolves to that id.
     */
    readonly logUserIds: 'users' | 'internal';
    /** Whether `/Items/RemoteSearch/Apply` answers only once the refresh it starts has finished. */
    readonly identifySettles: boolean;
    /** Whether that identify leaves the item's locks, and what they protect, alone. */
    readonly identifyKeepsLocks: boolean;
    /** Where the server's own UI issues an API key, for the remedy a refused key gets. */
    readonly apiKeys: string;
    /** How the server's own UI clears a lock: see `MetadataInspectCapable.unlockHow`. */
    readonly unlock: string;
};

export class MediaBrowserAdapter
    implements
        ServiceAdapter,
        ScanStateCapable,
        UserDirectoryCapable,
        MediaDetailCapable,
        SearchCapable,
        UserLibraryCapable,
        UserSeasonsCapable,
        WatchStateCapable,
        MetadataInspectCapable,
        MetadataRepairCapable,
        PlaybackCapable
{
    readonly type: ServiceId;
    readonly id: string;
    readonly unlockHow: string;
    readonly identifyClearsLocks: boolean;
    readonly #http: ServiceHttp;
    readonly #dialect: MediaBrowserDialect;

    protected constructor(dialect: MediaBrowserDialect, config: MultiUserServiceConfig, fetchImpl: typeof fetch) {
        this.#dialect = dialect;
        this.type = dialect.type;
        // One instance of each server, so the id is the type and `config.name`
        // is never read.
        this.id = dialect.type;
        this.unlockHow = dialect.unlock;
        this.identifyClearsLocks = !dialect.identifyKeepsLocks;
        this.#http = new ServiceHttp(dialect.type, config, embyToken(config.api_key, dialect.apiKeys), fetchImpl);
    }

    /** Jellyfin or Emby, as previews and remedies name it. */
    get name(): string {
        return MEDIA_SERVER_NAMES[this.#dialect.type];
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
     * every per-user call resolves through this list, and the resolver reports
     * the available names on a miss, because a hand-typed username is a
     * guaranteed source of silent mismatches.
     */
    async listUsers(): Promise<ServiceUser[]> {
        const users = await this.#http.getArray<RawUser>('/Users');
        return users
            .filter((u): u is { Id: string; Name: string } => typeof u.Id === 'string' && typeof u.Name === 'string')
            .map(u => ({ id: u.Id, name: u.Name }));
    }

    /**
     * Start the library scan: this adapter's only write.
     *
     * The task id is looked up rather than hard-coded, by the same
     * `Key === LIBRARY_SCAN_KEY` match `getScanState` uses: Jellyfin's ids are
     * per-install GUIDs, and the localised task *name* is no good either (a
     * Dutch install returns "Mediabibliotheek scannen"). Matching on the key
     * once, in one place, is what stops the two disagreeing about which task
     * this is.
     *
     * Jellyfin answers this with 204 and no body, so there is no command id to
     * report back, unlike the *arrs, which return one. The handle says so
     * rather than inventing a number that would look like something you could
     * poll.
     */
    async startLibraryScan(): Promise<CommandHandle> {
        const tasks = await this.#http.getArray<RawTask>('/ScheduledTasks');
        const scan = tasks.find(t => t.Key === LIBRARY_SCAN_KEY);

        if (scan?.Id === undefined) {
            const { name } = this;
            throw new ServiceError('NotFound', this.id, `${name} did not report a library scan task`, {
                remedy: `The task is called RefreshLibrary. If this ${name} has it disabled, start the scan from its dashboard instead.`
            });
        }

        await this.#http.post(`/ScheduledTasks/Running/${encodeURIComponent(scan.Id)}`, undefined, true);

        return { service: this.id, name: LIBRARY_SCAN_KEY, status: 'started' };
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.getArray<RawTask>('/ScheduledTasks');
        const scan = tasks.find(t => t.Key === LIBRARY_SCAN_KEY);
        const lastCompleted = scan?.LastExecutionResult?.EndTimeUtc;
        return {
            service: this.id,
            running: scan?.State === 'Running',
            ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
        };
    }

    /**
     * Sessions are global (an admin key sees the whole household), so they are
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
            this.#http.getArray<RawSession>('/Sessions'),
            this.#http.get<RawItemsPage>(this.#dialect.resume(user.id))
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

        const resuming: PlaybackEntry[] = (resume.Items ?? []).filter(this.#dialect.resumable).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'resume' as const,
            ...this.#progress(ticksToSeconds(item.UserData?.PlaybackPositionTicks), ticksToSeconds(item.RunTimeTicks)),
            ...(item.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: item.UserData.LastPlayedDate })
        }));

        return [...nowPlaying, ...resuming];
    }

    /**
     * `/Shows/NextUp` is Jellyfin's own per-user answer to "what next": one
     * row per series with an unwatched episode after the last one this user
     * finished. Confirmed against a live 10.11.11: 19 rows for a household
     * with several in-progress shows.
     */
    async getNextUp(user: ServiceUser): Promise<PlaybackEntry[]> {
        const page = await this.#http.get<RawItemsPage>(this.#dialect.nextUp(user.id));
        return (page.Items ?? []).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'next_up' as const
        }));
    }

    /**
     * Recently watched movies and episodes, newest first. `Filters=IsPlayed`
     * plus the DatePlayed sort are both real: confirmed against a live
     * 10.11.11 with an invented-parameter control, since Jellyfin silently
     * ignores a query param it does not recognise. `Limit=500` matches
     * `getPlayback`'s resumable read: truncation is decided by `applyLimit`,
     * not an undocumented server page size.
     *
     * `full` pages both reads to the end instead, for the play store's one
     * catch-up: every played item, and the whole activity log rather than the
     * household's newest 500 stops (Emby's to its newest 200,000 entries).
     */
    async getWatchHistory(user: ServiceUser, opts: { full?: boolean } = {}): Promise<PlaybackEntry[]> {
        const played = `/Items?userId=${encodeURIComponent(user.id)}&${PLAYED_ITEMS}`;
        const [items, logged] = await Promise.all([
            opts.full === true
                ? this.#pagedItems<RawItem>(`${played}&Fields=UserData`)
                : this.#http.get<RawItemsPage>(`${played}&Limit=500&Fields=UserData`).then(page => page.Items ?? []),
            this.#loggedStops(user, opts.full === true)
        ]);

        const marked: PlaybackEntry[] = items.map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'watched' as const,
            source: 'marked_played' as const,
            ...(item.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: item.UserData.LastPlayedDate })
        }));

        const seen = new Set(marked.map(e => e.itemId));
        const unmarked = logged.filter(e => !seen.has(e.ItemId as string));
        const fromLog = await this.#loggedPlays(user, unmarked);

        // ISO-8601 UTC strings sort lexically; an entry with no date goes last.
        return [...marked, ...fromLog].sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''));
    }

    /**
     * The log entries a history read takes. A filtered log is one read of the
     * newest stops, or every page for `full`. An unfiltered one (Emby's) holds
     * every kind of entry, so a history read pages until it holds as many
     * stops as one filtered read would, or has read LOG_PAGES pages of a log
     * with few of them. The catch-up reads to the end, and past MAX_PAGES
     * pages (Emby has no retention setting for its log) keeps the newest rather
     * than none.
     */
    #readLog(full: boolean): Promise<RawActivityEntry[]> {
        const { route, isStop, filtered } = this.#dialect.stops;
        if (filtered) {
            return full
                ? this.#pagedItems<RawActivityEntry>(route)
                : this.#http.get<{ Items?: RawActivityEntry[] }>(`${route}&limit=${LOGGED_STOPS}`).then(page => page.Items ?? []);
        }
        return this.#pagedItems<RawActivityEntry>(
            route,
            full ? read => read.length >= MAX_PAGES * PAGE_SIZE : read => read.length >= LOG_PAGES * PAGE_SIZE || read.filter(isStop).length >= LOGGED_STOPS
        );
    }

    /**
     * This user's newest stop per item. A failed read degrades to none rather
     * than failing the history: the `IsPlayed` half is still a correct answer
     * to most questions, and losing it over a supplementary read would not be.
     * A full read fails instead, so the store tries its catch-up again.
     */
    async #loggedStops(user: ServiceUser, full: boolean): Promise<RawActivityEntry[]> {
        const { isStop } = this.#dialect.stops;
        let entries: RawActivityEntry[];
        let usersId: (logId: string | undefined) => string | undefined;
        try {
            entries = (await this.#readLog(full))
                .filter(isStop)
                .slice(0, full ? undefined : LOGGED_STOPS);
            usersId = await this.#logUsers(entries);
        } catch (err) {
            // The full read is the play store's one catch-up: answering it
            // without the log would mark it done with the log never read.
            if (full) throw err;
            logger.warn({ service: this.id, err }, 'activity log read failed; history covers marked-played items only');
            return [];
        }

        const newest = new Map<string, RawActivityEntry>();
        for (const e of entries) {
            if (usersId(e.UserId) !== user.id || typeof e.ItemId !== 'string' || e.ItemId === '') continue;
            const kept = newest.get(e.ItemId);
            if (kept === undefined || (e.Date ?? '') > (kept.Date ?? '')) newest.set(e.ItemId, e);
        }
        return [...newest.values()];
    }

    /**
     * The `/Users` id behind each user the log names. Jellyfin's log uses that
     * id already. Emby's uses an internal number instead (`2` for a user whose
     * `/Users` id is 32 hex, seen live on 4.9.1.80 to 4.10.2.0) and
     * `/Users/{n}` answers with that user, so this costs one read per distinct
     * user in the log. A number it has no user for answers 404 ("may have been
     * recently removed", seen live), and only that user's entries are left out.
     */
    async #logUsers(entries: RawActivityEntry[]): Promise<(logId: string | undefined) => string | undefined> {
        if (this.#dialect.logUserIds === 'users') return logId => logId;
        const logIds = [...new Set(entries.map(e => e.UserId).filter((u): u is string => typeof u === 'string' && u !== ''))];
        const resolved = await Promise.all(
            logIds.map(async logId => {
                try {
                    return [logId, (await this.#http.get<RawUser>(`/Users/${encodeURIComponent(logId)}`)).Id] as const;
                } catch (err) {
                    if (err instanceof ServiceError && err.kind === 'NotFound') return [logId, undefined] as const;
                    throw err;
                }
            })
        );
        const byLogId = new Map(resolved);
        return logId => (logId === undefined ? undefined : byLogId.get(logId));
    }

    /**
     * Logged stops as history rows. Completion is the item's own `UserData`:
     * a resume position partway through means they stopped, so the row is
     * `partially_watched`; no position counts as watched, because an offline
     * client only syncs a stop once the file has been played and Jellyfin
     * clears the position at both ends. An item gone from the library keeps
     * its row, titled with the log's own (localised) sentence, since that is
     * all that is left of it, where the log holds video stops alone: one that
     * also holds music cannot tell a deleted film from a deleted song.
     */
    async #loggedPlays(user: ServiceUser, stops: RawActivityEntry[]): Promise<PlaybackEntry[]> {
        if (stops.length === 0) return [];

        const ids = stops.map(e => e.ItemId as string);
        const read = (i: number) =>
            this.#http.get<RawItemsPage>(
                `/Items?userId=${encodeURIComponent(user.id)}` +
                    `&ids=${ids.slice(i * LOGGED_ITEMS_CHUNK, (i + 1) * LOGGED_ITEMS_CHUNK).join(',')}&Fields=UserData`
            );
        const chunks = Array.from({ length: Math.ceil(ids.length / LOGGED_ITEMS_CHUNK) }, (_, i) => i);
        const pages: RawItemsPage[] = [];
        for (let at = 0; at < chunks.length; at += LOGGED_ITEMS_PARALLEL) {
            pages.push(...(await Promise.all(chunks.slice(at, at + LOGGED_ITEMS_PARALLEL).map(read))));
        }
        const byId = new Map(pages.flatMap(p => p.Items ?? []).map(item => [item.Id, item]));

        return stops.flatMap((stop): PlaybackEntry[] => {
            const item = byId.get(stop.ItemId as string);
            if (item === undefined) {
                if (!this.#dialect.stops.filtered) return [];
                return [
                    {
                        service: this.id,
                        kind: 'watched',
                        source: 'activity_log',
                        removedFromLibrary: true,
                        itemId: stop.ItemId as string,
                        title: this.#fence('Name', stop.Name ?? ''),
                        user: user.name,
                        ...(stop.Date === undefined ? {} : { lastPlayed: stop.Date })
                    }
                ];
            }
            if (!HISTORY_TYPES.has(item.Type ?? '')) return [];

            const position = item.UserData?.PlaybackPositionTicks ?? 0;
            const partial = item.UserData?.Played !== true && position > 0;
            const dates = [item.UserData?.LastPlayedDate, stop.Date].filter((d): d is string => d !== undefined);
            const lastPlayed = dates.sort().at(-1);
            return [
                {
                    ...this.#commonPlayback(user, item),
                    kind: partial ? 'partially_watched' : 'watched',
                    source: 'activity_log',
                    ...(partial ? this.#progress(ticksToSeconds(position), ticksToSeconds(item.RunTimeTicks)) : {}),
                    ...(lastPlayed === undefined ? {} : { lastPlayed })
                }
            ];
        });
    }

    /**
     * `/Items?ids=…`, not `/Items/{id}`. A bare `/Items/{id}` answered
     * **400 Error processing request** on a live 10.11.11; the cause was not
     * established. `readWatchTarget` reads the dialect's per-user `item`
     * route instead (`/Items/{id}?userId=` on Jellyfin, captured on 12.4.0).
     * This read has no business needing an identity, so it stays on `ids`,
     * which Emby 4.10.2.0 answers the same way.
     *
     * `Fields` is required for anything beyond the summary: without it there
     * are no provider ids, no path and no media sources.
     */
    async getMediaDetails(id: string): Promise<MediaDetails> {
        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?ids=${encodeURIComponent(id)}&Fields=ProviderIds,Path,MediaSources,Overview${this.#dialect.yearField}`
        );
        const item = page.Items?.[0];
        if (item === undefined) {
            throw new ServiceError('NotFound', this.id, `no item with id ${id}`, {
                remedy: `Check the id came from ${article(this.name)} ${this.name} search rather than another service.`
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
                ...imdbField(item.ProviderIds)
            }
        };
    }

    /** The media server is the only service that knows what has actually been watched. */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];

        // `Fields=ProviderIds` is not optional decoration: Jellyfin omits
        // ProviderIds from search results entirely without it, confirmed
        // against a live 10.11.11. Every hit came back with no external ids at
        // all, which is precisely what the resolver joins on.
        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?searchTerm=${encodeURIComponent(query)}&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds${this.#dialect.yearField}`
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
                        ...imdbField(i.ProviderIds)
                    }
                };
            });
    }

    /**
     * Per-user by construction. `EnableUserData` is what makes `Played`
     * come back at all, and `Fields=ProviderIds` is what makes the join
     * possible: the same parameter whose absence once made every search hit
     * arrive with no external ids.
     */
    async listUserLibrary(user: ServiceUser): Promise<IndexInput[]> {
        const items = await this.#pagedItems<RawItemDetail>(
            `/Items?userId=${encodeURIComponent(user.id)}&Recursive=true&IncludeItemTypes=Movie,Series` +
                `&Fields=ProviderIds,Genres,OriginalTitle,RecursiveItemCount${this.#dialect.yearField}&EnableUserData=true&EnableImages=false`
        );

        return items.map(i => {
            const tmdb = numericId(i.ProviderIds?.Tmdb);
            const tvdb = numericId(i.ProviderIds?.Tvdb);

            return {
                kind: i.Type === 'Series' ? ('series' as const) : ('movie' as const),
                title: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                ...((aliases => (aliases.length === 0 ? {} : { aliases }))(aliasesOf(i.Name, [i.OriginalTitle]))),
                ...(i.ProductionYear === undefined ? {} : { year: i.ProductionYear }),
                ...(i.Genres === undefined
                    ? {}
                    : { genres: i.Genres.map(g => fenceText(g, { service: this.id, field: 'Genres' })) }),
                ids: {
                    ...(tmdb === undefined ? {} : { tmdb }),
                    ...(tvdb === undefined ? {} : { tvdb }),
                    ...imdbField(i.ProviderIds)
                },
                playback: {
                    user: user.name,
                    ...(i.Id === undefined ? {} : { itemId: i.Id }),
                    watched: i.UserData?.Played ?? false,
                    ...(i.UserData?.PlayCount === undefined ? {} : { playCount: i.UserData.PlayCount }),
                    ...(i.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: i.UserData.LastPlayedDate }),
                    ...(i.Type === 'Series' && i.RecursiveItemCount === 0 ? { empty: true as const } : {})
                }
            };
        });
    }

    /**
     * The user's album artists, one row each, joined to Lidarr on the
     * MusicBrainz artist id.
     *
     * Its own read, and its own source in a library build, so a Jellyfin whose
     * music half fails does not take films and series down with it, and so
     * `musicGathered` can say which half was missing rather than claiming
     * every artist is `arr_only`.
     *
     * `/Artists/AlbumArtists` rather than `/Items?IncludeItemTypes=...`,
     * because an album artist is not a library item type: it is the set
     * Jellyfin derives from the albums it holds, and it is the only read that
     * exposes `ProviderIds.MusicBrainzArtist` for one. `playback` carries the
     * server's own id and no watch state: music watch state is not read here,
     * and a `watched: false` invented from that silence would be a claim
     * nobody made.
     */
    async listUserMusic(user: ServiceUser): Promise<IndexInput[]> {
        const items = await this.#pagedItems<RawItemDetail>(
            `/Artists/AlbumArtists?userId=${encodeURIComponent(user.id)}&Recursive=true&Fields=ProviderIds`
        );
        return items.map(i => {
            const mbid = i.ProviderIds?.MusicBrainzArtist;
            return {
                kind: 'artist' as const,
                title: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                ids: mbid === undefined || mbid === '' ? {} : { mbid },
                playback: {
                    user: user.name,
                    ...(i.Id === undefined ? {} : { itemId: i.Id })
                }
            };
        });
    }

    /** Reads every page of an items-shaped endpoint, `PAGE_SIZE` at a time,
     *  stopping on the first short page. `path` must already carry a query.
     *  A page identical to the one before it means the server ignored
     *  `StartIndex`; that, or running past `MAX_PAGES`, is thrown rather than
     *  looped on. */
    async #pagedItems<T>(path: string, enough?: (read: readonly T[]) => boolean): Promise<T[]> {
        const out: T[] = [];
        let previous: string | undefined;
        for (let start = 0; ; start += PAGE_SIZE) {
            if (start / PAGE_SIZE >= MAX_PAGES) {
                throw new ServiceError('UpstreamError', this.id, `${path.split('?')[0]} did not finish paging after ${MAX_PAGES} pages`, {
                    remedy: `This is a backstop, not an expected outcome. Check that nothing in front of ${this.name} rewrites Limit or StartIndex.`
                });
            }
            const page = await this.#http.get<{ Items?: T[] }>(`${path}&Limit=${PAGE_SIZE}&StartIndex=${start}`);
            const items = page.Items ?? [];
            const fingerprint = JSON.stringify(items);
            if (start > 0 && items.length > 0 && fingerprint === previous) {
                throw new ServiceError('UpstreamError', this.id, `${path.split('?')[0]} did not advance past StartIndex=0, the whole page repeated`, {
                    remedy: `${this.name}, or a proxy in front of it, appears to be ignoring the StartIndex query parameter.`
                });
            }
            previous = fingerprint;
            out.push(...items);
            if (items.length < PAGE_SIZE || enough?.(out) === true) return out;
        }
    }

    /**
     * Per-season watch state for every series this user has episodes of.
     *
     * Two calls, and the series call is deliberately **not** shared with
     * `listUserLibrary`: sharing it would couple the two sources, and
     * independent failure is the entire reason they are separate. It is cheap:
     * ids only, no genres and no user data.
     *
     * Episodes are collapsed here rather than returned, so a 10,000-episode
     * library costs one object per season in the snapshot instead of 10,000.
     * Jellyfin's internal `Id` never leaves this method; the resolver keeps
     * joining on external ids alone.
     */
    /**
     * An item id has the dialect's shape (32 lowercase hex on Jellyfin, digits
     * on Emby), checked before any network call. On Jellyfin that catches the
     * ids a caller is most likely to reach for by mistake (a Radarr movie id,
     * a Sonarr series id), which are small integers and would produce a 404
     * that names nothing useful.
     */
    #itemId(id: string): string {
        const clean = id.trim().toLowerCase();
        const { name } = this;
        const { itemId } = this.#dialect;
        if (!itemId.pattern.test(clean)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not ${article(name)} ${name} item id`, {
                remedy: `${name} item ids are ${itemId.described}, and are not Radarr or Sonarr ids. Take one from the \`itemId\` get_playback reports, or from ${article(this.id)} ${this.id} hit in search_media.`
            });
        }
        return clean;
    }

    async readWatchTarget(user: ServiceUser, itemId: string): Promise<WatchTarget> {
        const id = this.#itemId(itemId);
        const item = await this.#http.get<
            RawItemDetail & { Type?: string; IsFolder?: boolean; IndexNumber?: number; SeriesId?: string; UserData?: { Played?: boolean } }
        >(this.#dialect.item(user.id, id));

        const KINDS: Record<string, WatchTarget['kind']> = { Movie: 'movie', Series: 'series', Episode: 'episode' };
        // Marking a folder marks every child, so it is told apart from a leaf.
        // Seen live: Season and CollectionFolder both carry IsFolder.
        const folder = item.IsFolder === true || item.Type === 'Season' || item.Type === 'BoxSet';
        const seasonOf =
            item.Type === 'Season' && typeof item.SeriesId === 'string' && this.#dialect.itemId.pattern.test(item.SeriesId.toLowerCase());
        return {
            id,
            title: fenceText(item.Name ?? '', { service: this.id, field: 'Name' }),
            kind: KINDS[item.Type ?? ''] ?? (folder ? 'folder' : 'item'),
            watched: item.UserData?.Played === true,
            ...(seasonOf ? { seriesId: item.SeriesId, ...(typeof item.IndexNumber === 'number' ? { season: item.IndexNumber } : {}) } : {})
        };
    }

    /**
     * `season` is Jellyfin's own parameter name, confirmed by sending an
     * invented one and getting the unfiltered count back: Jellyfin ignores
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
     * data, which nothing here reads: the tool re-reads state through
     * `readWatchTarget` when it needs it.
     */
    async setWatched(user: ServiceUser, itemId: string, watched: boolean): Promise<void> {
        const path = this.#dialect.played(user.id, this.#itemId(itemId));
        if (watched) {
            await this.#http.post(path, undefined, true);
        } else {
            await this.#http.delete(path);
        }
    }

    /**
     * The same endpoint `listEpisodeItems` reads, asked a different question.
     * `Fields=Path` is the entire reason this is a separate method: Jellyfin
     * omits `Path` unless a read asks for it, and `set_watched` has no use for
     * a file path: widening its read to carry one would change a verified
     * request for nothing.
     */
    async readEpisodeMetadata(user: ServiceUser, seriesItemId: string): Promise<EpisodeRecord[]> {
        const id = this.#itemId(seriesItemId);
        // `ProviderIds` alongside `Path` because the two together decide
        // whether a mismatch is repairable at all: an episode pinned to its own
        // provider id is re-fetched from that id by a refresh, so refreshing it
        // rewrites exactly the metadata it already had.
        const page = await this.#http.get<{ Items?: RawEpisodeItem[] }>(
            `/Shows/${id}/Episodes?userId=${encodeURIComponent(user.id)}&Fields=Path,ProviderIds,Settings&EnableImages=false`
        );

        return (page.Items ?? [])
            .filter((e): e is RawEpisodeItem & { Id: string } => typeof e.Id === 'string')
            .map(e => ({
                id: e.Id,
                name: fenceText(e.Name ?? '', { service: this.id, field: 'Name' }),
                ...(e.ParentIndexNumber === undefined ? {} : { season: e.ParentIndexNumber }),
                ...(e.IndexNumber === undefined ? {} : { episode: e.IndexNumber }),
                // Fenced like every other server-supplied string. The mismatch
                // parser unfences before it reads the path, so the fence costs
                // the comparison nothing and the value stays safe to print.
                ...(e.Path === undefined ? {} : { path: fenceText(e.Path, { service: this.id, field: 'Path' }) }),
                // Not fenced: these are read as structure (whether an id
                // exists at all) and never printed as prose.
                ...(e.ProviderIds === undefined ? {} : { providerIds: e.ProviderIds }),
                ...withLocks(e)
            }));
    }

    /**
     * Every film, in one call rather than one call per title.
     *
     * The asymmetry with the episode read is the library's, not a design
     * choice: episodes have to be asked for per series, films do not, so a
     * sweep of a large library costs one request here and one per series
     * there.
     */
    async readMovieMetadata(user: ServiceUser, itemId?: string): Promise<MovieRecord[]> {
        // One film by id when the caller wants one. `fix_metadata` reads a film
        // four times across a preview and a confirm, and pulling the whole film
        // library each time is a multi-megabyte response under a read timeout
        // meant for a small one, which `get` then retries once before failing.
        const scope =
            itemId === undefined
                ? '&Recursive=true&IncludeItemTypes=Movie'
                : `&ids=${encodeURIComponent(this.#itemId(itemId))}`;

        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?userId=${encodeURIComponent(user.id)}${scope}` +
                `&Fields=Path,ProviderIds,Settings${this.#dialect.yearField}&EnableImages=false`
        );

        return (page.Items ?? [])
            .filter((i): i is RawItemDetail & { Id: string } => typeof i.Id === 'string')
            .map(i => ({
                id: i.Id,
                name: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                ...(i.ProductionYear === undefined ? {} : { year: i.ProductionYear }),
                ...(i.Path === undefined ? {} : { path: fenceText(i.Path, { service: this.id, field: 'Path' }) }),
                ...(i.ProviderIds === undefined ? {} : { providerIds: i.ProviderIds }),
                ...withLocks(i),
                ...this.#ownLocks(i)
            }));
    }

    /** The locks as the server reported them, kept only where its identify takes them: see `identifyLockLoss`. */
    #ownLocks(item: { LockData?: boolean; LockedFields?: string[] }): { locks?: ItemLocks } {
        return this.#dialect.identifyKeepsLocks || typeof item.LockData !== 'boolean'
            ? {}
            : { locks: { item: item.LockData, fields: item.LockedFields ?? [] } };
    }

    /**
     * One call, not two, and which one depends on whether an identity can be
     * pinned.
     *
     * `ApplySearchCriteria` is not just a pin. Checked against the server
     * source rather than assumed: it sets the item's `ProviderIds` and then
     * **awaits `RefreshFullItem` itself**, with `MetadataRefreshMode.FullRefresh`,
     * `ReplaceAllMetadata = true` and `RemoveOldMetadata = true`, before
     * answering 204. So a following `/Refresh` is a second full provider fetch
     * of the same item for no gain, and the comment that used to sit here
     * claiming "two calls, and both are needed" was wrong.
     *
     * The difference matters beyond the wasted work: Apply is **synchronous**,
     * so when it returns the metadata is settled and a caller comparing before
     * and after is reading a final answer. The standalone refresh is queued, so
     * a caller reading straight after it is reading a snapshot mid-flight.
     * `settled` says which of the two happened rather than making the caller
     * guess.
     *
     * The refresh query names are camelCase because that is what the vendored
     * spec says (`RefreshItem`), not the capitalised spelling issue #199 quoted.
     * Jellyfin ignores parameters it does not recognise, so a wrong spelling
     * here would return 204 and change nothing: the failure this whole tool
     * exists to stop being reported as success.
     */
    async repairMetadata(itemId: string, opts: { tvdbId?: number; tmdbId?: number }): Promise<{ settled: boolean }> {
        const id = this.#itemId(itemId);
        const slow = { timeoutMs: METADATA_REPAIR_TIMEOUT_MS };

        const providerIds: Record<string, string> = {
            ...(opts.tvdbId === undefined ? {} : { Tvdb: String(opts.tvdbId) }),
            ...(opts.tmdbId === undefined ? {} : { Tmdb: String(opts.tmdbId) })
        };

        // Applying an empty match would unpin whatever identity the item
        // already had, so with no id to pin this falls back to the plain
        // refresh, which cannot fix a wrong match, only a missing one.
        if (Object.keys(providerIds).length > 0) {
            await this.#http.post(
                `/Items/RemoteSearch/Apply/${id}?replaceAllImages=false`,
                { ProviderIds: providerIds },
                true,
                slow
            );
            return { settled: this.#dialect.identifySettles };
        }

        await this.#http.post(
            `/Items/${id}/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=FullRefresh` +
                '&replaceAllMetadata=true&replaceAllImages=false',
            undefined,
            true,
            slow
        );
        return { settled: false };
    }

    /**
     * Nothing for Jellyfin, without a request: its identify keeps every lock.
     * Emby's, seen live on 4.9.1.80, 4.9.5.0 and 4.10.2.0 with an unlocked
     * control beside each case, clears the identified film's or series' own
     * locks and overwrites what they protected, keeps an episode's field locks,
     * and keeps the metadata of an episode locked as a whole but drops its
     * provider ids.
     *
     * A season's own lock held through a series identify (seen live, beside
     * an unlocked season whose hand-edited name was overwritten), and locking
     * a season locks its episodes as a whole too, which the episode read sees.
     *
     * A film's locks come with the film read the repair already makes
     * (`Fields=Settings` carries `LockData` and `LockedFields`, as an explicit
     * `false` and `[]` when nothing is locked, seen live). A series' own and
     * its episodes' are read as the server holds them, not as the repair's
     * user sees them: the identify also reaches episodes that user's library
     * access or parental limit hides. A record or answer without them is
     * `unread`: a lock this cannot see is not one it may clear.
     */
    async identifyLockLoss(item: { itemId: string; kind: 'movie' | 'series' }, parts: readonly { id: string; locks?: ItemLocks }[]): Promise<LockLoss> {
        if (this.#dialect.identifyKeepsLocks) return { own: [], wholeLockedEpisodes: [] };
        const named = (l: ItemLocks): string[] => [...(l.item ? ['item'] : []), ...l.fields];
        if (item.kind === 'movie') {
            const film = parts.find(p => p.id === item.itemId)?.locks;
            return film === undefined ? { unread: true } : { own: named(film), wholeLockedEpisodes: [] };
        }
        const id = this.#itemId(item.itemId);
        const [page, episodes] = await Promise.all([
            this.#http.get<{ Items?: RawItemDetail[] }>(`/Items?ids=${id}&Fields=Settings&EnableImages=false`),
            this.#http.get<{ Items?: RawEpisodeItem[] }>(`/Shows/${id}/Episodes?Fields=Settings&EnableImages=false`)
        ]);
        const series = page.Items?.[0];
        const rows = episodes.Items;
        // Each row says whether it is locked, and a locked one which episode it is.
        const unread = (e: RawEpisodeItem | null): boolean => typeof e?.LockData !== 'boolean' || (e.LockData && (typeof e.Id !== 'string' || e.Id === ''));
        if (typeof series?.LockData !== 'boolean' || !Array.isArray(rows) || rows.some(unread)) return { unread: true };
        return {
            own: named({ item: series.LockData, fields: series.LockedFields ?? [] }),
            wholeLockedEpisodes: rows
                .filter((e): e is RawEpisodeItem & { Id: string } => e.LockData === true)
                .map(e => ({
                    id: e.Id,
                    name: fenceText(e.Name ?? '', { service: this.id, field: 'Name' }),
                    ...(e.ParentIndexNumber === undefined ? {} : { season: e.ParentIndexNumber }),
                    ...(e.IndexNumber === undefined ? {} : { episode: e.IndexNumber })
                }))
        };
    }

    async listUserSeasons(user: ServiceUser): Promise<IndexInput[]> {
        const series = await this.#pagedItems<RawItemDetail>(
            '/Items?Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds&EnableImages=false'
        );
        const episodes = await this.#pagedItems<RawEpisodeItem>(
            `/Items?userId=${encodeURIComponent(user.id)}&Recursive=true&IncludeItemTypes=Episode` +
                '&EnableUserData=true&EnableImages=false'
        );

        const bySeries = new Map<string, Map<number, { watched: number; lastPlayed?: string }>>();
        for (const episode of episodes) {
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

        return series
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
                        ...imdbField(s.ProviderIds)
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
            // them matches nothing and becomes a **new** library item: the
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
