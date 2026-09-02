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
            'Asks Bazarr to go looking for one language of subtitles for one item it already tracks — the "it is missing Dutch subs and I do not want to wait for the next round" action. Takes `kind`, `id` and `language` exactly as get_subtitles reports them. By default it only searches for something Bazarr lists as missing; `search_anyway: true` searches regardless, which is how you replace a subtitle you already have but do not want (for an episode outside that list, pass `series_id` too). This queues a search and returns immediately; it does not wait, and finding a subtitle is not guaranteed. Previews by default — call again with the returned `confirm` token to actually run it.',
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
            search_anyway: z
                .boolean()
                .default(false)
                .describe(
                    'Search even when Bazarr does not list this item — or this language — as missing. The "I have Dutch subs and they are wrong" case; it may replace a subtitle you already have.'
                ),
            series_id: z
                .number()
                .int()
                .optional()
                .describe(
                    'The Sonarr series id. Only needed with search_anyway for an episode Bazarr does not list as missing, since the missing list is otherwise where the series id comes from.'
                ),
            forced: z.boolean().default(false).describe('Search for a forced subtitle track.'),
            hearing_impaired: z.boolean().default(false).describe('Search for a hearing-impaired subtitle track.')
        }),
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'trigger_subtitle_search',
        tier: 'safe',

        async plan({
            service,
            instance,
            kind,
            id,
            language,
            forced,
            hearing_impaired,
            search_anyway,
            series_id
        }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            // The wanted list is both the preview's source of a real title and
            // the only place an episode's series id is offered.
            const gaps = await adapter.getMissingSubtitles();
            const gap = gaps.find(g => g.kind === kind && String(g.id) === id);
            const target = `${adapter.id}:${kind}:${id}:${language}`;

            // Not in the wanted list. Still a refusal by default: a write
            // against an item the tool cannot even describe is worse than
            // making the caller say they meant it.
            if (gap === undefined) {
                if (!search_anyway) {
                    throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no ${kind} ${id} missing subtitles`, {
                        remedy:
                            'Take kind and id from get_subtitles — it lists exactly the items with something missing. To search for something that is not missing (a subtitle you already have but want replaced), pass search_anyway: true.'
                    });
                }

                // The wanted list is the only place an episode's series id is
                // offered, so outside it the caller has to supply one. Refused
                // rather than sent: Bazarr rejects the call, after the token
                // has been spent.
                if (kind === 'episode' && series_id === undefined) {
                    throw new ServiceError('NotFound', adapter.id, 'an episode subtitle search needs the series id', {
                        remedy:
                            'Pass series_id — the Sonarr series id, `acquisition.id` on the series in get_library. It is only in the missing list for items that are actually missing subtitles.'
                    });
                }

                return {
                    target,
                    summary: `Ask ${adapter.id} to search for ${language} subtitles for ${kind} ${id}.`,
                    effects: [
                        `${adapter.id} does not list this ${kind} as missing ${language} subtitles, so this is a search for something it believes it already has or does not want.`,
                        'It may replace a subtitle that is already there with whatever the providers rank best.',
                        'Runs in the background — check get_subtitles again in a minute rather than expecting it to be done now.'
                    ],
                    args: {
                        kind,
                        id,
                        language,
                        forced,
                        hearing_impaired,
                        ...(series_id === undefined ? {} : { seriesId: series_id })
                    }
                };
            }

            const wanted = gap.missing.find(
                m => m.code2 === language && m.forced === forced && m.hearingImpaired === hearing_impaired
            );

            if (wanted === undefined && !search_anyway) {
                const have = gap.missing.map(m => `${m.name} (${m.code2})`).join(', ');
                return {
                    target,
                    summary: `${adapter.id} is not missing ${language} for ${label(gap)}.`,
                    effects: [],
                    noop: true,
                    ...(have === '' ? {} : { args: { missing: have } })
                };
            }

            const languageName = wanted?.name ?? language;

            return {
                target,
                summary: `Ask ${adapter.id} to search for ${languageName} subtitles for ${label(gap)}.`,
                effects: [
                    `Queries every enabled subtitle provider for ${languageName} subtitles and downloads the best match it finds.`,
                    ...(wanted === undefined
                        ? [
                              `${adapter.id} does not list ${languageName} as missing for this item, so this may replace a subtitle that is already there.`
                          ]
                        : []),
                    'Runs in the background — check get_subtitles again in a minute rather than expecting it to be done now.'
                ],
                // `seriesId` travels in the plan. `apply` used to re-fetch the
                // whole wanted list to recover it, so a list that had refreshed
                // in between silently dropped the id and Bazarr answered "an
                // episode subtitle search needs the series id" — blaming a
                // caller whose ids were right, after the token was consumed.
                args: {
                    kind,
                    id,
                    language,
                    forced,
                    hearing_impaired,
                    ...(gap.seriesId === undefined ? {} : { seriesId: gap.seriesId })
                }
            };
        },

        async apply(plan, { service, instance, kind, id, language, forced, hearing_impaired }) {
            const adapter = findAdapter(adapters, service, instance);
            const seriesId = plan.args?.seriesId as number | undefined;

            await adapter.triggerSubtitleSearch({
                kind,
                id: Number(id),
                ...(seriesId === undefined ? {} : { seriesId }),
                language,
                forced,
                hearingImpaired: hearing_impaired
            });

            return `${adapter.id} is searching for ${language} subtitles. Providers are queried in the background — check get_subtitles again shortly.`;
        }
    });
}
