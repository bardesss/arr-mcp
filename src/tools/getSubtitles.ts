import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
import type { ServiceAdapter, SubtitleCapable, SubtitleGap, SubtitleProvider } from '../services/types.ts';

export type GetSubtitlesResult = {
    items: SubtitleGap[];
    total: number;
    returned: number;
    truncated: boolean;
    degraded: string[];
    /**
     * Not run through applyLimit: a Bazarr install has a dozen providers at
     * most, and wrapping a list that cannot truncate in a truncation contract
     * is noise in every response.
     */
    providers?: SubtitleProvider[];
};

const project = (g: SubtitleGap, detail: DetailLevel): SubtitleGap => {
    if (detail === 'full') return g;
    if (detail === 'standard') {
        const { releaseName: _r, ...rest } = g;
        return rest;
    }
    // minimal: what is missing, not which release or which languages.
    return { service: g.service, kind: g.kind, id: g.id, title: g.title, missing: [] };
};

export async function buildGetSubtitles(
    adapter: (ServiceAdapter & SubtitleCapable) | undefined,
    opts: { detail: DetailLevel; limit: number }
): Promise<GetSubtitlesResult> {
    if (adapter === undefined) {
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [] };
    }

    let gaps: SubtitleGap[];
    try {
        gaps = await adapter.getMissingSubtitles();
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'subtitle read failed; degrading');
        return { items: [], total: 0, returned: 0, truncated: false, degraded: [adapter.id] };
    }

    // Provider state is fetched alongside and never allowed to fail the call.
    let providers: SubtitleProvider[] | undefined;
    if (opts.detail !== 'minimal') {
        try {
            providers = await adapter.getProviders();
        } catch (err) {
            logger.warn({ service: adapter.id, err }, 'provider state unavailable; omitting');
        }
    }

    const shaped = applyLimit(gaps, opts.limit);
    return {
        ...shaped,
        items: shaped.items.map(g => project(g, opts.detail)),
        degraded: [],
        ...(providers === undefined ? {} : { providers })
    };
}

export function registerGetSubtitles(server: McpServer, adapter: (ServiceAdapter & SubtitleCapable) | undefined): void {
    server.registerTool(
        'get_subtitles',
        {
            description:
                'Subtitles Bazarr knows are missing, for both films and episodes, with the languages wanted for each — and which subtitle providers are currently working, throttled, or blocked, which is usually why something is missing. Release names come from public indexers and are fenced as untrusted data.',
            inputSchema: z.object({ detail: DetailSchema, limit: LimitSchema })
        },
        async ({ detail, limit }) => {
            const result = await buildGetSubtitles(adapter, { detail, limit });
            const unhealthy = (result.providers ?? []).filter(p => !p.healthy).length;
            const summary =
                result.degraded.length > 0
                    ? 'Bazarr could not be reached; no subtitle information available.'
                    : `${result.returned} of ${result.total} item(s) missing subtitles` +
                      (unhealthy > 0 ? `; ${unhealthy} provider(s) unavailable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
