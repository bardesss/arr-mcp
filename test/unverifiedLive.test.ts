import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ServiceIdSchema, type ServiceId } from '../src/config/schema.js';
import { TOOL_NAMES } from '../src/tools/register.js';

/**
 * A read or write path with no live capture or confirmed live run has a row in
 * docs/writes.md. When its tool has a section in docs/tools.md, that section
 * also carries the marker `**Unverified live** (<service>): <what>.`; a tool
 * with no section needs the row alone. Every marker must have a row.
 */

const MARKER = '**Unverified live**';

const DISPLAY: Record<ServiceId, string> = {
    radarr: 'Radarr',
    sonarr: 'Sonarr',
    whisparr: 'Whisparr',
    lidarr: 'Lidarr',
    prowlarr: 'Prowlarr',
    bazarr: 'Bazarr',
    jellyfin: 'Jellyfin',
    seerr: 'Seerr',
    sabnzbd: 'SABnzbd',
    nzbget: 'NZBGet',
    transmission: 'Transmission',
    qbittorrent: 'qBittorrent',
    plex: 'Plex',
    profilarr: 'Profilarr',
    cleanuparr: 'Cleanuparr',
    reclaimerr: 'Reclaimerr',
    dispatcharr: 'Dispatcharr',
    shelfmark: 'Shelfmark',
    grimmory: 'Grimmory'
};

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

type Row = { tool: string; service: string };

const writes = read('docs/writes.md');
const tools = read('docs/tools.md');

const SECTION = '## Not yet run against a live service';

function rows(): Row[] {
    const start = writes.indexOf(`\n${SECTION}\n`);
    if (start === -1) return [];
    const rest = writes.slice(start + SECTION.length + 2);
    const end = rest.search(/\n## /);
    const body = end === -1 ? rest : rest.slice(0, end);
    return body
        .split('\n')
        .filter(line => line.startsWith('|'))
        .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
        .filter(cells => cells.length === 4 && cells[0] !== 'Tool' && !/^-+$/.test(cells[0]!))
        .map(cells => ({ tool: cells[0]!.replaceAll('`', ''), service: cells[1]!.replaceAll('`', '') }));
}

/** Every `## ` section of tools.md, keyed by the backticked tool names in its heading. */
function sections(): { tools: string[]; body: string }[] {
    return tools
        .split(/\n(?=## )/)
        .filter(s => s.startsWith('## '))
        .map(s => ({ tools: [...(s.split('\n')[0] ?? '').matchAll(/`([a-z_]+)`/g)].map(m => m[1]!), body: s }));
}

/** A tool can have more than one section (`get_history` has two); they are read as one. */
const sectionOf = (tool: string): string | undefined => {
    const own = sections().filter(s => s.tools.includes(tool));
    return own.length === 0 ? undefined : own.map(s => s.body).join('\n');
};

describe('tools that have never run against a live service', () => {
    const table = rows();

    it('lists at least one row', () => {
        expect(table.length).toBeGreaterThan(0);
    });

    it('has no row twice', () => {
        const keys = table.map(r => `${r.tool}/${r.service}`);
        // Several paths of one tool and service share a single row.
        expect(new Set(keys).size).toBe(keys.length);
    });

    it.each(table.map(r => [r.tool, r.service] as const))('%s on %s names a real tool and service, and carries the marker where the tool has a section', (tool, service) => {
        expect(TOOL_NAMES as readonly string[]).toContain(tool);
        expect(ServiceIdSchema.options as readonly string[]).toContain(service);

        // A tool without a section in tools.md is covered by its row alone.
        const section = sectionOf(tool);
        if (section === undefined) return;

        const display = DISPLAY[service as ServiceId];
        expect(section, `the ${tool} section has no marker for ${display}`).toContain(`${MARKER} (${display})`);
    });

    it('has a table row for every marker in docs/tools.md', () => {
        const known = new Set(table.map(r => `${r.tool}/${r.service}`));
        const byDisplay = new Map(Object.entries(DISPLAY).map(([id, name]) => [name, id]));

        const found: string[] = [];
        for (const section of sections()) {
            for (const m of section.body.matchAll(/\*\*Unverified live\*\* \(([^)]+)\)/g)) {
                const id = byDisplay.get(m[1]!);
                expect(id, `"${m[1]}" is not a service display name`).toBeDefined();
                expect(section.tools.length, 'a marker sits under a heading with no tool name').toBeGreaterThan(0);
                found.push(`${section.tools[0]}/${id}`);
            }
        }

        expect(found.length).toBeGreaterThan(0);
        for (const key of found) expect(known, `${key} has a marker but no row in docs/writes.md`).toContain(key);
    });
});
