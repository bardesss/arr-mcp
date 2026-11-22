import { fenceText } from '../core/fence.ts';
import type { PlayRecord } from '../core/playHistory.ts';

/**
 * A Jellyfin Webhook plugin payload from its Generic destination. With "Send
 * All Properties" on it is a form of every template variable (captured on
 * 12.4.0); with the template below it is JSON with the same keys. Every value
 * arrives as a string: ids as 32 lowercase hex, `PlayedToCompletion` as
 * `True` or `False`, an episode's `Year` as its series' year.
 */
type JellyfinPlayPayload = {
    NotificationType?: unknown;
    ItemId?: unknown;
    ItemType?: unknown;
    Name?: unknown;
    SeriesName?: unknown;
    SeasonNumber?: unknown;
    EpisodeNumber?: unknown;
    Year?: unknown;
    Provider_tmdb?: unknown;
    Provider_imdb?: unknown;
    Provider_tvdb?: unknown;
    UserId?: unknown;
    NotificationUsername?: unknown;
    PlayedToCompletion?: unknown;
    /** A song's first artist; the plugin sends no album artist and no track number. */
    Artist?: unknown;
};

/** The template the config page and docs give, for a destination without "Send All Properties". */
export const JELLYFIN_PLAY_TEMPLATE = JSON.stringify({
    NotificationType: '{{NotificationType}}',
    ItemId: '{{ItemId}}',
    ItemType: '{{ItemType}}',
    Name: '{{Name}}',
    SeriesName: '{{SeriesName}}',
    SeasonNumber: '{{SeasonNumber}}',
    EpisodeNumber: '{{EpisodeNumber}}',
    Year: '{{Year}}',
    Provider_tmdb: '{{Provider_tmdb}}',
    Provider_imdb: '{{Provider_imdb}}',
    Provider_tvdb: '{{Provider_tvdb}}',
    UserId: '{{UserId}}',
    NotificationUsername: '{{NotificationUsername}}',
    PlayedToCompletion: '{{PlayedToCompletion}}',
    Artist: '{{Artist}}'
});

const text = (v: unknown): string | undefined => {
    if (typeof v === 'number') return String(v);
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
};

const whole = (v: unknown): number | undefined => {
    const t = text(v);
    return t !== undefined && /^\d+$/.test(t) ? Number(t) : undefined;
};

/**
 * Jellyfin's API gives ids as 32 lowercase hex; a .NET Guid printed by the
 * plugin may be dashed or upper case. One form, or the same item and user
 * would be stored twice.
 */
const jellyfinId = (v: unknown): string | undefined => text(v)?.replaceAll('-', '').toLowerCase();

type JellyfinPlay = { userId: string; record: PlayRecord };

/**
 * A finished play as a store record, or `undefined` for anything else the
 * plugin sends: other notification types, a stop partway through (the hourly
 * sync reads those from the activity log), or a stop of anything but a film,
 * an episode or a song. A song comes only when the destination's Item Type
 * includes Music, which is how a user opts into keeping their listening.
 *
 * Titles are fenced under the fields the adapter fences them under, so a
 * webhook row and a synced row of the same item agree. An episode keeps the
 * series' year (which is what the plugin sends) and no ids, since the ids it
 * sends are the episode's and the store keeps the series' on an episode.
 */
export function parseJellyfinPlay(service: string, body: unknown): JellyfinPlay | undefined {
    const p = (body ?? {}) as JellyfinPlayPayload;
    if (text(p.NotificationType) !== 'PlaybackStop') return undefined;
    if (!/^true$/i.test(text(p.PlayedToCompletion) ?? '')) return undefined;

    const type = text(p.ItemType);
    const itemId = jellyfinId(p.ItemId);
    const userId = jellyfinId(p.UserId);
    const name = text(p.Name);
    if ((type !== 'Movie' && type !== 'Episode' && type !== 'Audio') || itemId === undefined || userId === undefined || name === undefined) return undefined;

    const year = whole(p.Year);
    const entry = {
        service,
        kind: 'watched' as const,
        itemId,
        title: fenceText(name, { service, field: 'Name' }),
        user: text(p.NotificationUsername) ?? '',
        lastPlayed: new Date().toISOString()
    };

    if (type === 'Audio') {
        const artist = text(p.Artist);
        return {
            userId,
            record: {
                entry: { ...entry, ...(artist === undefined ? {} : { seriesTitle: fenceText(artist, { service, field: 'Artist' }) }) },
                kind: 'track',
                ...(year === undefined ? {} : { year })
            }
        };
    }

    if (type === 'Episode') {
        const series = text(p.SeriesName);
        if (series === undefined) return undefined;
        const season = whole(p.SeasonNumber);
        const episode = whole(p.EpisodeNumber);
        return {
            userId,
            record: {
                entry: {
                    ...entry,
                    seriesTitle: fenceText(series, { service, field: 'SeriesName' }),
                    ...(season === undefined ? {} : { season }),
                    ...(episode === undefined ? {} : { episode })
                },
                kind: 'episode',
                ...(year === undefined ? {} : { year })
            }
        };
    }

    const tmdb = whole(p.Provider_tmdb);
    const tvdb = whole(p.Provider_tvdb);
    const imdb = text(p.Provider_imdb);
    const ids = { ...(tmdb === undefined ? {} : { tmdb }), ...(tvdb === undefined ? {} : { tvdb }), ...(imdb === undefined ? {} : { imdb }) };
    return {
        userId,
        record: {
            entry,
            kind: 'movie',
            ...(year === undefined ? {} : { year }),
            ...(Object.keys(ids).length === 0 ? {} : { ids })
        }
    };
}
