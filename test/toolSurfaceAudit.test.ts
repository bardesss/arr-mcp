import { describe, expect, it } from 'vitest';
import { instructionsFor } from '../src/app.ts';
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

    it('keeps the import route on a Radarr-only stack', async () => {
        const tools = await listTools({ radarr: svc(7878) });
        expect(tools.find(t => t.name === 'get_queue')?.description).toContain('downloadId');
    });
});
