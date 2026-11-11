import type { ServiceId } from '../config/schema.ts';
import { DEPRECATIONS } from '../tools/deprecations.ts';
import { TOOL_NAMES, WRITE_TOOLS } from '../tools/register.ts';
import { KIND_SERVICES, TOOL_SERVICES } from './toolSurface.ts';

/**
 * The tool × service map in docs/tools.md, generated from `TOOL_SERVICES` so
 * the docs say what the server actually lists (`npm run docs:tool-map`).
 */

export const MAP_START = '<!-- tool-map:start -->';
export const MAP_END = '<!-- tool-map:end -->';

/** Every service a tool can need, in the order the docs name them: *arrs, media servers, download clients, books, requests, the rest. */
const NAMES: ReadonlyArray<readonly [ServiceId, string]> = [
    ['radarr', 'Radarr'],
    ['sonarr', 'Sonarr'],
    ['whisparr', 'Whisparr'],
    ['lidarr', 'Lidarr'],
    ['jellyfin', 'Jellyfin'],
    ['plex', 'Plex'],
    ['sabnzbd', 'SABnzbd'],
    ['nzbget', 'NZBGet'],
    ['transmission', 'Transmission'],
    ['qbittorrent', 'qBittorrent'],
    ['shelfmark', 'Shelfmark'],
    ['grimmory', 'Grimmory'],
    ['seerr', 'Seerr'],
    ['prowlarr', 'Prowlarr'],
    ['profilarr', 'Profilarr'],
    ['bazarr', 'Bazarr'],
    ['cleanuparr', 'Cleanuparr'],
    ['reclaimerr', 'Reclaimerr'],
    ['dispatcharr', 'Dispatcharr']
];

const named = (services: readonly ServiceId[]): string =>
    NAMES.filter(([id]) => services.includes(id))
        .map(([, name]) => name)
        .join(', ');

/** The two Markdown tables that go between the markers: tool → services, and kind → services. */
export function renderToolMap(): string {
    const aliases = new Set(DEPRECATIONS.filter(d => d.param === undefined).map(d => d.tool));
    const tools = TOOL_NAMES.filter(name => !aliases.has(name)).map(name => {
        const needs = TOOL_SERVICES[name];
        return `| \`${name}\`${WRITE_TOOLS.has(name) ? ' ✎' : ''} | ${needs === undefined ? 'any stack' : named(needs)} |`;
    });
    const kinds = Object.entries(KIND_SERVICES).map(([kind, services]) => `| \`${kind}\` | ${named(services)} |`);
    return [
        'A write is listed only when one of these is configured, and a read too with `tools.hide_unusable`; with nothing configured, everything is. ✎ marks a write. Deprecated aliases are left out.',
        '',
        '| Tool | Needs one of |',
        '| --- | --- |',
        ...tools,
        '',
        'What `kind` means, and which services hold it. A `kind` field offers only the kinds a configured service holds.',
        '',
        '| Kind | Held by |',
        '| --- | --- |',
        ...kinds
    ].join('\n');
}

/** `doc` with the text between `start` and `end` replaced by `body`, the markers kept. */
export function replaceBetween(doc: string, start: string, end: string, body: string): string {
    const from = doc.indexOf(start);
    const to = from === -1 ? -1 : doc.indexOf(end, from + start.length);
    if (from === -1 || to === -1) throw new Error(`markers ${start} … ${end} not found`);
    return `${doc.slice(0, from + start.length)}\n${body}\n${doc.slice(to)}`;
}
