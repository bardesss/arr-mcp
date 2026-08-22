import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { gather } from '../core/gather.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import { hasCalendar, type CalendarEntry, type ServiceAdapter } from '../services/types.ts';

export type GetCalendarResult = {
    items: CalendarEntry[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /** How many returned items have no file yet. Counted before the detail
     *  projection, which drops `hasFile` at `minimal`. */
    missingFiles: number;
    /**
     * Keyed by **adapter id**, not by service type: a named instance reports
     * under `radarr/4k`. Widened from `ServiceId` for the reason
     * `library.ts` already was — `gather` has always keyed this by the id it
     * fanned out over, so the narrower type described something this never
     * held. Every existing key is unchanged.
     */
    counts: Record<string, number>;
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
    opts: { detail: DetailLevel; limit: number; offset?: number; daysBack: number; daysAhead: number; now?: () => Date }
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

    const shaped = applyLimit(items, opts.limit, opts.offset);

    // Counted before projecting. `minimal` drops `hasFile`, and `!undefined`
    // is true, so counting the projected items reported every row as missing.
    const missingFiles = shaped.items.filter(i => !i.hasFile).length;

    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        degraded,
        counts,
        missingFiles
    };
}

export function registerGetCalendar(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_calendar',
        {
            title: 'Upcoming releases',
            annotations: READ_ONLY,
            description:
                'Films and episodes due in a date window, merged from Radarr and Sonarr and sorted by date. Covers both upcoming releases and recently aired items, with whether each already has a file.',
            outputSchema: PagedOutputSchema.extend({
                missingFiles: z
                    .number()
                    .describe(
                        'How many of the returned items have no file yet. Counted before the detail projection, so it is right at every detail level.'
                    )
            }),
            inputSchema: toolInput({
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema,
                days_back: DaysBackSchema,
                days_ahead: DaysAheadSchema
            })
        },
        async ({ detail, limit, offset, days_back, days_ahead }) => {
            const result = await buildGetCalendar(adapters, {
                detail,
                limit,
                offset,
                daysBack: days_back,
                daysAhead: days_ahead
            });
            const missing = result.missingFiles;
            const summary =
                `${result.returned} of ${result.total} item(s) between ${days_back} days back and ${days_ahead} ahead` +
                (missing > 0 ? `, ${missing} without a file` : '') +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
