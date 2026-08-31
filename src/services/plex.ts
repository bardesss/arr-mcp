import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import { plexToken } from '../core/auth.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { logger } from '../core/logger.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type PlaybackCapable,
    type PlaybackEntry,
    type ServiceAdapter,
    type ServiceUser,
    type UserDirectoryCapable
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
    /** `/status/sessions` only — who is watching. */
    User?: { id?: string; title?: string };
    /** `/status/sessions` only — what they are watching on. */
    Player?: { title?: string };
    /** Episodes from `/library/sections/{key}/all?type=4` — the series' ratingKey. */
    grandparentRatingKey?: string;
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

/** The server owner's fixed id in Plex's `/accounts` response. */
const OWNER_ACCOUNT_ID = 1;

export class PlexAdapter implements ServiceAdapter, UserDirectoryCapable, PlaybackCapable {
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

    async getPlayback(user: ServiceUser): Promise<PlaybackEntry[]> {
        const sessions = await this.#http.get<unknown>('/status/sessions');
        return unwrap<RawPlexItem>(sessions, 'Metadata')
            .filter(item => item.User?.id === user.id)
            .map(item => ({
                ...this.#commonPlayback(user, item),
                kind: 'now_playing' as const,
                ...this.#progress(msToSeconds(item.viewOffset), msToSeconds(item.duration)),
                ...(item.Player?.title === undefined ? {} : { device: item.Player.title })
            }));
    }

    /**
     * `/library/onDeck` mixes resume and next-up rows with nothing marking
     * which is which — unverified against a live server (question 3 for the
     * tester). Until answered: a non-zero `viewOffset` reads as `resume`, its
     * absence as `next_up`, and only the latter is reported here.
     */
    async getNextUp(user: ServiceUser): Promise<PlaybackEntry[]> {
        const body = await this.#http.get<unknown>('/library/onDeck');
        return unwrap<RawPlexItem>(body, 'Metadata')
            .filter(item => !(typeof item.viewOffset === 'number' && item.viewOffset > 0))
            .map(item => ({ ...this.#commonPlayback(user, item), kind: 'next_up' as const }));
    }

    async getWatchHistory(user: ServiceUser): Promise<PlaybackEntry[]> {
        const body = await this.#http.get<unknown>('/status/sessions/history/all');
        return unwrap<RawPlexItem>(body, 'Metadata').map(item => {
            const lastPlayed = epochToIso(item.lastViewedAt);
            return {
                ...this.#commonPlayback(user, item),
                kind: 'watched' as const,
                ...(lastPlayed === undefined ? {} : { lastPlayed })
            };
        });
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
