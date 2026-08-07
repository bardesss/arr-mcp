import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import { gather } from '../core/gather.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
import { hasCalendar, type CalendarEntry, type ServiceAdapter } from '../services/types.ts';

export type GetCalendarResult = {
    items: CalendarEntry[];
    total: number;
    returned: number;
    truncated: boolean;
    degraded: string[];
    counts: Partial<Record<ServiceId, number>>;
};

const DaysBackSchema = z
    .number()
    .int()
    .min(0)
    .max(90)
    .default(7)
    .describe('How many days of already-released items to include. Defaults to 7.');

const DaysAheadSchema = z
    .number()
    .int()
    .min(0)
    .max(365)
    .default(14)
    .describe('How many days ahead to include. Defaults to 14.');

const project = (c: CalendarEntry, detail: DetailLevel): CalendarEntry => {
    if (detail === 'minimal') {
        return { service: c.service, kind: c.kind, id: c.id, title: c.title, date: c.date } as CalendarEntry;
    }
    return c;
};

export async function buildGetCalendar(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number; daysBack: number; daysAhead: number; now?: () => Date }
): Promise<GetCalendarResult> {
    // The clock is injected so tests are not time-dependent.
    const at = (opts.now ?? (() => new Date()))();
    const range = {
        start: new Date(at.getTime() - opts.daysBack * 86_400_000),
        end: new Date(at.getTime() + opts.daysAhead * 86_400_000)
    };

    const { items, degraded, counts } = await gather(
        adapters.filter(hasCalendar).map(a => ({ id: a.id, fetch: () => a.getCalendar(range) }))
    );

    // Sorted before limiting: a truncated calendar must drop the furthest-away
    // items, not whichever service happened to answer second.
    items.sort((a, b) => a.date.localeCompare(b.date));

    const shaped = applyLimit(items, opts.limit);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
}

export function registerGetCalendar(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_calendar',
        {
            description:
                'Films and episodes due in a date window, merged from Radarr and Sonarr and sorted by date. Covers both upcoming releases and recently aired items, with whether each already has a file.',
            inputSchema: z.object({
                detail: DetailSchema,
                limit: LimitSchema,
                days_back: DaysBackSchema,
                days_ahead: DaysAheadSchema
            })
        },
        async ({ detail, limit, days_back, days_ahead }) => {
            const result = await buildGetCalendar(adapters, {
                detail,
                limit,
                daysBack: days_back,
                daysAhead: days_ahead
            });
            const missing = result.items.filter(i => !i.hasFile).length;
            const summary =
                `${result.returned} of ${result.total} item(s) between ${days_back} days back and ${days_ahead} ahead` +
                (missing > 0 ? `, ${missing} without a file` : '') +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
