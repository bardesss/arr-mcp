import type { McpServer } from '@modelcontextprotocol/server';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput, type DetailLevel } from '../core/shape.ts';
import type { ServiceAdapter, SubtitleCapable, SubtitleGap, SubtitleProvider } from '../services/types.ts';

export type GetSubtitlesResult = {
    items: SubtitleGap[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /**
     * Not run through applyLimit: a Bazarr install has a dozen providers at
     * most, and wrapping a list that cannot truncate in a truncation contract
     * is noise in every response.
     */
    providers?: SubtitleProvider[];
};

const project = (gap: SubtitleGap, detail: DetailLevel): SubtitleGap => {
    // A join key, not a fact about the gap — so it goes at `full` too.
    const { seriesId: _s, ...g } = gap;
    if (detail === 'full') return g;
    if (detail === 'standard') {
        const { releaseName: _r, ...rest } = g;
        return rest;
    }
    // minimal: which item, and what is missing from it.
    //
    // `missing` stays. It was being replaced with `[]`, so every row in a list
    // of items *with missing subtitles* asserted that nothing was missing,
    // under a summary line that counted them. Omitting a field is an absence a
    // reader can see; an empty array is a claim — and this is the one field
    // the tool exists to answer.
    const { releaseName: _r, episodeTitle: _e, ...rest } = g;
    return rest;
};

/**
 * Every configured Bazarr, merged.
 *
 * Bazarr connects to a single Radarr and a single Sonarr, so an HD + 4K *arr
 * pair implies one Bazarr per stack. Reading from only the first would hide
 * subtitle state for half the library — the same failure multiple instances
 * exist to remove, so this is a read that spans them rather than one that asks
 * which to look in.
 *
 * One instance failing degrades to a named entry and the others still answer.
 * A partial subtitle list that says which Bazarr is missing is useful; one that
 * silently drops half is not.
 */
export async function buildGetSubtitles(
    adapters: readonly (ServiceAdapter & SubtitleCapable)[],
    opts: { detail: DetailLevel; limit: number; offset?: number }
): Promise<GetSubtitlesResult> {
    if (adapters.length === 0) {
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [] };
    }

    const gaps: SubtitleGap[] = [];
    const providers: SubtitleProvider[] = [];
    const degraded: string[] = [];
    let sawProviders = false;

    await Promise.all(
        adapters.map(async adapter => {
            try {
                gaps.push(...(await adapter.getMissingSubtitles()));
            } catch (err) {
                logger.warn({ service: adapter.id, err }, 'subtitle read failed; degrading');
                degraded.push(adapter.id);
                return;
            }

            // Provider state is fetched alongside and never allowed to fail the
            // call — an instance that answered its gaps still contributed them.
            if (opts.detail === 'minimal') return;
            try {
                providers.push(...(await adapter.getProviders()));
                sawProviders = true;
            } catch (err) {
                logger.warn({ service: adapter.id, err }, 'provider state unavailable; omitting');
            }
        })
    );

    // Sorted so two instances produce a stable order rather than whichever
    // answered first, which would make the output differ run to run.
    const shaped = applyLimit(
        gaps.sort((a, b) => a.service.localeCompare(b.service) || a.title.localeCompare(b.title)),
        opts.limit,
        opts.offset
    );
    return {
        ...shaped,
        items: shaped.items.map(g => project(g, opts.detail)),
        degraded: degraded.sort(),
        ...(sawProviders ? { providers } : {})
    };
}

export function registerGetSubtitles(server: McpServer, adapters: readonly (ServiceAdapter & SubtitleCapable)[]): void {
    server.registerTool(
        'get_subtitles',
        {
            title: 'Subtitles',
            annotations: READ_ONLY,
            description:
                'Subtitles Bazarr knows are missing, for both films and episodes, with the languages wanted for each — and which subtitle providers are currently working, throttled, or blocked, which is usually why something is missing. Release names come from public indexers and are fenced as untrusted data.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({ detail: DetailSchema, limit: LimitSchema, offset: OffsetSchema })
        },
        async ({ detail, limit, offset }) => {
            const result = await buildGetSubtitles(adapters, { detail, limit, offset });
            const unhealthy = (result.providers ?? []).filter(p => !p.healthy).length;
            const summary =
                result.degraded.length > 0
                    ? `Bazarr could not be reached (${result.degraded.join(', ')}); subtitle information may be incomplete.`
                    : `${result.returned} of ${result.total} item(s) missing subtitles` +
                      (unhealthy > 0 ? `; ${unhealthy} provider(s) unavailable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
