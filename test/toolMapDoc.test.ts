import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_SERVICES } from '../src/mcp/toolSurface.ts';
import { MAP_END, MAP_START, renderToolMap, replaceBetween } from '../src/mcp/toolMap.ts';
import { DEPRECATIONS } from '../src/tools/deprecations.ts';
import { TOOL_NAMES, WRITE_TOOLS } from '../src/tools/register.ts';

const doc = readFileSync(new URL('../docs/tools.md', import.meta.url), 'utf8');
const aliases = new Set(DEPRECATIONS.filter(d => d.param === undefined).map(d => d.tool));
const current = TOOL_NAMES.filter(n => !aliases.has(n));
const rowOf = (map: string, tool: string): string | undefined => map.split('\n').find(line => line.startsWith(`| \`${tool}\``));

describe('the tool map', () => {
    const map = renderToolMap();

    it('has one row per current tool and none for a deprecated alias', () => {
        for (const tool of current) expect(rowOf(map, tool), tool).toBeDefined();
        for (const alias of aliases) expect(rowOf(map, alias), alias).toBeUndefined();
    });

    it('names the services a tool needs, and says when it needs none', () => {
        expect(rowOf(map, 'get_subtitles')).toContain('Bazarr');
        expect(rowOf(map, 'get_library')).toContain('any stack');
        expect(Object.keys(TOOL_SERVICES)).toContain('get_subtitles');
    });

    it('marks the write tools', () => {
        expect(rowOf(map, 'add_media')).toContain('✎');
        expect(rowOf(map, 'get_queue')).not.toContain('✎');
        expect([...WRITE_TOOLS].every(t => aliases.has(t) || rowOf(map, t)?.includes('✎'))).toBe(true);
    });

    it('lists which services hold each kind', () => {
        expect(map).toContain('| `series` | Sonarr, Whisparr |');
        expect(map).toContain('| `book` | Shelfmark, Grimmory |');
    });

    it('says when a read is listed, not only a write', () => {
        expect(map).toContain('hide_unusable');
        expect(map).toContain('Deprecated aliases are left out');
    });

    it('is what docs/tools.md carries', () => {
        const start = doc.indexOf(MAP_START);
        const end = doc.indexOf(MAP_END);
        expect(start, 'docs/tools.md has no tool map markers').toBeGreaterThan(-1);
        expect(doc.slice(start + MAP_START.length, end).trim(), 'docs/tools.md is out of date: run npm run docs:tool-map').toBe(renderToolMap().trim());
    });
});

describe('the route diagram', () => {
    const block = /```mermaid\n([\s\S]*?)```/.exec(doc)?.[1];

    it('is in docs/tools.md', () => {
        expect(block).toBeDefined();
    });

    it('names only tools that exist', () => {
        const named = new Set((block ?? '').match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
        expect(named.size).toBeGreaterThan(5);
        expect([...named].filter(n => !(TOOL_NAMES as readonly string[]).includes(n) && n !== 'next_steps')).toEqual([]);
    });
});

describe('replaceBetween', () => {
    it('finds the end marker after the start, even when one is quoted above it', () => {
        const doc = ['see <!-- e --> here', '<!-- s -->', 'old', '<!-- e -->', 'tail'].join('\n');
        expect(replaceBetween(doc, '<!-- s -->', '<!-- e -->', 'new')).toBe(['see <!-- e --> here', '<!-- s -->', 'new', '<!-- e -->', 'tail'].join('\n'));
    });
});
