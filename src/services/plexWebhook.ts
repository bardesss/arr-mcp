import { fenceText } from '../core/fence.ts';
import { recordIds, type PlayRecord, type WebhookPlay } from '../core/playHistory.ts';
import { externalIds, OWNER_ACCOUNT_ID } from './plex.ts';
import { IMDB_ID, text, whole } from './webhookFields.ts';

/**
 * The JSON in a Plex webhook's `payload` part (captured on Plex Media Server
 * 1.43.5). Plex sends every event of every server the account plays on to the
 * same URL: `user` is true for the account's own play and `owner` when that
 * account owns the server. Only the fields a play record needs are typed.
 */
type PlexWebhookPayload = {
    event?: unknown;
    user?: unknown;
    owner?: unknown;
    Account?: { title?: unknown } | null;
    Server?: { uuid?: unknown } | null;
    Metadata?: {
        type?: unknown;
        ratingKey?: unknown;
        title?: unknown;
        grandparentTitle?: unknown;
        parentIndex?: unknown;
        index?: unknown;
        year?: unknown;
        parentYear?: unknown;
        lastViewedAt?: unknown;
        Guid?: unknown;
        guid?: unknown;
    } | null;
};

/**
 * A title as Plex sent it, if it has anything in it. Fenced untrimmed, as the
 * adapter fences it, since a deleted item's row is matched on its title.
 */
const asSent = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

const positiveYear = (v: unknown): number | undefined => {
    const year = whole(v);
    return year === undefined || year === 0 ? undefined : year;
};

const EARLIEST_PLAY = Date.UTC(2000, 0, 1) / 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When Plex counted the play: `lastViewedAt`, in epoch seconds, is the second
 * it sent the scrobble. The body is only as trusted as whoever holds the
 * secret, so a value that is missing, not whole seconds, before 2000 or more
 * than a day ahead gives way to the time the request came in.
 */
const playedAt = (v: unknown, now: Date): string => {
    const seconds = whole(v);
    const plausible = seconds !== undefined && seconds >= EARLIEST_PLAY && seconds * 1000 <= now.getTime() + DAY_MS;
    return (plausible ? new Date(seconds * 1000) : now).toISOString();
};

/**
 * A film's ids, read as the adapter reads them: the `Guid` rows a modern agent
 * gives, else a legacy agent's `guid`. Only `{ id }` rows are kept, and an imdb
 * id only if it looks like one.
 */
const idsOf = (md: { Guid?: unknown; guid?: unknown }): PlayRecord['ids'] => {
    const rows = Array.isArray(md.Guid)
        ? md.Guid.filter((g): g is { id: string } => typeof g === 'object' && g !== null && typeof (g as { id?: unknown }).id === 'string')
        : [];
    const { tmdb, tvdb, imdb } = externalIds({ Guid: rows, ...(typeof md.guid === 'string' ? { guid: md.guid } : {}) });
    return recordIds({ tmdb, tvdb, imdb: imdb !== undefined && IMDB_ID.test(imdb) ? imdb : undefined });
};

/**
 * A scrobble of the owner's own play as a store record, with the server it
 * was played on, or `undefined` for anything else: another event, someone
 * else's play, a server the account does not own, a `ratingKey` that is not a
 * Plex one, or an item that is not a film or an episode (or a track, with
 * `music` on). The route compares the server with this one's
 * `machineIdentifier`, so only a play it would keep costs that read.
 *
 * Kept under the owner's user id and the `ratingKey`, with titles fenced as
 * the adapter fences them, so the hourly sync's sighting of the same play
 * lands on this row. A film keeps the year and ids Plex sends. An episode
 * keeps neither: Plex sends the episode's own (its `year` is its own air
 * date's), while the store keeps the series' on an episode, which the next
 * sync fills in while the series is in the library. A track keeps its artist
 * (`grandparentTitle`) as `seriesTitle` and its album's year (`parentYear`);
 * the sync never reads tracks, and a track is never matched against a film or
 * an episode.
 */
export function parsePlexPlay(service: string, body: unknown, opts: { music: boolean; now?: Date }): { server: string; play: WebhookPlay } | undefined {
    const p = (body ?? {}) as PlexWebhookPayload;
    const server = text(p.Server?.uuid);
    if (p.event !== 'media.scrobble' || p.user !== true || p.owner !== true || server === undefined) return undefined;

    const md = p.Metadata ?? {};
    const ratingKey = text(md.ratingKey);
    const title = asSent(md.title);
    const wanted = md.type === 'movie' || md.type === 'episode' || (md.type === 'track' && opts.music);
    if (!wanted || ratingKey === undefined || !/^\d+$/.test(ratingKey) || title === undefined) return undefined;

    const userId = String(OWNER_ACCOUNT_ID);
    const series = asSent(md.grandparentTitle);
    const entry = {
        service,
        kind: 'watched' as const,
        itemId: ratingKey,
        title: fenceText(title, { service, field: 'title' }),
        user: fenceText(text(p.Account?.title) ?? '', { service, field: 'Account.title' }),
        lastPlayed: playedAt(md.lastViewedAt, opts.now ?? new Date())
    };

    if (md.type === 'movie') {
        const year = positiveYear(md.year);
        const ids = idsOf(md);
        return {
            server,
            play: { userId, record: { entry, kind: 'movie', ...(year === undefined ? {} : { year }), ...(ids === undefined ? {} : { ids }) } }
        };
    }

    if (md.type === 'episode') {
        if (series === undefined) return undefined;
        const season = whole(md.parentIndex);
        const episode = whole(md.index);
        return {
            server,
            play: {
                userId,
                record: {
                    entry: {
                        ...entry,
                        seriesTitle: fenceText(series, { service, field: 'grandparentTitle' }),
                        ...(season === undefined ? {} : { season }),
                        ...(episode === undefined ? {} : { episode })
                    },
                    kind: 'episode'
                }
            }
        };
    }

    const year = positiveYear(md.parentYear);
    return {
        server,
        play: {
            userId,
            record: {
                entry: { ...entry, ...(series === undefined ? {} : { seriesTitle: fenceText(series, { service, field: 'grandparentTitle' }) }) },
                kind: 'track',
                ...(year === undefined ? {} : { year })
            }
        }
    };
}
