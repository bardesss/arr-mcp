import type { ServiceId } from '../config/schema.ts';
import { fenceText } from '../core/fence.ts';
import type { ArrKind } from '../core/resolver.ts';
import type { WebhookEntry } from '../core/webhookEvents.ts';
import type { HistoryEventType } from './types.ts';
import { episodeCode } from '../core/labels.ts';

/**
 * Services with captured payloads (`test/fixtures/webhooks/`). Anything else gets
 * a 404: a shape nobody has seen would be stored as guesses. Whisparr is also out
 * because titles are stored, and on Whisparr the titles are the sensitive part.
 */
export const WEBHOOK_SERVICES: Partial<Record<ServiceId, ArrKind>> = { radarr: 'movie', sonarr: 'series', lidarr: 'artist' };

/** What the config page tells people to type. Any username is accepted. */
export const WEBHOOK_USERNAME = 'arr-mcp';

/**
 * Reads a Radarr, Sonarr or Lidarr webhook payload into a history row.
 *
 * Every field is named here, so a payload's paths, URLs, release names and
 * instance name never reach the store: what is not read is not kept. The shapes
 * come from `test/fixtures/webhooks/`, captured live.
 *
 * Only events with a captured payload are mapped. `Rename`,
 * `ManualInteractionRequired` and `Health` have none yet, so they are `unknown`
 * with `rawEvent` saying what they were, the same way `arrHistory.ts` treats a
 * spelling it has not seen.
 */
const EVENT: Record<string, HistoryEventType> = {
    Grab: 'grabbed',
    Download: 'imported',
    MovieFileDelete: 'deleted',
    EpisodeFileDelete: 'deleted',
    MovieDelete: 'deleted',
    SeriesDelete: 'deleted',
    MovieAdded: 'added',
    SeriesAdd: 'added',
    AlbumDelete: 'deleted',
    ArtistDelete: 'deleted',
    ArtistAdd: 'added'
};

/**
 * Captured on Lidarr 3.1.6 only. Its `DownloadFailure` carries no artist or
 * album, just the release name (not kept) and download id, so the row has no
 * title and its download id links it to the grab. Radarr's and Sonarr's have
 * not been captured.
 */
const LIDARR_EVENT: Record<string, HistoryEventType> = { DownloadFailure: 'failed' };

type Row = Record<string, unknown>;

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const IMDB_ID = /^tt\d+$/;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const rowOf = (value: unknown): Row =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? value.map(rowOf) : []);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const positive = (value: unknown): number | undefined => (typeof value === 'number' && value > 0 ? value : undefined);

/** `S01E03`, or nothing for a row without the numbers. */
function episodeLabel(episode: Row): string | undefined {
    const season = positive(episode.seasonNumber) ?? (episode.seasonNumber === 0 ? 0 : undefined);
    const number = positive(episode.episodeNumber);
    if (season === undefined || number === undefined) return undefined;
    return episodeCode(season, number);
}

/**
 * A file delete says why. A title delete only says whether the files went too.
 * Lidarr 3.1.6 follows an artist delete with an `AlbumDelete` per album that
 * says `deletedFiles: false` even when the artist's files went, so on an
 * `AlbumDelete` only `true` is believed.
 */
function reasonOf(body: Row): string | undefined {
    const reason = text(body.deleteReason);
    if (reason !== undefined) return reason;
    if (body.deletedFiles === true) return 'files deleted';
    if (body.deletedFiles === false && body.eventType !== 'AlbumDelete') return 'files kept';
    return undefined;
}

/** `Artist - Album`: a Grab names `albums`, the others one `album`. */
function artistTitle(payload: Row, artist: Row): string {
    const albums = (payload.albums === undefined ? [rowOf(payload.album)] : rowsOf(payload.albums)).flatMap(a => text(a.title) ?? []);
    return [text(artist.name), albums.join(', ')].filter((part): part is string => part !== undefined && part !== '').join(' - ');
}

/**
 * Undefined for a `Test`, which is not an event, and for a body with no usable
 * `eventType`. `kind` decides whether the title is under `movie`, `series` or
 * `artist`, because an instance's type is known and the payload's claim need
 * not be trusted.
 *
 * Lidarr 3.1.6 sends an upgrade as a `Download` with `isUpgrade: false` and no
 * deleted files, so an upgrade reads as an import.
 */
export function parseArrWebhook(instance: string, kind: ArrKind, body: unknown, receivedAt: string): WebhookEntry | undefined {
    const payload = rowOf(body);
    const eventType = payload.eventType;
    if (typeof eventType !== 'string' || !EVENT_NAME.test(eventType) || eventType === 'Test') return undefined;

    const media = rowOf(kind === 'movie' ? payload.movie : kind === 'series' ? payload.series : payload.artist);
    const episodes = kind === 'series' ? rowsOf(payload.episodes) : [];
    const labels = episodes.flatMap(episode => episodeLabel(episode) ?? []);
    const name = text(media.title);
    const title =
        kind === 'artist'
            ? artistTitle(payload, media)
            : name === undefined
              ? ''
              : [name, labels.join(', ')].filter(part => part !== '').join(' ');

    const release = rowOf(payload.release);
    const file = rowOf(payload.movieFile ?? payload.episodeFile ?? rowsOf(payload.episodeFiles)[0] ?? rowsOf(payload.trackFiles)[0]);
    const quality = text(release.quality) ?? text(file.quality) ?? text(payload.quality);
    const indexer = text(release.indexer);
    const downloadId = text(payload.downloadId)?.toLowerCase();
    const reason = reasonOf(payload);
    const mediaId = positive(media.id);
    const episodeId = episodes.length === 1 ? positive(episodes[0]?.id) : undefined;

    const tmdb = positive(media.tmdbId);
    const tvdb = positive(media.tvdbId);
    const imdb = text(media.imdbId);
    const mbid = text(media.mbId);
    const externalIds = {
        ...(tmdb === undefined ? {} : { tmdb }),
        ...(tvdb === undefined ? {} : { tvdb }),
        ...(imdb === undefined || !IMDB_ID.test(imdb) ? {} : { imdb }),
        ...(mbid === undefined || !MBID.test(mbid) ? {} : { mbid })
    };

    return {
        service: instance,
        at: receivedAt,
        event: EVENT[eventType] ?? (kind === 'artist' ? LIDARR_EVENT[eventType] : undefined) ?? 'unknown',
        rawEvent: eventType,
        title: fenceText(title, { service: instance, field: 'title' }),
        ...(mediaId === undefined ? {} : { mediaId: String(mediaId) }),
        ...(episodeId === undefined ? {} : { episodeId: String(episodeId) }),
        ...(indexer === undefined ? {} : { indexer: fenceText(indexer, { service: instance, field: 'indexer' }) }),
        ...(quality === undefined ? {} : { quality }),
        ...(reason === undefined ? {} : { reason: fenceText(reason, { service: instance, field: 'reason' }) }),
        ...(downloadId === undefined ? {} : { downloadId }),
        ...(Object.keys(externalIds).length === 0 ? {} : { externalIds })
    };
}
