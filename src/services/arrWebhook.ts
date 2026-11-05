import type { ServiceId } from '../config/schema.ts';
import { fenceText } from '../core/fence.ts';
import type { LibraryKind } from '../core/resolver.ts';
import type { WebhookEntry } from '../core/webhookEvents.ts';
import type { HistoryEventType } from './types.ts';

/**
 * Services with captured payloads (`test/fixtures/webhooks/`). Anything else gets
 * a 404: a shape nobody has seen would be stored as guesses. Whisparr is also out
 * because titles are stored, and on Whisparr the titles are the sensitive part.
 */
export const WEBHOOK_SERVICES: Partial<Record<ServiceId, LibraryKind>> = { radarr: 'movie', sonarr: 'series' };

/** What the config page tells people to type. Any username is accepted. */
export const WEBHOOK_USERNAME = 'arr-mcp';

/**
 * Reads a Radarr or Sonarr webhook payload into a history row.
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
    SeriesAdd: 'added'
};

type Row = Record<string, unknown>;

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const IMDB_ID = /^tt\d+$/;

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
    return `S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}`;
}

/** A file delete says why. A title delete only says whether the files went too. */
function reasonOf(body: Row): string | undefined {
    const reason = text(body.deleteReason);
    if (reason !== undefined) return reason;
    if (typeof body.deletedFiles === 'boolean') return body.deletedFiles ? 'files deleted' : 'files kept';
    return undefined;
}

/**
 * Undefined for a `Test`, which is not an event, and for a body with no usable
 * `eventType`. `kind` decides whether the title is under `movie` or `series`,
 * because an instance's type is known and the payload's claim need not be trusted.
 */
export function parseArrWebhook(instance: string, kind: LibraryKind, body: unknown, receivedAt: string): WebhookEntry | undefined {
    const payload = rowOf(body);
    const eventType = payload.eventType;
    if (typeof eventType !== 'string' || !EVENT_NAME.test(eventType) || eventType === 'Test') return undefined;

    const media = rowOf(kind === 'movie' ? payload.movie : payload.series);
    const episodes = kind === 'series' ? rowsOf(payload.episodes) : [];
    const labels = episodes.flatMap(episode => episodeLabel(episode) ?? []);
    const name = text(media.title);
    const title = name === undefined ? '' : [name, labels.join(', ')].filter(part => part !== '').join(' ');

    const release = rowOf(payload.release);
    const file = rowOf(payload.movieFile ?? payload.episodeFile ?? rowsOf(payload.episodeFiles)[0]);
    const quality = text(release.quality) ?? text(file.quality);
    const indexer = text(release.indexer);
    const downloadId = text(payload.downloadId)?.toLowerCase();
    const reason = reasonOf(payload);
    const mediaId = positive(media.id);
    const episodeId = episodes.length === 1 ? positive(episodes[0]?.id) : undefined;

    const tmdb = positive(media.tmdbId);
    const tvdb = positive(media.tvdbId);
    const imdb = text(media.imdbId);
    const externalIds = {
        ...(tmdb === undefined ? {} : { tmdb }),
        ...(tvdb === undefined ? {} : { tvdb }),
        ...(imdb === undefined || !IMDB_ID.test(imdb) ? {} : { imdb })
    };

    return {
        service: instance,
        at: receivedAt,
        event: EVENT[eventType] ?? 'unknown',
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
