import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceIdSchema } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { gather } from '../core/gather.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import { HISTORY_EVENT_TYPES, hasHistory, type HistoryCapable, type HistoryEntry, type HistoryEventType, type ServiceAdapter } from '../services/types.ts';

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
    // `id` names one movie or series, and Radarr's movieId and Sonarr's
    // seriesId are different namespaces that can share a number — passing it
    // to every adapter unscoped would silently mix two unrelated items'
    // history together.
    if (opts.id !== undefined && opts.service === undefined) {
        throw new Error('`id` scopes to one movie or series; pass `service` (and `instance` if it is named) to say which.');
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
                remedy: 'radarr, sonarr, sabnzbd and bazarr can answer get_history. A media server has no download history.'
            });
        }
        scoped = [adapter];
    }

    const { items, degraded, counts } = await gather(
        scoped.map(a => ({
            id: a.id,
            fetch: async () => {
                const rows = await a.readHistory({
                    ...(opts.id === undefined ? {} : { id: opts.id }),
                    ...(opts.since === undefined ? {} : { since: opts.since })
                });
                // Filtered inside the source, not after gather, so `counts`
                // reports what each service actually contributed to this
                // answer rather than its unfiltered total.
                return opts.eventType === undefined ? rows : rows.filter(r => r.event === opts.eventType);
            }
        }))
    );

    // Newest first: "why did last night's download fail" is a question about
    // the most recent attempt, not the oldest.
    items.sort((a, b) => b.at.localeCompare(a.at));

    const shaped = applyLimit(items, opts.limit, opts.offset);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
}

export function registerGetHistory(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_history',
        {
            title: 'Download history',
            annotations: READ_ONLY,
            description:
                'What happened to a grab after it left the queue: grabbed, imported, failed or deleted, merged across Radarr, Sonarr, SABnzbd and Bazarr and normalised to one vocabulary — the upstream spelling survives as `rawEvent`. SABnzbd\'s own rows are the layer below the *arrs: when Radarr says it grabbed something and nothing arrived, the download client\'s failure message is here. Bazarr contributes `subtitle` rows — a downloaded subtitle is not an import, and calling it one would put it in the answer to "what did Radarr import last night". `trigger_search` only ever hands back a command handle with no way to follow up, and `get_queue` cannot see anything that has already failed or finished; this is how you answer "why did last night\'s download fail". A failure carries the download client\'s own message, fenced and in whatever language it runs in. Pass `service` and `id` to scope to one movie or series.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                service: ServiceIdSchema.optional().describe('Scope to one service. Required alongside `id`.'),
                instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
                id: z.string().min(1).optional().describe('One movie or series id — `acquisition.id` on a get_library or get_media_details record. Requires `service`.'),
                event_type: EventTypeSchema,
                since: SinceSchema,
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ service, instance, id, event_type, since, detail, limit, offset }) => {
            const result = await buildGetHistory(adapters, {
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                ...(id === undefined ? {} : { id }),
                ...(event_type === undefined ? {} : { eventType: event_type }),
                ...(since === undefined ? {} : { since }),
                detail,
                limit,
                offset
            });
            const summary =
                `${result.returned} of ${result.total} history entr${result.returned === 1 ? 'y' : 'ies'}` +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
