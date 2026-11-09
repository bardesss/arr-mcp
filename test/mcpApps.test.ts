import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { CARD_TOOLS, MEDIA_CARDS_URI, RESOURCE_MIME_TYPE } from '../src/mcp/apps.ts';
import { CARD_VIEW_HTML } from '../src/ui/cardView.ts';
import { rpcPayload } from '../scripts/lib/rpc.ts';

/**
 * MCP Apps: the card tools point at one `ui://` view, and that view is
 * served with the CSP that lets its posters load. A client without the
 * extension sees one more resource and an `_meta` key it does not read.
 */

const TOKEN = 'a'.repeat(64);
const PASSWORD_HASH = await hashPassword('x');
const configWith = (extra: Record<string, unknown> = {}) =>
    ConfigSchema.parse({ auth: { bearer_token: TOKEN, password_hash: PASSWORD_HASH }, services: {}, ...extra });
const app = (config = configWith()) =>
    buildApp({
        runtime: Runtime.fromConfig(config, WriteAudit.ephemeral(), { adapters: [] }),
        audit: WriteAudit.ephemeral(),
        logs: LogStore.ephemeral()
    });

const call = async (method: string, params: Record<string, unknown> = {}, config = configWith()): Promise<Record<string, unknown>> => {
    const res = await app(config).request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return rpcPayload<Record<string, unknown>>(await res.text()).result ?? {};
};

type Tool = { name: string; _meta?: Record<string, unknown> };

describe('MCP Apps media cards', () => {
    it('points exactly the card tools at the view, under both meta keys', async () => {
        const { tools } = (await call('tools/list')) as { tools: Tool[] };
        const withUi = tools.filter(t => t._meta?.['ui'] !== undefined).map(t => t.name).sort();
        expect(withUi).toEqual([...CARD_TOOLS].sort());
        for (const name of CARD_TOOLS) {
            const meta = tools.find(t => t.name === name)?._meta;
            expect(meta?.['ui']).toEqual({ resourceUri: MEDIA_CARDS_URI });
            expect(meta?.['ui/resourceUri']).toBe(MEDIA_CARDS_URI);
        }
    });

    it('lists the view as an MCP App resource', async () => {
        const { resources } = (await call('resources/list')) as { resources: { uri: string; mimeType?: string }[] };
        expect(resources.find(r => r.uri === MEDIA_CARDS_URI)?.mimeType).toBe(RESOURCE_MIME_TYPE);
    });

    it('serves the view with the image hosts in its CSP and nothing to connect to', async () => {
        const { contents } = (await call('resources/read', { uri: MEDIA_CARDS_URI })) as {
            contents: { uri: string; mimeType: string; text: string; _meta?: { ui?: { csp?: Record<string, string[]> } } }[];
        };
        const [view] = contents;
        expect(view?.mimeType).toBe('text/html;profile=mcp-app');
        expect(view?.text.startsWith('<!doctype html>')).toBe(true);
        expect(view?._meta?.ui?.csp).toEqual({ resourceDomains: ['https://image.tmdb.org', 'https://artworks.thetvdb.com'] });
    });
});

describe('tools.media_cards: false', () => {
    const off = configWith({ tools: { media_cards: false } });

    it('advertises no view on any tool and serves no ui:// resource', async () => {
        const { tools } = (await call('tools/list', {}, off)) as { tools: Tool[] };
        expect(tools.filter(t => t._meta?.['ui'] !== undefined)).toEqual([]);
        const { resources } = (await call('resources/list', {}, off)) as { resources: { uri: string }[] };
        expect(resources.map(r => r.uri)).not.toContain(MEDIA_CARDS_URI);
    });
});

describe('the card view itself', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(CARD_VIEW_HTML)?.[1] ?? '';

    it('is one self-contained page: no external script, stylesheet or font', () => {
        expect(CARD_VIEW_HTML).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:/);
        expect(CARD_VIEW_HTML).not.toContain('__IMAGE_HOSTS__');
    });

    it('parses as JavaScript', () => {
        expect(script.length).toBeGreaterThan(0);
        expect(() => new Function(script)).not.toThrow();
    });

    it('speaks the MCP Apps handshake and writes service text as text', () => {
        for (const method of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/notifications/size-changed', 'ui/open-link']) {
            expect(script).toContain(`"${method}"`);
        }
        expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    });

    it('follows the host theme, or the system one without it', () => {
        expect(CARD_VIEW_HTML).toContain('prefers-color-scheme: dark');
        expect(CARD_VIEW_HTML).toContain('var(--color-background-primary');
    });
});
