/**
 * Regenerates the tool × service map in docs/tools.md from `TOOL_SERVICES`.
 *
 *   npm run docs:tool-map
 *
 * test/toolMapDoc.test.ts fails when the docs and the map disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MAP_END, MAP_START, renderToolMap, replaceBetween } from '../src/mcp/toolMap.ts';

const path = new URL('../docs/tools.md', import.meta.url);
writeFileSync(path, replaceBetween(readFileSync(path, 'utf8'), MAP_START, MAP_END, renderToolMap()));
console.log('docs/tools.md: tool map regenerated');
