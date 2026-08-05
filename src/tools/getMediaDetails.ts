import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { DetailSchema, LimitSchema, type DetailLevel } from '../core/shape.ts';
import { hasMediaDetails, type MediaDetails, type ServiceAdapter } from '../services/types.ts';

/**
 * Unlike the list tools, this one **throws rather than degrades**. A request
 * for one specific item either produced that item or did not, and an empty
 * success would read as "the item does not exist".
 */
export async function buildGetMediaDetails(
    adapters: readonly ServiceAdapter[],
    opts: { service: ServiceId; id: string; detail: DetailLevel; limit: number }
): Promise<MediaDetails> {
    const adapter = adapters.find(a => a.id === opts.service);
    if (adapter === undefined || !hasMediaDetails(adapter)) {
        throw new ServiceError('NotFound', opts.service, `${opts.service} is not configured`, {
            remedy: `Add services.${opts.service} to config.yaml, or name a configured service.`
        });
    }

    return adapter.getMediaDetails(opts.id, {
        includeEpisodes: opts.detail === 'full',
        episodeLimit: opts.limit
    });
}

export function registerGetMediaDetails(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_media_details',
        {
            description:
                'Everything one service knows about one item: quality, size, path, external ids, ratings, and — for a series at detail: full — its episodes. Name the service holding the item; cross-service lookup by title arrives with the identity resolver.',
            inputSchema: z.object({
                service: ServiceIdSchema.describe('Which service holds the item.'),
                id: z.string().min(1).describe("The item's id within that service."),
                detail: DetailSchema,
                limit: LimitSchema
            })
        },
        async ({ service, id, detail, limit }) => {
            const result = await buildGetMediaDetails(adapters, { service, id, detail, limit });
            const summary =
                `${result.kind} from ${result.service}` +
                (result.episodeCount === undefined
                    ? '.'
                    : `, ${result.episodes?.length ?? 0} of ${result.episodeCount} episode(s).`);

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
