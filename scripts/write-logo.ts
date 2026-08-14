// Writes assets/logo.svg from the constant the config UI serves at /ui/icon.svg,
// so the README, the Unraid template and the favicon cannot drift apart.
// test/webIcons.test.ts fails if they do.
import { writeFileSync } from 'node:fs';
import { MARK_SVG } from '../src/web/icons.ts';

const target = new URL('../assets/logo.svg', import.meta.url);
writeFileSync(target, MARK_SVG);
console.log(`wrote ${target.pathname.slice(1)}`);
