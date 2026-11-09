import type { McpServer } from '@modelcontextprotocol/server';
import { IMAGE_HOSTS } from '../core/display.ts';
import { CARD_VIEW_HTML } from '../ui/cardView.ts';

/**
 * MCP Apps: the poster-card view, for a host that renders one.
 *
 * Names are the extension's (`@modelcontextprotocol/ext-apps`, protocol
 * `2026-01-26`), written out here rather than imported: its server helpers are
 * two object spreads, and the package declares the SDK's client and React as
 * peers. A tool opts in with `_meta.ui.resourceUri`; the host reads that
 * resource, renders it in a sandboxed iframe and hands it the tool result.
 *
 * A host without MCP Apps ignores both halves. The tools answer exactly as
 * they did, which `test/mcpApps.test.ts` holds them to, and the resource is
 * one more entry in `resources/list` — a view of a tool's answer, never a
 * source of facts of its own.
 */

export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
/** The deprecated flat key older hosts read; set beside `ui.resourceUri`, as the SDK's helper does. */
export const RESOURCE_URI_META_KEY = 'ui/resourceUri';
export const MEDIA_CARDS_URI = 'ui://arr-mcp/media-cards.html';

/** The tools whose answers carry `cards`. */
export const CARD_TOOLS = ['get_media_details', 'search_media', 'lookup_media', 'get_library'] as const;

/** What a card tool adds to its registration. */
export const mediaCardsToolMeta = (): Record<string, unknown> => ({
    ui: { resourceUri: MEDIA_CARDS_URI },
    [RESOURCE_URI_META_KEY]: MEDIA_CARDS_URI
});

/**
 * Images only. No `connectDomains`: the view fetches nothing, it is handed
 * the result. Without these the host's default CSP blocks every poster.
 */
const UI_META = {
    ui: {
        csp: { resourceDomains: IMAGE_HOSTS.map(host => `https://${host}`) },
        prefersBorder: false
    }
};

export function registerAppResources(server: McpServer): void {
    server.registerResource(
        'media-cards',
        MEDIA_CARDS_URI,
        {
            title: 'Media cards',
            description:
                'The poster-card view an MCP Apps host shows beside get_media_details, search_media, lookup_media and get_library. It renders the `cards` in their structuredContent and holds no data of its own.',
            mimeType: RESOURCE_MIME_TYPE,
            _meta: UI_META
        },
        uri => ({ contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: CARD_VIEW_HTML, _meta: UI_META }] })
    );
}
