import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasSubtitleSearch, hasSubtitles, type ServiceAdapter, type SubtitleGap } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The other half of `get_subtitles`, which until now could only say what was
 * missing. Safe, not destructive: it downloads a subtitle file, and the worst
 * outcome is a wrong one you can replace.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasSubtitleSearch(adapter) || !hasSubtitles(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot search for subtitles`, {
            remedy: 'Only bazarr manages subtitles.'
        });
    }
    return adapter;
};

const label = (gap: SubtitleGap): string =>
    gap.kind === 'movie'
        ? gap.title
        : `${gap.title} ${gap.season ?? '?'}x${gap.episode ?? '?'}${gap.episodeTitle === undefined ? '' : ` ${gap.episodeTitle}`}`;

export function registerTriggerSubtitleSearch(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'trigger_subtitle_search',
        title: 'Search for a subtitle',
        description:
            'Asks Bazarr to go looking for one language of subtitles for one item it already tracks — the "it is missing Dutch subs and I do not want to wait for the next round" action. Takes `kind`, `id` and `language` exactly as get_subtitles reports them. This queues a search and returns immediately; it does not wait, and finding a subtitle is not guaranteed. Previews by default — call again with the returned `confirm` token to actually run it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('bazarr.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            kind: z.enum(['movie', 'episode']).describe('Which of the two lists get_subtitles reported the item in.'),
            id: z
                .string()
                .min(1)
                .describe("The item's id as get_subtitles reports it, as an integer string. For an episode this is the episode id, not the series id."),
            language: z
                .string()
                .min(2)
                .describe('The two-letter code from the item\'s `missing` list — "nl", "en".'),
            forced: z.boolean().default(false).describe('Search for a forced subtitle track.'),
            hearing_impaired: z.boolean().default(false).describe('Search for a hearing-impaired subtitle track.')
        }),
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'trigger_subtitle_search',
        tier: 'safe',

        async plan({ service, instance, kind, id, language, forced, hearing_impaired }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            // The wanted list is both the preview's source of a real title and
            // the only place an episode's series id is offered.
            const gaps = await adapter.getMissingSubtitles();
            const gap = gaps.find(g => g.kind === kind && String(g.id) === id);
            if (gap === undefined) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no ${kind} ${id} missing subtitles`, {
                    remedy: 'Take kind and id from get_subtitles — it lists exactly the items with something missing.'
                });
            }

            const target = `${adapter.id}:${kind}:${id}:${language}`;
            const wanted = gap.missing.find(
                m => m.code2 === language && m.forced === forced && m.hearingImpaired === hearing_impaired
            );

            if (wanted === undefined) {
                const have = gap.missing.map(m => `${m.name} (${m.code2})`).join(', ');
                return {
                    target,
                    summary: `${adapter.id} is not missing ${language} for ${label(gap)}.`,
                    effects: [],
                    noop: true,
                    ...(have === '' ? {} : { args: { missing: have } })
                };
            }

            return {
                target,
                summary: `Ask ${adapter.id} to search for ${wanted.name} subtitles for ${label(gap)}.`,
                effects: [
                    `Queries every enabled subtitle provider for ${wanted.name} subtitles and downloads the best match it finds.`,
                    'Runs in the background — check get_subtitles again in a minute rather than expecting it to be done now.'
                ],
                args: { kind, id, language, forced, hearing_impaired }
            };
        },

        async apply(_plan, { service, instance, kind, id, language, forced, hearing_impaired }) {
            const adapter = findAdapter(adapters, service, instance);
            const gap = (await adapter.getMissingSubtitles()).find(g => g.kind === kind && String(g.id) === id);

            await adapter.triggerSubtitleSearch({
                kind,
                id: Number(id),
                ...(gap?.seriesId === undefined ? {} : { seriesId: gap.seriesId }),
                language,
                forced,
                hearingImpaired: hearing_impaired
            });

            return `${adapter.id} is searching for ${language} subtitles. Providers are queried in the background — check get_subtitles again shortly.`;
        }
    });
}
