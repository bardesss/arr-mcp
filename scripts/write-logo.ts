// Writes assets/logo.svg from the constant the config UI serves at /ui/icon.svg,
// so the README, the Unraid template and the favicon cannot drift apart.
// test/webIcons.test.ts fails if they do.
//
// Also rasterises assets/logo.png: Community Applications renders the icon as an
// <img> in a grid and wants a raster, so the one drawing serves both.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MARK_SVG } from '../src/web/icons.ts';

/** What CA's grid asks for. Transparent, so it sits on either theme. */
const PNG_SIZE = 256;

const svgTarget = new URL('../assets/logo.svg', import.meta.url);
writeFileSync(svgTarget, MARK_SVG);
console.log(`wrote ${svgTarget.pathname.slice(1)}`);

const browser = await chromium.launch();
const page = await browser.newPage({
    viewport: { width: PNG_SIZE, height: PNG_SIZE },
    deviceScaleFactor: 1
});
await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${PNG_SIZE}px;height:${PNG_SIZE}px}</style>${MARK_SVG}`
);
const pngTarget = new URL('../assets/logo.png', import.meta.url);
await page.screenshot({ path: fileURLToPath(pngTarget), omitBackground: true });
await browser.close();
console.log(`wrote ${pngTarget.pathname.slice(1)}`);
