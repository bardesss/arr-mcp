import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceIdSchema } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { gather } from '../core/gather.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, listText, toolInput, windowEnd, type DetailLevel } from '../core/shape.ts';
import type { WebhookEvents } from '../core/webhookEvents.ts';
import { WEBHOOK_SERVICES } from '../services/arrWebhook.ts';
import { HISTORY_EVENT_TYPES, hasHistory, type HistoryCapable, type HistoryEntry, type HistoryEventType, type ServiceAdapter } from '../services/types.ts';

/** The stored events, and whether more are being recorded. A log turned off keeps what it has. */
export type EventLog = { store: WebhookEvents; enabled: boolean };

/** Named in `degraded` when the store cannot be read. No `:`, so it costs a verdict its certainty. */
export const EVENT_LOG_SOURCE = 'event-log';

export type GetHistoryResult = {
    items: HistoryEntry[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    counts: Record<string, number>;
};

const EventTypeSchema = z
    .enum(HISTORY_EVENT_TYPES)
    .optional()
    .describe('Only entries of this normalised type. Omit for all.');

/**
 * Both the paging early-exit and the final filter in `readArrHistory` compare
 * `since` against a record's own `date` as plain strings — cheap and correct
 * for ISO 8601, but silently wrong for anything else: `'2026-08-…' < 'last
 * week'` is true, so a value like that ends paging after page one and then
 * filters out everything that made it through, answering a confident empty
 * list rather than an error.
 */
const SinceSchema = z
    .string()
    .regex(
        /^\d{4}-\d{2}-\d{2}/,
        'must start with an ISO 8601 date (YYYY-MM-DD), e.g. "2026-08-01" or "2026-08-01T00:00:00Z" — it is compared as a plain string against each record\'s own date.'
    )
    .optional()
    .describe('ISO 8601. Only entries at or after this time.');

/**
 * `guid` and `indexerId` ride along for a future release-grab tool and are
 * not otherwise useful reading; `rawEvent` is upstream's own spelling, kept
 * for the same "inspect the raw thing" reason `service`+`id` is on
 * get_media_details. Both trimmed below `full`.
 */
const project = (h: HistoryEntry, detail: DetailLevel): HistoryEntry => {
    if (detail === 'minimal') {
        return {
            service: h.service,
            id: h.id,
            at: h.at,
            event: h.event,
            title: h.title,
            ...(h.mediaId === undefined ? {} : { mediaId: h.mediaId })
        };
    }
    if (detail === 'full') return h;
    const { rawEvent: _rawEvent, guid: _guid, indexerId: _indexerId, ...rest } = h;
    return rest;
};

/**
 * One history row as a line, led by its timestamp for the reason the calendar
 * is: this is a chronology, and the time is what a reader orders it by.
 *
 * `mediaId` rather than the row's own `id`: the row id addresses the history
 * record, which no tool takes, while `mediaId` is what `get_media_details` and
 * `trigger_search` want.
 */
export function historyLine(entry: HistoryEntry): string {
    const facts: string[] = [entry.event === 'unknown' && entry.rawEvent !== undefined ? entry.rawEvent : entry.event];
    if (entry.mediaId !== undefined) facts.push(`${entry.service}:${entry.mediaId}`);
    else facts.push(entry.service);
    if (entry.quality !== undefined && entry.quality !== '') facts.push(entry.quality);
    if (entry.indexer !== undefined && entry.indexer !== '') facts.push(entry.indexer);

    if (entry.strikeCount !== undefined) facts.push(`${entry.strikeCount} strike${entry.strikeCount === 1 ? '' : 's'}`);
    // `externalIds` only a stored event has, and its reason is why a file or title went.
    if (entry.reason !== undefined && (entry.service === 'cleanuparr' || entry.service === 'reclaimerr' || entry.externalIds !== undefined)) facts.push(entry.reason);
    if (entry.oldCategory !== undefined || entry.newCategory !== undefined) facts.push(`${entry.oldCategory ?? '(none)'} → ${entry.newCategory ?? '(none)'}`);
    if (entry.downloadClient !== undefined) facts.push(`on ${entry.downloadClient}`);
    if (entry.clientRemoved === true) facts.push('on a client since deleted from Cleanuparr');
    if (entry.dryRun === true) facts.push('dry run, nothing was done');

    return `${entry.at} — ${entry.title} — ${facts.join(', ')}`;
}

export async function buildGetHistory(
    adapters: readonly ServiceAdapter[],
    opts: {
        service?: ServiceId;
        instance?: string;
        id?: string;
        eventType?: HistoryEventType;
        since?: string;
        detail: DetailLevel;
        limit: number;
        offset?: number;
    }
): Promise<GetHistoryResult> {
    // `id` names one movie, series or artist, and Radarr's movieId, Sonarr's
    // seriesId and Lidarr's artistId are different namespaces that can share a
    // number — passing it to every adapter unscoped would silently mix two
    // unrelated items' history together.
    if (opts.id !== undefined && opts.service === undefined) {
        throw new Error('`id` scopes to one movie, series or artist; pass `service` (and `instance` if it is named) to say which.');
    }

    let scoped: (ServiceAdapter & HistoryCapable)[];
    if (opts.service === undefined) {
        scoped = adapters.filter(hasHistory);
    } else {
        const adapter = resolveInstance(adapters, opts.service, opts.instance);
        // A valid, configured service with no history capability (e.g.
        // Jellyfin) must refuse rather than silently answer empty — an empty
        // result reads as "this item has no history", which is a different
        // and more misleading claim than "this service cannot answer that".
        if (!hasHistory(adapter)) {
            throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no history to return`, {
                remedy: 'radarr, sonarr, lidarr, sabnzbd, nzbget, bazarr, cleanuparr, reclaimerr, shelfmark and grimmory can answer get_history. A media server has no download history.'
            });
        }
        scoped = [adapter];
    }

    // Each service hands over its newest `want` rows and says how many it has.
    // The merged window is then the same one the whole histories would give.
    const want = windowEnd(opts.limit, opts.offset);
    const totals: Record<string, number> = {};
    const { items, degraded, counts } = await gather(
        scoped.map(a => ({
            id: a.id,
            fetch: async () => {
                const read = await a.readHistory({
                    ...(opts.id === undefined ? {} : { id: opts.id }),
                    ...(opts.since === undefined ? {} : { since: opts.since }),
                    ...(opts.eventType === undefined ? {} : { eventType: opts.eventType }),
                    want
                });
                // Filtered inside the source, not after gather, so `counts`
                // reports what each service actually contributed to this
                // answer rather than its unfiltered total.
                const rows = Array.isArray(read)
                    ? opts.eventType === undefined
                        ? read
                        : read.filter(r => r.event === opts.eventType)
                    : read.items;
                totals[a.id] = Array.isArray(read) ? rows.length : read.total;
                return rows;
            }
        }))
    );
    for (const id of Object.keys(counts)) counts[id] = totals[id] ?? counts[id] ?? 0;

    // Newest first: "why did last night's download fail" is a question about
    // the most recent attempt, not the oldest.
    items.sort((a, b) => b.at.localeCompare(a.at));

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const shaped = applyLimit(items, opts.limit, opts.offset, total);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
}

type EventLogOptions = {
    service?: ServiceId;
    instance?: string;
    id?: string;
    eventType?: HistoryEventType;
    since?: string;
    detail: DetailLevel;
    limit: number;
    offset?: number;
};

/**
 * `source: "webhooks"`: what Radarr and Sonarr reported, read from arr-mcp's own
 * store. A separate read from `buildGetHistory`, because a stored row and the
 * service's own row for the same grab would otherwise both appear.
 *
 * `service` goes through `resolveInstance`, so a stack with two Radarrs is asked
 * which, as the default source asks. That means events from an instance since
 * removed from the config are reachable only without a `service`.
 */
export function readEventLog(
    adapters: readonly ServiceAdapter[],
    log: EventLog | undefined,
    opts: EventLogOptions
): GetHistoryResult & { note?: string } {
    if (opts.id !== undefined && opts.service === undefined) {
        throw new Error('`id` scopes to one movie or series; pass `service` (and `instance` if it is named) to say which.');
    }
    if (opts.service !== undefined && !Object.hasOwn(WEBHOOK_SERVICES, opts.service)) {
        // Refused, because an empty list would read as "nothing happened to it".
        throw new ServiceError('NotFound', opts.service, `${opts.service} does not send events to arr-mcp`, {
            remedy: 'The event log only holds what Radarr and Sonarr report. Leave `source` out to read the service\'s own history.'
        });
    }
    const service = opts.service === undefined ? undefined : resolveInstance(adapters, opts.service, opts.instance).id;
    const query = {
        ...(service === undefined ? {} : { service }),
        ...(opts.id === undefined ? {} : { id: opts.id }),
        ...(opts.eventType === undefined ? {} : { eventType: opts.eventType }),
        ...(opts.since === undefined ? {} : { since: opts.since })
    };
    const OFF = 'The library event log is off, so nothing new is being recorded. Turn it on under Library event log on the Configuration page.';
    const empty = { ...applyLimit<HistoryEntry>([], opts.limit, opts.offset, 0), counts: {} };

    if (log === undefined) return { ...empty, degraded: [], note: OFF };

    let read: ReturnType<WebhookEvents['read']>;
    let counts: Record<string, number>;
    let anything: number;
    try {
        read = log.store.read({ ...query, want: windowEnd(opts.limit, opts.offset) });
        counts = log.store.counts(query);
        anything = log.store.read({ want: 0 }).total;
    } catch (err) {
        logger.warn({ err }, 'could not read the library event log');
        return { ...empty, degraded: [EVENT_LOG_SOURCE] };
    }

    const shaped = applyLimit(read.items, opts.limit, opts.offset, read.total);
    const note = !log.enabled
        ? OFF
        : anything === 0
          ? 'The library event log is on, but nothing has arrived. Each Radarr and Sonarr instance needs a webhook connection, and the Configuration page has the details.'
          : undefined;
    return {
        ...shaped,
        // `rawEvent` stays on an unknown event, because it is the only thing saying what it was.
        items: shaped.items.map(i => ({ ...project(i, opts.detail), ...(i.event === 'unknown' && i.rawEvent !== undefined ? { rawEvent: i.rawEvent } : {}) })),
        degraded: [],
        counts,
        ...(note === undefined ? {} : { note })
    };
}

export function registerGetHistory(server: McpServer, adapters: readonly ServiceAdapter[], eventLog?: EventLog): void {
    server.registerTool(
        'get_history',
        {
            title: 'Download history',
            annotations: READ_ONLY,
            description:
                'What happened to a download after it left the queue (grabbed, imported, failed, deleted), merged across the *arrs, SABnzbd, NZBGet, Bazarr (`subtitle` rows), Cleanuparr (strikes and removals), Reclaimerr (cleanup), Shelfmark and Grimmory, in one vocabulary with the upstream word kept as `rawEvent`. This answers "why did last night\'s download fail": get_queue cannot see finished or failed items, and a failure carries the download client\'s own message. Pass `service` and `id` to scope it to one movie, series or Lidarr artist. `downloadId` links a row to its *arr grab; on an NZBGet row it is what trigger_scan `action: "postprocess"` takes. Deleting a title also deletes its Radarr and Sonarr history, so `source: "webhooks"` reads what they reported to arr-mcp instead, when the library event log is on. Field reference: arr://docs/get_history.',
            outputSchema: PagedOutputSchema.extend({
                note: z.string().optional().describe('Why a `source: "webhooks"` answer may be empty: the log is off, or nothing has arrived.')
            }),
            inputSchema: toolInput({
                source: z
                    .enum(['services', 'webhooks'])
                    .default('services')
                    .describe('`services` asks each service for its own history. `webhooks` reads the events Radarr and Sonarr reported to arr-mcp, which survive deleting a title.'),
                service: ServiceIdSchema.optional().describe('Scope to one service. Required alongside `id`.'),
                instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
                id: z.string().min(1).optional().describe('One movie, series or Lidarr artist id — `acquisition.id` on a get_library or get_media_details record. Requires `service`.'),
                event_type: EventTypeSchema,
                since: SinceSchema,
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ source, service, instance, id, event_type, since, detail, limit, offset }) => {
            const opts = {
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                ...(id === undefined ? {} : { id }),
                ...(event_type === undefined ? {} : { eventType: event_type }),
                ...(since === undefined ? {} : { since }),
                detail,
                limit,
                offset
            };
            if (source === 'webhooks') {
                const stored = readEventLog(adapters, eventLog, opts);
                const said =
                    `${stored.returned} of ${stored.total} stored event${stored.total === 1 ? '' : 's'}` +
                    (stored.degraded.length > 0 ? '; the event log could not be read.' : '.') +
                    (stored.note === undefined ? '' : ` ${stored.note}`);
                return { content: [{ type: 'text', text: listText(said, stored.items, historyLine) }], structuredContent: stored };
            }

            const result = await buildGetHistory(adapters, opts);
            const summary =
                `${result.returned} of ${result.total} history entr${result.returned === 1 ? 'y' : 'ies'}` +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: listText(summary, result.items, historyLine) }], structuredContent: result };
        }
    );
}
