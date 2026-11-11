import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION } from './resolveInstance.ts';
import type { ServiceId } from '../config/schema.ts';
import { serviceOf } from '../config/schema.ts';
import { gather } from '../core/gather.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, listText, toolInput, windowEnd, type DetailLevel, unreachableTail } from '../core/shape.ts';
import { hasWanted, type ServiceAdapter, type WantedItem, type WantedScope } from '../services/types.ts';
import { episodeCode } from '../core/labels.ts';
import { readTargets, serviceTarget } from './serviceTarget.ts';

type GetWantedResult = {
    items: WantedItem[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    counts: Record<string, number>;
};

const WantedScopeSchema = z
    .enum(['missing', 'upgradable'])
    .describe(
        '`missing`: monitored items with no file at all[[lidarr:  (on Lidarr, an album with any track missing)]]. `upgradable`: monitored items that have a file but not yet at the quality profile\'s cutoff. Required — the two answer different questions, and a default would silently hide one of them.'
    );

/**
 * Unlike get_history and get_releases, nothing here is grab-plumbing to hide
 * below `full` — every field is something a reader would want. `minimal`
 * still exists for the same reason every other tool has one: the identity
 * and the one flag ("wanted") a quick scan needs, dropping `episodeTitle`,
 * `albumTitle` and `airDate`, the fields most useful only to a close reading.
 */
const project = (w: WantedItem, detail: DetailLevel): WantedItem => {
    if (detail === 'minimal') {
        return {
            service: w.service,
            kind: w.kind,
            id: w.id,
            title: w.title,
            monitored: w.monitored,
            ...(w.season === undefined ? {} : { season: w.season }),
            ...(w.episode === undefined ? {} : { episode: w.episode }),
            // Identity, like season and episode: the album a Lidarr row is about.
            ...(w.albumId === undefined ? {} : { albumId: w.albumId })
        };
    }
    return w;
};

/**
 * One wanted row as a line.
 *
 * `id` names the **series** on Sonarr's rows, never the episode — the same
 * contract `WantedItem` documents — so the line prints the episode numbering
 * for a human to read and the series id for a tool to act on. A Lidarr row
 * prints the album after the artist, and its album id beside the artist id.
 */
export function wantedLine(item: WantedItem): string {
    const numbering =
        item.season === undefined || item.episode === undefined
            ? ''
            : ` ${episodeCode(item.season, item.episode)}`;
    const episode = item.episodeTitle === undefined ? '' : ` ${item.episodeTitle}`;
    const album = item.albumTitle === undefined ? '' : ` — ${item.albumTitle}`;

    const facts = [item.kind, `${item.service}:${item.id}`];
    if (item.albumId !== undefined) facts.push(`album ${item.albumId}`);
    if (item.airDate !== undefined && item.airDate !== '') facts.push(item.airDate);
    if (!item.monitored) facts.push('unmonitored');

    return `${item.title}${album}${numbering}${episode} — ${facts.join(', ')}`;
}

const TARGET = serviceTarget({ services: ['radarr', 'sonarr', 'lidarr'], can: hasWanted, cannot: 'has no wanted list to return' });

export async function buildGetWanted(
    adapters: readonly ServiceAdapter[],
    opts: {
        service?: ServiceId;
        instance?: string;
        scope: WantedScope;
        detail: DetailLevel;
        limit: number;
        offset?: number;
    }
): Promise<GetWantedResult> {
    // Each service hands over its first `want` rows and says how many it has
    // (#293). `gather` keeps source order, so the concatenated window is the
    // one the whole lists would give.
    const want = windowEnd(opts.limit, opts.offset);
    const { items, degraded, counts } = await gather(
        readTargets(adapters, TARGET, opts.service, opts.instance).map(a => ({ id: a.id, fetch: () => a.readWanted(opts.scope, want) }))
    );

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const shaped = applyLimit(items, opts.limit, opts.offset, total);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded, counts };
}

const GetWantedInput = toolInput({
    scope: WantedScopeSchema,
    service: serviceOf(TARGET.services).optional().describe('Scope to one service.'),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    detail: DetailSchema,
    limit: LimitSchema,
    offset: OffsetSchema
});

export function registerGetWanted(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_wanted',
        {
            title: 'Missing and upgradable',
            annotations: READ_ONLY,
            description:
                'The {{and: radarr=Radarr; sonarr=Sonarr; lidarr=Lidarr}} wanted lists. `scope` is required: `"missing"` is monitored items with no file, `"upgradable"` monitored items with a file below the profile\'s quality cutoff. Unlike get_library it lists missing episodes one by one. [[sonarr: Sonarr rows carry `season`, `episode` and `episodeTitle`.]] [[lidarr: Lidarr rows are `kind: "artist"` with `albumId` and `albumTitle`, and `albumId` is what set_monitoring takes with `level: "album"`. On Lidarr an album missing any track counts as missing, so it can be in both lists, and albums of an unmonitored artist are left out.]] Unmonitored gaps never appear. `detail: "minimal"` drops titles and air dates. Field reference: arr://docs/get_wanted.',
            outputSchema: PagedOutputSchema,
            inputSchema: GetWantedInput
        },
        async ({ scope, service, instance, detail, limit, offset }) => {
            const result = await buildGetWanted(adapters, {
                scope,
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                detail,
                limit,
                offset
            });
            const summary =
                `${result.returned} of ${result.total} ${scope} item${result.returned === 1 ? '' : 's'}` +
                unreachableTail(result.degraded);

            return { content: [{ type: 'text', text: listText(summary, result.items, wantedLine) }], structuredContent: result };
        }
    );
}
