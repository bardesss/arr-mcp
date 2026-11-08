import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceIdSchema } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { guidForText } from '../core/fence.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, listText, toolInput, type DetailLevel } from '../core/shape.ts';
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
 * the same name — useful only to grab_release, not to reading. `516 of
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

/**
 * One candidate release as a line.
 *
 * The title is uploader-chosen and keeps its fence. `rejected` comes early and
 * always: a rejected release that reads like an available one is how a model
 * ends up telling someone to grab something the *arr has already refused.
 *
 * `indexer_id` and `guid` go in whenever the item still has them, which
 * `project` allows only at `detail: full`. They are what grab_release binds
 * to, and a client that drops `structuredContent` (#234) otherwise sees the
 * release it wants with no way to name it (#507). They sit next to the
 * indexer rather than at the end, where they would run on from the free-text
 * rejections. The guid goes through `guidForText`: bare when it is shaped
 * like an id, which grab_release compares verbatim, and fenced otherwise.
 */
export function releaseLine(release: ReleaseCandidate): string {
    const ids = [
        ...(release.indexerId === undefined ? [] : [`indexer_id ${release.indexerId}`]),
        ...(release.guid === undefined ? [] : [`guid ${guidForText(release.guid, release.service)}`])
    ];
    const indexer = ids.length === 0 ? release.indexer : `${release.indexer} [${ids.join(', ')}]`;
    const facts = [release.rejected ? 'REJECTED' : 'available', indexer];
    if (release.quality !== undefined && release.quality !== '') facts.push(release.quality);
    if (release.seeders !== undefined) facts.push(`${release.seeders} seeders`);
    if (release.downloads !== undefined) facts.push(`${release.downloads} downloads`);
    if (release.rejected && release.rejections !== undefined && release.rejections.length > 0) {
        facts.push(release.rejections.join('; '));
    }

    return `${release.title} — ${facts.join(', ')}`;
}

export async function buildGetReleases(
    adapters: readonly ServiceAdapter[],
    opts: {
        service: ServiceId;
        instance?: string;
        id: string;
        season?: number;
        episode?: string;
        album?: string;
        detail: DetailLevel;
        limit: number;
        offset?: number;
    }
): Promise<GetReleasesResult> {
    const adapter = resolveInstance(adapters, opts.service, opts.instance);
    // A valid, configured service with no release search (everything but the
    // *arrs) must refuse rather than answer empty — an empty list reads as
    // "nothing is out there", a different and more misleading claim than
    // "this service cannot answer that".
    if (!hasReleaseSearch(adapter)) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot search for releases`, {
            remedy: 'Only radarr, sonarr, whisparr, lidarr and shelfmark can answer get_releases.'
        });
    }
    const items = await adapter.findReleases({
        id: opts.id,
        ...(opts.season === undefined ? {} : { season: opts.season }),
        ...(opts.episode === undefined ? {} : { episode: opts.episode }),
        ...(opts.album === undefined ? {} : { album: opts.album })
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
                `Runs the interactive search Radarr, Sonarr, Whisparr or Lidarr's own UI runs and returns every candidate, rejected ones included with their \`rejections\` (often because the library already holds an equal or better file). trigger_search cannot show what was found; this can, and its \`guid\` and \`indexerId\` (at \`detail: "full"\`) are what grab_release takes. **Slow**: every indexer is polled synchronously, 15 seconds or more is normal and the timeout is ${(RELEASE_SEARCH_TIMEOUT_MS / 1000).toFixed(0)}s. A long wait is not a hang: do not retry. Keep it narrow: on Sonarr pass \`episode\` for one search instead of a \`season\` (one search per episode); on Lidarr \`id\` is the artist, so pass \`album\`, since a whole artist can return over a thousand rows. \`season\` is refused on Radarr. \`seeders\` is absent, not zero, on usenet. For a book, \`service: "shelfmark"\` with a book id from lookup_media. Field reference: arr://docs/get_releases.`,
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                service: ServiceIdSchema.describe(
                    'radarr, sonarr, whisparr, lidarr or shelfmark. Required — this searches one item, never merges across services.'
                ),
                instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
                id: z
                    .string()
                    .min(1)
                    .describe(
                        'The movie, series or artist id — `acquisition.id` on a get_library or get_media_details record. On shelfmark, the id of a lookup_media row whose kind is book.'
                    ),
                season: z
                    .number()
                    .int()
                    .nonnegative()
                    .optional()
                    .describe(
                        'Sonarr and Whisparr only — search one season (a release year on Whisparr) rather than the whole series. Refused against Radarr.'
                    ),
                episode: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        'Sonarr only — one episode id, as an integer string (from get_media_details with episodes). Searches that episode alone, far faster than a season. Mutually exclusive with `season`; refused against Radarr.'
                    ),
                album: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        'Lidarr only — one album id of the artist `id`, as an integer string (from get_media_details at `detail: "full"`). Searches that album alone. Refused elsewhere.'
                    ),
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ service, instance, id, season, episode, album, detail, limit, offset }) => {
            const result = await buildGetReleases(adapters, {
                service,
                ...(instance === undefined ? {} : { instance }),
                id,
                ...(season === undefined ? {} : { season }),
                ...(episode === undefined ? {} : { episode }),
                ...(album === undefined ? {} : { album }),
                detail,
                limit,
                offset
            });
            const rejectedCount = result.items.filter(r => r.rejected).length;
            const summary =
                `${result.returned} of ${result.total} release${result.returned === 1 ? '' : 's'} for ${service} ${id}` +
                (rejectedCount > 0 ? `; ${rejectedCount} rejected (see each row's \`rejections\`).` : '.');

            return { content: [{ type: 'text', text: listText(summary, result.items, releaseLine) }], structuredContent: result };
        }
    );
}
