import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceIdSchema } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import { RELEASE_SEARCH_TIMEOUT_MS } from '../services/arrRelease.ts';
import { hasReleaseSearch, type ReleaseCandidate, type ServiceAdapter } from '../services/types.ts';

export type GetReleasesResult = {
    items: ReleaseCandidate[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    counts: Record<string, number>;
};

/**
 * `guid` and `indexerId` are grab-plumbing, same as get_history's fields of
 * the same name — useful only to a future grab tool, not to reading. `516 of
 * 516 rejected` (a real capture) can also mean 516 rejection strings, which
 * is most of this response's weight, so `rejections` is trimmed alongside
 * them below `full` — `rejected` alone survives. `minimal` keeps only what a
 * quick scan needs: what it is, where it came from, and whether it was
 * rejected.
 */
const project = (r: ReleaseCandidate, detail: DetailLevel): ReleaseCandidate => {
    if (detail === 'minimal') {
        return {
            service: r.service,
            indexer: r.indexer,
            title: r.title,
            rejected: r.rejected,
            ...(r.quality === undefined ? {} : { quality: r.quality })
        };
    }
    if (detail === 'full') return r;
    const { guid: _guid, indexerId: _indexerId, rejections: _rejections, ...rest } = r;
    return rest;
};

export async function buildGetReleases(
    adapters: readonly ServiceAdapter[],
    opts: {
        service: ServiceId;
        instance?: string;
        id: string;
        season?: number;
        detail: DetailLevel;
        limit: number;
        offset?: number;
    }
): Promise<GetReleasesResult> {
    const adapter = resolveInstance(adapters, opts.service, opts.instance);
    // A valid, configured service with no release search (everything but
    // Radarr and Sonarr) must refuse rather than answer empty — an empty
    // list reads as "nothing is out there", a different and more misleading
    // claim than "this service cannot answer that".
    if (!hasReleaseSearch(adapter)) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot search for releases`, {
            remedy: 'Only radarr and sonarr can answer get_releases.'
        });
    }

    const items = await adapter.findReleases({
        id: opts.id,
        ...(opts.season === undefined ? {} : { season: opts.season })
    });

    const shaped = applyLimit(items, opts.limit, opts.offset);
    return { ...shaped, items: shaped.items.map(i => project(i, opts.detail)), degraded: [], counts: { [adapter.id]: items.length } };
}

export function registerGetReleases(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_releases',
        {
            title: 'Interactive search results',
            annotations: READ_ONLY,
            description:
                `\`trigger_search\` starts an indexer search but hands back only a queued command — it cannot show what was found, so nothing can be picked. \`get_releases\` runs the same interactive search Radarr or Sonarr's own UI does and returns every candidate, rejected ones included: a real capture found every release rejected on both a Radarr and a Sonarr search, almost always because the library already held an equal-or-better file, so filtering rejects out would have answered empty. Each row carries \`rejected\` and the upstream \`rejections\` that explain it, plus \`guid\` and \`indexerId\` together, which is what a future grab tool will bind to — both trimmed below \`detail: full\`, along with \`rejections\` below \`detail: standard\`. \`seeders\` is torrent-only and absent, not zero, on a usenet result. **This call is slow: Radarr and Sonarr poll every configured indexer synchronously, and a live capture measured a Sonarr season search at 14.3s. The timeout on this one call is set to ${(RELEASE_SEARCH_TIMEOUT_MS / 1000).toFixed(0)}s to give a real search room to finish. A long wait is not a hang — do not retry, which starts a second full indexer sweep.** \`season\` is Sonarr-only and is refused, not ignored, against Radarr.`,
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                service: ServiceIdSchema.describe('radarr or sonarr. Required — this searches one item, never merges across services.'),
                instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
                id: z.string().min(1).describe('The movie or series id — `acquisition.id` on a get_library or get_media_details record.'),
                season: z
                    .number()
                    .int()
                    .nonnegative()
                    .optional()
                    .describe('Sonarr only — search one season rather than the whole series. Refused against Radarr.'),
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ service, instance, id, season, detail, limit, offset }) => {
            const result = await buildGetReleases(adapters, {
                service,
                ...(instance === undefined ? {} : { instance }),
                id,
                ...(season === undefined ? {} : { season }),
                detail,
                limit,
                offset
            });
            const rejectedCount = result.items.filter(r => r.rejected).length;
            const summary =
                `${result.returned} of ${result.total} release${result.returned === 1 ? '' : 's'} for ${service} ${id}` +
                (rejectedCount > 0 ? `; ${rejectedCount} rejected (see each row's \`rejections\`).` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
