import { describe, expect, it } from 'vitest';
import { instructionsFor } from '../src/app.ts';
import { TOOL_DOCS } from '../src/mcp/toolDocs.ts';
import { TOOL_SERVICES } from '../src/mcp/toolSurface.ts';
import type { ServiceId } from '../src/config/schema.ts';
import { listTools, svc, type Tool } from '../scripts/lib/listTools.ts';

// What a client reads on a stack should not talk about services that stack
// does not run (#518). Every such sentence costs every session tokens and
// tells the model nothing it can act on.

const DISPLAY: Record<ServiceId, readonly string[]> = {
    radarr: ['Radarr'],
    sonarr: ['Sonarr'],
    whisparr: ['Whisparr'],
    lidarr: ['Lidarr', 'MusicBrainz'],
    prowlarr: ['Prowlarr'],
    bazarr: ['Bazarr'],
    jellyfin: ['Jellyfin'],
    seerr: ['Seerr'],
    sabnzbd: ['SABnzbd'],
    nzbget: ['NZBGet'],
    transmission: ['Transmission'],
    qbittorrent: ['qBittorrent'],
    plex: ['Plex'],
    profilarr: ['Profilarr'],
    cleanuparr: ['Cleanuparr'],
    reclaimerr: ['Reclaimerr'],
    dispatcharr: ['Dispatcharr'],
    shelfmark: ['Shelfmark'],
    grimmory: ['Grimmory', 'Bookdrop']
};

/**
 * Mentions that stay on every stack, each with why. `text` is a substring of
 * the sentence that names the service.
 */
const ALLOWED: ReadonlyArray<{ tool: string; text: string; why: string }> = [
    { tool: 'discover_media', text: 'Without Seerr', why: 'says where the answer comes from on a stack with no Seerr' }
];

const STACKS: Record<string, Record<string, unknown>> = {
    small: { radarr: svc(7878), sonarr: svc(8989), sabnzbd: svc(8080), jellyfin: svc(8096, { default_user: 'u' }) },
    lidarrOnly: { lidarr: svc(8686), sabnzbd: svc(8080) },
    books: { grimmory: { url: 'http://192.0.2.10:6060', username: 'u', password: 'p' }, shelfmark: svc(8084) }
};

/** Every description a client reads for one tool: its own and each input field's. */
function descriptions(tool: Tool): string[] {
    const out = tool.description === undefined ? [] : [tool.description];
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== 'object' || node === null) return;
        for (const [key, value] of Object.entries(node)) {
            if (key === 'description' && typeof value === 'string') out.push(value);
            else walk(value);
        }
    };
    walk(tool.inputSchema);
    return out;
}

const sentences = (text: string): string[] => text.split(/(?<=[.;:])\s+/);

/** `${stack} ${tool}: "${sentence}"` for every sentence naming a service that stack does not run. */
function strays(stack: string, configured: ReadonlySet<string>, texts: ReadonlyArray<{ tool: string; text: string }>): string[] {
    const absent = (Object.entries(DISPLAY) as [ServiceId, readonly string[]][]).filter(([id]) => !configured.has(id)).flatMap(([, names]) => names);
    const found: string[] = [];
    for (const { tool, text } of texts) {
        for (const sentence of sentences(text)) {
            if (!absent.some(name => new RegExp(`\\b${name}\\b`).test(sentence))) continue;
            if (ALLOWED.some(a => a.tool === tool && sentence.includes(a.text))) continue;
            found.push(`${stack} ${tool}: "${sentence}"`);
        }
    }
    return found;
}

describe('the tool list on a stack', () => {
    it('names no service the stack does not run', { timeout: 60_000 }, async () => {
        const found: string[] = [];
        for (const [stack, services] of Object.entries(STACKS)) {
            const configured = new Set(Object.keys(services));
            const tools = await listTools(services);
            // A tool none of whose own services is here (get_subtitles without
            // Bazarr) is named for them; tools.hide_unusable hides it.
            const usable = tools.filter(t => TOOL_SERVICES[t.name]?.some(s => configured.has(s)) ?? true);
            const texts = [
                ...usable.flatMap(t => descriptions(t).map(text => ({ tool: t.name, text }))),
                { tool: 'instructions', text: instructionsFor({ configured: configured as Set<ServiceId>, hideUnusable: false }) }
            ];
            found.push(...strays(stack, configured, texts));
        }
        expect(found).toEqual([]);
    });

    it('names no service id the stack does not run in a `service` field', async () => {
        const found: string[] = [];
        for (const [stack, services] of Object.entries(STACKS)) {
            const absent = (Object.keys(DISPLAY) as ServiceId[]).filter(id => !(id in services));
            for (const tool of await listTools(services)) {
                if (!TOOL_SERVICES[tool.name]?.some(s => s in services)) continue;
                const text = (tool.inputSchema as { properties?: { service?: { description?: string } } } | undefined)?.properties?.service?.description ?? '';
                const named = absent.filter(id => new RegExp(`\\b${id}\\b`).test(text));
                if (named.length > 0) found.push(`${stack} ${tool.name}: ${named.join(', ')}`);
            }
        }
        expect(found).toEqual([]);
    });

    it('drops the punctuation with a dropped clause', async () => {
        const tools = await listTools(STACKS['small']!);
        const text = (name: string) => tools.find(t => t.name === name)?.description ?? '';
        expect(text('trigger_scan')).toContain('needs `id`). Importing a download');
        expect(text('grab_release')).toContain('Pass the same `season` or `episode` get_releases used');
        expect(text('get_stack_health')).toContain('`seedingRules` (client and indexer seed limits) and each');
    });

    it('mentions `sort` only on a tool that takes it', async () => {
        type Props = Record<string, { description?: string }>;
        const tools = await listTools({});
        const props = (name: string): Props => ((tools.find(t => t.name === name)?.inputSchema as { properties?: Props } | undefined)?.properties ?? {});
        const told = tools.filter(t => !('sort' in props(t.name)) && /`sort`/.test(JSON.stringify(t.inputSchema))).map(t => t.name);
        expect(told).toEqual([]);
        expect(props('get_library')['sort']?.description).toContain('`offset`');
    });

    it('describes the `user` of get_requests as whose requests, not whose playback', async () => {
        const tool = (await listTools({})).find(t => t.name === 'get_requests');
        const user = (tool?.inputSchema as { properties: Record<string, { description?: string }> }).properties['user']?.description ?? '';
        expect(user).toMatch(/requests/);
        expect(user).not.toMatch(/playback/);
    });

    it('offers get_calendar no `book` kind, since no book service has a calendar', async () => {
        for (const services of [{}, STACKS['books']!]) {
            const tool = (await listTools(services)).find(t => t.name === 'get_calendar');
            const kind = (tool?.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties['kind'];
            expect(kind?.enum).not.toContain('book');
        }
    });

    it('points every tool with a field reference at it', async () => {
        const tools = await listTools({});
        const missing = Object.keys(TOOL_DOCS).filter(name => !tools.find(t => t.name === name)?.description?.endsWith(`Field reference: arr://docs/${name}.`));
        expect(missing).toEqual([]);
    });

    it('lists only configured services in a `service` enum', async () => {
        const services = STACKS['small']!;
        const offered = (await listTools(services)).flatMap(t => {
            const listed = (t.inputSchema as { properties?: { service?: { enum?: string[] } } } | undefined)?.properties?.service?.enum ?? [];
            return listed.filter(s => !(s in services)).length === 0 ? [] : [t.name];
        });
        // A tool none of whose services is here names them all, so a call stays writable.
        expect(offered.filter(name => TOOL_SERVICES[name]?.some(s => s in services) ?? true)).toEqual([]);
    });

    it('keeps the import route on a Radarr-only stack', async () => {
        const tools = await listTools({ radarr: svc(7878) });
        expect(tools.find(t => t.name === 'get_queue')?.description).toContain('downloadId');
    });

    it('offers trigger_scan `bookdrop` only with Grimmory', async () => {
        type Props = Record<string, { enum?: string[]; default?: unknown }>;
        const action = async (services: Record<string, unknown>) =>
            ((await listTools(services)).find(t => t.name === 'trigger_scan')?.inputSchema as { properties: Props }).properties['action'];
        expect((await action(STACKS['small']!))?.enum).toEqual(['scan', 'rename']);
        expect((await action(STACKS['small']!))?.default).toBe('scan');
        expect((await action(STACKS['books']!))?.enum).toContain('bookdrop');
        expect((await action({}))?.enum).toContain('bookdrop');
    });

    it('describes `episode` on Whisparr, where it is a scene id', async () => {
        for (const name of ['get_releases', 'grab_release']) {
            const tool = (await listTools(SHAPES_WHISPARR)).find(t => t.name === name);
            const episode = (tool?.inputSchema as { properties: Record<string, { description?: string }> }).properties['episode'];
            expect(episode?.description, name).toMatch(/Whisparr/);
            expect(episode?.description, name).not.toMatch(/Sonarr/);
        }
    });

    it('says a Sonarr or Whisparr re-search in grab_release needs `season` or `episode`', async () => {
        const text = (await listTools(SHAPES_WHISPARR)).find(t => t.name === 'grab_release')?.description ?? '';
        expect(text).toContain('A Whisparr re-search needs `season` or `episode`.');
        const radarrOnly = (await listTools({ radarr: svc(7878) })).find(t => t.name === 'grab_release')?.description ?? '';
        expect(radarrOnly).not.toContain('re-search needs');
    });
});

const SHAPES_WHISPARR = { whisparr: svc(6969), sabnzbd: svc(8080) };

/** Stacks the grammar guard reads every listed tool on, each a realistic shape. */
const SHAPES: Record<string, Record<string, unknown>> = {
    ...STACKS,
    empty: {},
    grimmoryOnly: { grimmory: STACKS['books']!['grimmory'] },
    shelfmarkOnly: { shelfmark: svc(8084) },
    plexOnly: { plex: svc(32400) },
    jellyfinOnly: { jellyfin: svc(8096, { default_user: 'u' }) },
    prowlarrOnly: { prowlarr: svc(9696) },
    seerrJellyfin: { seerr: svc(5055, { default_user: 'u' }), jellyfin: svc(8096, { default_user: 'u' }) },
    whisparr: { whisparr: svc(6969), sabnzbd: svc(8080) },
    radarrPlexQbit: { radarr: svc(7878), plex: svc(32400), qbittorrent: { url: 'http://192.0.2.10:8081' } }
};

/** What a dropped scope or an emptied list leaves behind. */
const BROKEN: ReadonlyArray<[RegExp, string]> = [
    [/\b(?:across|already in|Only)\s*[,;:.]/, 'a preposition with nothing after it'],
    [/\b(?:across|looked up in|merged from)\s+(?:and\b|,)/, 'a list that came out empty'],
    [/^(?:Or|And)\b/, 'a sentence continuing one that was dropped'],
    [/[a-z`)]\.[A-Z]/, 'no space after a full stop'],
    [/\band [A-Z][\w-]+(?: [\w-]+)? and\b/, 'two "and"s in one list']
];

describe('scoped text on any stack', () => {
    it('reads as whole sentences', { timeout: 120_000 }, async () => {
        const found: string[] = [];
        for (const [stack, services] of Object.entries(SHAPES)) {
            const configured = new Set(Object.keys(services)) as Set<ServiceId>;
            const tools = await listTools(services);
            const texts = [...tools.flatMap(t => descriptions(t).map(text => ({ tool: t.name, text }))), { tool: 'instructions', text: instructionsFor({ configured, hideUnusable: false }) }];
            for (const { tool, text } of texts) {
                for (const [pattern, why] of BROKEN) {
                    const m = pattern.exec(text);
                    if (m !== null) found.push(`${stack} ${tool}: ${why}: "…${text.slice(Math.max(0, m.index - 40), m.index + 30)}…"`);
                }
            }
        }
        expect([...new Set(found)]).toEqual([]);
    });
});
