import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import type { IndexInput } from '../core/resolver.ts';
import { plexToken } from '../core/auth.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { logger } from '../core/logger.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type MediaDetailCapable,
    type MediaDetails,
    type PlaybackCapable,
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
    type UserSeasonsCapable
} from './types.ts';

/**
 * Every Plex response wraps in `MediaContainer`, with rows under a key that
 * depends on what was asked: `Metadata` for items, `Directory` for library
 * sections, `Account` for accounts.
 */
type MediaContainer = { MediaContainer?: Record<string, unknown> };

export type RawPlexItem = {
    ratingKey?: string;
    key?: string;
    type?: string;
    title?: string;
    grandparentTitle?: string;
    parentIndex?: number;
    index?: number;
    year?: number;
    summary?: string;
    duration?: number;
    viewOffset?: number;
    viewCount?: number;
    lastViewedAt?: number;
    addedAt?: number;
    Genre?: { tag?: string }[];
    Media?: { Part?: { file?: string; size?: number }[] }[];
    /** Modern agents. */
    Guid?: { id?: string }[];
    /** Legacy agents, e.g. `com.plexapp.agents.imdb://tt0111161?lang=en`. */
    guid?: string;
    /** `/status/sessions` only — who is watching. XML-derived JSON, so this
     *  comes back as either a string or a number depending on the row. */
    User?: { id?: string | number; title?: string };
    /** `/status/sessions` only — what they are watching on. */
    Player?: { title?: string };
    /** Episodes from `/library/sections/{key}/all?type=4` — the series' ratingKey. */
    grandparentRatingKey?: string;
    /** `/status/sessions/history/all` only — which account watched this row. */
    accountID?: string | number;
    /** Show rows only — Plex's own series-completion counters. */
    viewedLeafCount?: number;
    leafCount?: number;
};

export const unwrap = <T>(body: unknown, key: string): T[] => {
    const rows = (body as MediaContainer | null)?.MediaContainer?.[key];
    return Array.isArray(rows) ? (rows as T[]) : [];
};

/** Plex counts milliseconds; Jellyfin counts 100ns ticks. Nothing shared. */
export const msToSeconds = (ms: number | undefined): number | undefined =>
    typeof ms === 'number' ? Math.round(ms / 1000) : undefined;

/**
 * Plex timestamps are unix epoch **seconds**. `lastPlayed` is consumed as ISO.
 *
 * Zero is treated as absent: no real playback happened at the epoch, and a
 * 1970 timestamp in a tool response reads as data rather than as a gap.
 */
export const epochToIso = (seconds: number | undefined): string | undefined =>
    typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;

/** Digits required, not just finiteness — `Number('')` is 0 and would join
 *  against every other item missing an id. */
const numericId = (value: string | undefined): number | undefined =>
    value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;

const LEGACY_AGENTS: Record<string, 'imdb' | 'tmdb' | 'tvdb'> = {
    imdb: 'imdb',
    themoviedb: 'tmdb',
    thetvdb: 'tvdb'
};

/**
 * The join with Radarr and Sonarr is on these three ids, and Plex reports them
 * in two mutually exclusive shapes depending on the agent the library was built
 * with. A library on a legacy agent whose ids were dropped would produce items
 * with no ids at all — indistinguishable from a Plex library that genuinely
 * shares nothing, which would make `get_library` report every film as
 * `arr_only`. Both shapes are read for that reason.
 */
export function externalIds(item: RawPlexItem): { tmdb?: number; tvdb?: number; imdb?: string } {
    const out: { tmdb?: number; tvdb?: number; imdb?: string } = {};

    if (Array.isArray(item.Guid) && item.Guid.length > 0) {
        for (const g of item.Guid) {
            const m = /^(imdb|tmdb|tvdb):\/\/(.+)$/.exec(g.id ?? '');
            if (m === null) continue;
            const [, scheme, value] = m as unknown as [string, string, string];
            if (scheme === 'imdb') out.imdb = value;
            else {
                const n = numericId(value.split('/')[0]);
                if (n !== undefined) out[scheme as 'tmdb' | 'tvdb'] = n;
            }
        }
        return out;
    }

    const legacy = /^com\.plexapp\.agents\.([a-z]+):\/\/([^?]+)/.exec(item.guid ?? '');
    if (legacy === null) return out;
    const [, agent, rest] = legacy as unknown as [string, string, string];
    const kind = LEGACY_AGENTS[agent];
    if (kind === undefined) return out;
    const value = (rest.split('/')[0] ?? '').trim();
    if (kind === 'imdb') {
        if (value !== '') out.imdb = value;
    } else {
        const n = numericId(value);
        if (n !== undefined) out[kind] = n;
    }
    return out;
}

type RawIdentity = { MediaContainer?: { version?: string } };
type RawAccount = { id?: number; name?: string };
type RawSection = { key?: string; type?: string };

/** Plex library item types, for `?type=` on `/library/sections/{key}/all`. */
const PLEX_TYPE_EPISODE = 4;

/**
 * `ServiceHttp` has no per-request header hook. Plex's documented paging is
 * `X-Plex-Container-Start`/`X-Plex-Container-Size` **headers**, but those are
 * passed here as query parameters instead — Plex accepts both forms, and a
 * query parameter keeps paging a transport-agnostic adapter concern rather
 * than growing a header hook every other service would also need. If a live
 * server ignores the query form, that is when `ServiceHttp` grows one, for
 * every service — not just this one.
 */
const PAGE_SIZE = 500;

/** The server owner's fixed id in Plex's `/accounts` response. */
const OWNER_ACCOUNT_ID = 1;

export class PlexAdapter
    implements
        ServiceAdapter,
        UserDirectoryCapable,
        PlaybackCapable,
        UserLibraryCapable,
        UserSeasonsCapable,
        SearchCapable,
        MediaDetailCapable,
        // `/activities` reporting scans is unverified (question 4 for the
        // tester) — drop this from the `implements` clause, along with
        // `getScanState` below, if a live server does not report scans there.
        ScanStateCapable
{
    readonly type: ServiceId = 'plex';
    readonly id: string = 'plex';
    readonly #http: ServiceHttp;
    readonly #defaultUser: string | undefined;
    #warnedUnverifiedOwner = false;

    constructor(config: MultiUserServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('plex', config, plexToken(config.api_key), fetchImpl);
        this.#defaultUser = config.default_user;
    }

    async getVersion(): Promise<string> {
        const body = await this.#http.get<RawIdentity>('/identity');
        const version = body.MediaContainer?.version;
        if (version === undefined) {
            throw new ServiceError('UpstreamError', this.id, '/identity returned no version field');
        }
        return version;
    }

    /**
     * A local `X-Plex-Token` is scoped to one account, so this always answers
     * with exactly one user: the owner `/accounts` names, or `default_user`
     * when it can't. Never `/myplex/account` or anything else that reaches
     * plex.tv — see CONTRIBUTING.
     */
    async listUsers(): Promise<ServiceUser[]> {
        const body = await this.#http.get<unknown>('/accounts');
        const owner = unwrap<RawAccount>(body, 'Account').find(a => a.id === OWNER_ACCOUNT_ID);
        const name = owner?.name?.trim();

        if (name !== undefined && name !== '') {
            return [{ id: String(OWNER_ACCOUNT_ID), name }];
        }

        if (this.#defaultUser === undefined) {
            throw new ServiceError(
                'NotFound',
                this.id,
                'the server did not name the token owner and no fallback is configured',
                { remedy: 'Set services.plex.default_user to the Plex account this token belongs to.' }
            );
        }

        // /accounts is the documented candidate for naming the owner, but is
        // unverified against a live server — worth knowing at runtime if this
        // fallback is what actually ran. Logged once: every per-user call
        // reaches here, and a line per call would drown everything else.
        if (!this.#warnedUnverifiedOwner) {
            this.#warnedUnverifiedOwner = true;
            logger.warn({ service: this.id }, 'Plex did not name the token owner; using default_user unverified');
        }

        return [{ id: String(OWNER_ACCOUNT_ID), name: this.#defaultUser }];
    }

    #fence(field: string, value: string): string {
        return fenceText(value, { service: this.id, field });
    }

    #commonPlayback(user: ServiceUser, item: RawPlexItem) {
        return {
            service: this.id,
            itemId: item.ratingKey ?? '',
            title: this.#fence('title', item.title ?? ''),
            ...(item.grandparentTitle === undefined ? {} : { seriesTitle: this.#fence('grandparentTitle', item.grandparentTitle) }),
            ...(item.parentIndex === undefined ? {} : { season: item.parentIndex }),
            ...(item.index === undefined ? {} : { episode: item.index }),
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

    /**
     * `/library/onDeck` mixes resume and next-up rows with nothing marking
     * which is which — unverified against a live server (question 3 for the
     * tester). Until answered: a non-zero `viewOffset` reads as `resume`, its
     * absence (or zero) as `next_up`. `getPlayback` reads this concurrently
     * with sessions, exactly as `jellyfin.ts` reads `/Sessions` alongside its
     * resumable list, and keeps only the resume half; `getNextUp` reads the
     * same endpoint again and keeps only the other half.
     *
     * onDeck rows carry no per-user field in the documented shape — unlike
     * sessions, which are server-wide. A local token names exactly one
     * account (see `listUsers`), so every row here is that account's by
     * construction and needs no filter.
     */
    static #isResuming(item: RawPlexItem): boolean {
        return typeof item.viewOffset === 'number' && item.viewOffset > 0;
    }

    async getPlayback(user: ServiceUser): Promise<PlaybackEntry[]> {
        const [sessions, onDeck] = await Promise.all([
            this.#http.get<unknown>('/status/sessions'),
            this.#http.get<unknown>('/library/onDeck')
        ]);

        const nowPlaying: PlaybackEntry[] = unwrap<RawPlexItem>(sessions, 'Metadata')
            // Compared as strings: Plex's XML-derived JSON is inconsistent
            // about whether an id comes back as a string or a number, and a
            // strict `===` against a number would drop every session.
            .filter(item => String(item.User?.id) === user.id)
            .map(item => ({
                ...this.#commonPlayback(user, item),
                kind: 'now_playing' as const,
                ...this.#progress(msToSeconds(item.viewOffset), msToSeconds(item.duration)),
                ...(item.Player?.title === undefined ? {} : { device: item.Player.title })
            }));

        const resuming: PlaybackEntry[] = unwrap<RawPlexItem>(onDeck, 'Metadata')
            .filter(PlexAdapter.#isResuming)
            .map(item => ({
                ...this.#commonPlayback(user, item),
                kind: 'resume' as const,
                ...this.#progress(msToSeconds(item.viewOffset), msToSeconds(item.duration))
            }));

        return [...nowPlaying, ...resuming];
    }

    async getNextUp(user: ServiceUser): Promise<PlaybackEntry[]> {
        const body = await this.#http.get<unknown>('/library/onDeck');
        return unwrap<RawPlexItem>(body, 'Metadata')
            .filter(item => !PlexAdapter.#isResuming(item))
            .map(item => ({ ...this.#commonPlayback(user, item), kind: 'next_up' as const }));
    }

    async getWatchHistory(user: ServiceUser): Promise<PlaybackEntry[]> {
        // Server-wide, not per-user — every account's rows come back
        // together, so the filter below is load-bearing: without it, another
        // household member's viewing would be stamped with this user's name.
        // An explicit size cap matches jellyfin.ts's `Limit=500` on the same
        // read, rather than trusting an undocumented server page size.
        const body = await this.#http.get<unknown>(`/status/sessions/history/all?X-Plex-Container-Size=${PAGE_SIZE}`);
        return unwrap<RawPlexItem>(body, 'Metadata')
            // No accountID, no attribution — excluding is safer than
            // guessing whose watch this was.
            .filter(item => item.accountID !== undefined && String(item.accountID) === user.id)
            .map(item => {
                const lastPlayed = epochToIso(item.lastViewedAt);
                return {
                    ...this.#commonPlayback(user, item),
                    kind: 'watched' as const,
                    ...(lastPlayed === undefined ? {} : { lastPlayed })
                };
            });
    }

    /**
     * Reads one library section to the end. The tester's library is a few
     * thousand items, so an unpaged read is a live risk, not a theoretical
     * one — looping until a short page comes back is what stops one call
     * pulling the whole thing at once.
     *
     * The query-parameter paging form is a guess (see `PAGE_SIZE`'s comment);
     * if the server ignores it, every page is identical and `rows.length <
     * PAGE_SIZE` never fires. Rather than spin until timeout or OOM, a
     * repeated first `ratingKey` across pages is treated as proof paging did
     * not advance and thrown as a diagnosis. `MAX_PAGES` is a backstop for a
     * server that varies its non-paged answer some other way.
     */
    async #paged(key: string, type?: number): Promise<RawPlexItem[]> {
        const MAX_PAGES = 1000;
        const out: RawPlexItem[] = [];
        let previousFirstKey: string | undefined;
        for (let start = 0; ; start += PAGE_SIZE) {
            if (start / PAGE_SIZE >= MAX_PAGES) {
                throw new ServiceError('UpstreamError', this.id, `library section ${key} did not finish paging after ${MAX_PAGES} pages`, {
                    remedy: 'This is a backstop, not an expected outcome — check whether the section genuinely holds that many items.'
                });
            }
            const typeParam = type === undefined ? '' : `type=${type}&`;
            const body = await this.#http.get<unknown>(
                `/library/sections/${encodeURIComponent(key)}/all?${typeParam}includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}`
            );
            const rows = unwrap<RawPlexItem>(body, 'Metadata');
            const firstKey = rows[0]?.ratingKey;
            if (start > 0 && firstKey !== undefined && firstKey === previousFirstKey) {
                throw new ServiceError('UpstreamError', this.id, `library section ${key} did not advance past start=0 — the same item led every page`, {
                    remedy: 'Plex appears to be ignoring X-Plex-Container-Start/Size as query parameters. It documents these as request headers instead, which ServiceHttp does not yet send.'
                });
            }
            previousFirstKey = firstKey;
            out.push(...rows);
            if (rows.length < PAGE_SIZE) return out;
        }
    }

    async #sections(...types: string[]): Promise<(RawSection & { key: string })[]> {
        const body = await this.#http.get<unknown>('/library/sections');
        return unwrap<RawSection>(body, 'Directory').filter(
            (s): s is RawSection & { key: string } => typeof s.key === 'string' && types.includes(s.type ?? '')
        );
    }

    /**
     * A movie's `viewCount > 0` is "watched" — Plex has no partial-watch
     * state for a film. A show's `viewCount` counts *views*, not completion
     * (three replays of one episode would outscore a finished season), so a
     * series instead reads Plex's own `viewedLeafCount`/`leafCount` pair.
     * When a listing omits either, the honest answer is "unknown", not a
     * guess built from the wrong field — so `watched` is left off entirely.
     */
    static #watched(item: RawPlexItem, kind: 'movie' | 'series'): boolean | undefined {
        if (kind === 'movie') return (item.viewCount ?? 0) > 0;
        if (item.viewedLeafCount === undefined || item.leafCount === undefined) return undefined;
        return item.viewedLeafCount === item.leafCount;
    }

    #toIndexItem(user: ServiceUser, item: RawPlexItem, kind: 'movie' | 'series'): IndexInput {
        const lastPlayed = epochToIso(item.lastViewedAt);
        const watched = PlexAdapter.#watched(item, kind);
        return {
            kind,
            title: this.#fence('title', item.title ?? ''),
            ...(item.year === undefined ? {} : { year: item.year }),
            ...(item.Genre === undefined
                ? {}
                : {
                      genres: item.Genre.map(g => g.tag)
                          .filter((t): t is string => typeof t === 'string')
                          .map(t => this.#fence('Genre', t))
                  }),
            ids: externalIds(item),
            playback: {
                user: user.name,
                ...(watched === undefined ? {} : { watched }),
                ...(item.viewCount === undefined ? {} : { playCount: item.viewCount }),
                ...(lastPlayed === undefined ? {} : { lastPlayed })
            }
        };
    }

    async listUserLibrary(user: ServiceUser): Promise<IndexInput[]> {
        const sections = await this.#sections('movie', 'show');
        const out: IndexInput[] = [];
        for (const section of sections) {
            const items = await this.#paged(section.key);
            const kind = section.type === 'movie' ? ('movie' as const) : ('series' as const);
            out.push(...items.map(item => this.#toIndexItem(user, item, kind)));
        }
        return out;
    }

    /**
     * Per-season watch state for every series in a show section.
     *
     * A second, independent read from `listUserLibrary` — deliberately not
     * shared, the same reasoning `jellyfin.ts` documents on its own
     * `listUserSeasons`: independent failure is the point. Episodes come from
     * `?type=4` on the same paged endpoint, standard Plex library-type
     * filtering (1 movie, 2 show, 3 season, 4 episode), and carry
     * `grandparentRatingKey` linking back to the series — never an external
     * id of their own, so the join happens here rather than per-episode.
     */
    async listUserSeasons(_user: ServiceUser): Promise<IndexInput[]> {
        const sections = await this.#sections('show');

        const series: RawPlexItem[] = [];
        const episodes: RawPlexItem[] = [];
        for (const section of sections) {
            series.push(...(await this.#paged(section.key)));
            episodes.push(...(await this.#paged(section.key, PLEX_TYPE_EPISODE)));
        }

        const bySeries = new Map<string, Map<number, { watched: number; lastPlayed?: string }>>();
        for (const ep of episodes) {
            const seriesId = ep.grandparentRatingKey;
            const season = ep.parentIndex;
            if (seriesId === undefined || season === undefined) continue;

            const seasons = bySeries.get(seriesId) ?? new Map<number, { watched: number; lastPlayed?: string }>();
            bySeries.set(seriesId, seasons);

            const row = seasons.get(season) ?? { watched: 0 };
            if ((ep.viewCount ?? 0) > 0) row.watched += 1;
            const played = epochToIso(ep.lastViewedAt);
            if (played !== undefined && (row.lastPlayed === undefined || played > row.lastPlayed)) {
                row.lastPlayed = played;
            }
            seasons.set(season, row);
        }

        return series
            .filter((s): s is RawPlexItem & { ratingKey: string } => typeof s.ratingKey === 'string' && bySeries.has(s.ratingKey))
            .map(s => ({
                kind: 'series' as const,
                title: this.#fence('title', s.title ?? ''),
                ids: externalIds(s),
                seasons: [...(bySeries.get(s.ratingKey) ?? new Map<number, { watched: number; lastPlayed?: string }>()).entries()]
                    .map(([season, row]) => ({
                        season,
                        watched: row.watched,
                        ...(row.lastPlayed === undefined ? {} : { lastPlayed: row.lastPlayed })
                    }))
                    .sort((a, b) => a.season - b.season)
            }))
            // No external id, no join — see the identical filter in
            // jellyfin.ts's listUserSeasons for why this is dropped rather
            // than emitted as a second, seasons-only copy of the title.
            .filter(row => Object.keys(row.ids).length > 0);
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];

        const body = await this.#http.get<unknown>(`/search?query=${encodeURIComponent(query)}`);
        return unwrap<RawPlexItem>(body, 'Metadata')
            .filter(
                (i): i is RawPlexItem & { ratingKey: string } =>
                    typeof i.ratingKey === 'string' && (i.type === 'movie' || i.type === 'show')
            )
            .map(i => ({
                service: this.id,
                source: 'library' as const,
                kind: i.type === 'show' ? ('series' as const) : ('movie' as const),
                id: i.ratingKey,
                title: this.#fence('title', i.title ?? ''),
                ...(i.year === undefined ? {} : { year: i.year }),
                ids: externalIds(i)
            }));
    }

    /**
     * Plex's ids are numeric strings — a weaker check than Jellyfin's 32-hex
     * item id, since it cannot tell a Plex rating key from a Radarr or Sonarr
     * id by shape alone. The remedy carries the weight that check can't.
     */
    #ratingKey(id: string): string {
        const clean = id.trim();
        if (!/^\d+$/.test(clean)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a Plex rating key`, {
                remedy: 'Plex ids are numeric. Take one from a plex hit in search_media, or from get_playback’s itemId.'
            });
        }
        return clean;
    }

    async getMediaDetails(id: string): Promise<MediaDetails> {
        const ratingKey = this.#ratingKey(id);
        const body = await this.#http.get<unknown>(`/library/metadata/${ratingKey}`);
        const item = unwrap<RawPlexItem>(body, 'Metadata')[0];
        if (item === undefined) {
            throw new ServiceError('NotFound', this.id, `no item with id ${id}`, {
                remedy: 'Check the id came from a plex hit in search_media or get_playback rather than another service.'
            });
        }

        const file = item.Media?.[0]?.Part?.[0];
        return {
            service: this.id,
            // Mirrors jellyfin.ts: only a confirmed 'movie' or 'show' earns
            // that kind. Guessing 'movie' for anything else — an episode, a
            // season — would make diagnose/evidence.ts scan the wrong index
            // and silently miss real hits.
            kind: item.type === 'movie' ? 'movie' : item.type === 'show' ? 'series' : 'item',
            id: ratingKey,
            title: this.#fence('title', item.title ?? ''),
            ...(item.year === undefined ? {} : { year: item.year }),
            ...(item.summary === undefined ? {} : { overview: this.#fence('summary', item.summary) }),
            ...(file?.size === undefined ? {} : { sizeBytes: file.size }),
            ...(file?.file === undefined ? {} : { path: this.#fence('file', file.file) }),
            ids: externalIds(item)
        };
    }

    /**
     * `/activities` is Plex's documented endpoint for in-progress background
     * tasks, unverified against a live server — question 4 for the tester.
     * `diagnose`'s scan stage is a blocking verdict ("a scan is running,
     * check back later"), so over-reporting on an unrelated activity — a
     * thumbnail generation, a metadata refresh — stalls the caller with a
     * wrong answer; matching on `type` rather than mere presence is what
     * keeps that failure mode rare instead of routine.
     *
     * The exact `type` vocabulary for a library scan is itself unverified —
     * `library` and `refresh` are a guess at the two words most likely to
     * appear in it, checked case-insensitively. Drop this method, and
     * `ScanStateCapable` from the `implements` clause above, if a live
     * server does not report scans here at all — `diagnose`'s scan stage
     * already handles `scanCapable: false` honestly.
     */
    async getScanState(): Promise<ScanState> {
        const body = await this.#http.get<unknown>('/activities');
        const activities = unwrap<{ type?: string }>(body, 'Activity');
        const running = activities.some(a => /library|refresh/i.test(a.type ?? ''));
        return { service: this.id, running };
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
