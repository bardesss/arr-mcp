/**
 * Regenerates `screenshots/` from fixture data. Maintainer-run, never CI.
 *
 *     npm run screenshots
 *
 * No server, no port, no config — the pages are pure functions of their
 * arguments and `scripts/lib/uiFixture.ts` supplies the arguments.
 *
 * They are served through Playwright's router on a fake origin rather than
 * handed to `setContent`, because `layout` *links* its stylesheet rather than
 * inlining it. Under `setContent` the document's base is `about:blank`, so
 * `/ui/app.css` resolves to nothing and every shot comes out as unstyled serif
 * text with the 20px icons expanded to fill the viewport. Routing the real
 * asset URLs back to `assets.ts` keeps the captured markup byte-identical to
 * what the server sends, which is the only version worth photographing.
 *
 * Fixed viewport rather than `fullPage`, so all eight PNGs share dimensions and
 * a diff between runs is a change to the UI rather than a reflow.
 *
 * Both colour schemes because the CSS has a `prefers-color-scheme: light` block
 * that nothing else exercises — the dark theme is the one anyone looks at, and
 * the light one has been shipping unverified.
 */
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { CSS, JS } from '../src/web/assets.ts';
import { auditPage, dashboardPage, logsPage } from '../src/web/pages.ts';
import { configPage } from '../src/web/configPage.ts';
import { CARD_VIEW_HTML } from '../src/ui/cardView.ts';
import type { MediaCards } from '../src/ui/mediaCards.ts';
import * as fixture from './lib/uiFixture.ts';

const OUT = 'screenshots';
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 2;

/** Never resolved. Every request under it is answered from memory. */
const ORIGIN = 'http://arr-mcp.fixture';

/** These pages render a sign-out form, which carries a CSRF token bound to a
 *  session. There is no session here — this is a static render. */
const SCREENSHOT_CSRF = 'screenshot';

const PAGES: { name: string; html: string }[] = [
    {
        name: 'dashboard',
        html: dashboardPage({
            csrf: SCREENSHOT_CSRF,
            version: fixture.VERSION,
            diagnoses: fixture.DIAGNOSES,
            configured: fixture.CONFIGURED,
            tokens: fixture.CONFIG.auth.tokens,
            plaintextOnDisk: fixture.FIXTURE_PLAINTEXT_ON_DISK,
            now: fixture.NOW,
            mcpUrl: fixture.MCP_URL,
            writeCounts: fixture.WRITE_COUNTS,
            imdb: fixture.IMDB,
            disks: fixture.DISKS,
            failures: fixture.FAILURES,
            scans: fixture.SCANS,
            tiers: fixture.TIERS,
            recentWrites: fixture.AUDIT_ROWS.slice(0, 3)
        })
    },
    {
        name: 'config',
        html: configPage({
            tab: 'services',
            version: fixture.VERSION,
            config: fixture.CONFIG,
            csrf: 'fixture-csrf',
            plaintextOnDisk: fixture.FIXTURE_PLAINTEXT_ON_DISK,
            now: fixture.NOW
        })
    },
    {
        name: 'logs',
        html: logsPage({
            csrf: SCREENSHOT_CSRF,
            version: fixture.VERSION,
            services: fixture.LOG_SERVICES,
            selectedService: '',
            stream: 'all',
            streamUrl: '/ui/logs/stream?stream=all',
            rows: fixture.LOG_ROWS
        })
    },
    {
        name: 'audit',
        html: auditPage({ csrf: SCREENSHOT_CSRF, version: fixture.VERSION, rows: fixture.AUDIT_ROWS })
    }
];

async function capture(browser: Browser, scheme: 'dark' | 'light'): Promise<void> {
    const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: SCALE,
        colorScheme: scheme
    });
    const page = await context.newPage();

    let current = '';
    await page.route(`${ORIGIN}/**`, route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/ui/app.css') return route.fulfill({ contentType: 'text/css', body: CSS });
        if (path === '/ui/app.js') return route.fulfill({ contentType: 'text/javascript', body: JS });
        if (path === '/ui/page') return route.fulfill({ contentType: 'text/html', body: current });
        // The log stream poll, and nothing else. `tick` only replaces rows on an
        // ok response, so refusing it leaves the server-rendered table alone.
        return route.abort();
    });

    for (const { name, html } of PAGES) {
        current = html;
        await page.goto(`${ORIGIN}/ui/page`, { waitUntil: 'load' });
        await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
        console.log(`${OUT}/${name}-${scheme}.png`);
    }

    await context.close();
}

/**
 * The MCP Apps poster cards, in a stand-in host.
 *
 * The view runs as it would in Claude: a sandboxed iframe that asks the host
 * to initialise and is then handed a tool result. This page plays the host's
 * half of that handshake with the fixture's `cards`, and sizes the frame from
 * the view's own `size-changed`. Every poster request is answered with a
 * generated gradient, so nothing is fetched and nobody's artwork is in the repo.
 *
 * Narrower than the pages above, because a card sits in a chat column.
 */
const CARD_VIEWPORT = { width: 760, height: 480 };
const HOST_BACKGROUND = { dark: '#262624', light: '#faf9f5' } as const;

const hostPage = (cards: MediaCards, scheme: 'dark' | 'light'): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: ${HOST_BACKGROUND[scheme]}; }
#wrap { padding: 20px; width: ${CARD_VIEWPORT.width}px; box-sizing: border-box; }
iframe { display: block; width: 100%; height: 0; border: 0; }
</style></head><body><div id="wrap"><iframe id="view" sandbox="allow-scripts"></iframe></div>
<script>
const cards = ${JSON.stringify(cards)};
const frame = document.getElementById('view');
const reply = message => frame.contentWindow.postMessage(message, '*');
window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow) return;
    const m = event.data;
    if (m.method === 'ui/initialize') {
        reply({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'screenshot', version: '0' }, hostCapabilities: {}, hostContext: { theme: '${scheme}' } } });
    } else if (m.method === 'ui/notifications/initialized') {
        reply({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], _meta: { 'arr-mcp/cards': cards } } });
    } else if (m.method === 'ui/notifications/size-changed') {
        frame.style.height = m.params.height + 'px';
        document.body.dataset.ready = '1';
    }
});
frame.srcdoc = ${JSON.stringify(CARD_VIEW_HTML).replaceAll('</', '<\\/')};
</script></body></html>`;

/** A poster-shaped gradient whose hue is the file name's, so each tile differs and every run matches. */
const generatedArt = (name: string): string => {
    // Summed by position rather than rolled, which a shared `.jpg` suffix would dominate.
    const stem = name.replace(/\.[a-z]+$/, '');
    let hue = 0;
    for (const [i, ch] of [...stem].entries()) hue = (hue + ch.charCodeAt(0) * (i + 7) * 37) % 360;
    const wide = name.includes('backdrop');
    const [w, h] = wide ? [780, 439] : [342, 513];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,22%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${w * 0.7}" cy="${h * 0.3}" r="${w * 0.18}" fill="hsl(${(hue + 180) % 360},70%,80%)" opacity="0.55"/>
<path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.62} ${w * 0.55} ${h * 0.74} T ${w} ${h * 0.7} V ${h} H 0 Z" fill="hsl(${hue},40%,12%)" opacity="0.7"/>
</svg>`;
};

async function captureCards(browser: Browser, scheme: 'dark' | 'light'): Promise<void> {
    const context = await browser.newContext({ viewport: CARD_VIEWPORT, deviceScaleFactor: SCALE, colorScheme: scheme });
    let current = '';
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === ORIGIN && url.pathname === '/ui/cards') return route.fulfill({ contentType: 'text/html', body: current });
        if (url.hostname === 'image.tmdb.org') {
            // The fixture's "no artwork" tile has none; this one fails to load on purpose.
            return route.fulfill({ contentType: 'image/svg+xml', body: generatedArt(url.pathname.split('/').pop() ?? '') });
        }
        return route.abort();
    });
    const page = await context.newPage();

    for (const [name, cards] of [['cards-detail', fixture.CARD_DETAIL], ['cards-grid', fixture.CARD_GRID]] as const) {
        current = hostPage(cards, scheme);
        await page.goto(`${ORIGIN}/ui/cards`, { waitUntil: 'load' });
        await page.waitForFunction("document.body.dataset.ready === '1'");
        // The frame resizes once more after its images decode.
        await page.waitForTimeout(400);
        await page.locator('#wrap').screenshot({ path: `${OUT}/${name}-${scheme}.png` });
        console.log(`${OUT}/${name}-${scheme}.png`);
    }

    await context.close();
}

async function main(): Promise<void> {
    await mkdir(OUT, { recursive: true });

    let browser: Browser;
    try {
        browser = await chromium.launch();
    } catch (error) {
        // The `playwright` package ships no browsers; they are a separate,
        // explicit download. Saying so beats the library's own stack trace.
        console.error(`${String(error)}\n\nRun: npx playwright install chromium`);
        process.exitCode = 1;
        return;
    }

    try {
        await capture(browser, 'dark');
        await capture(browser, 'light');
        await captureCards(browser, 'dark');
        await captureCards(browser, 'light');
    } finally {
        await browser.close();
    }
}

await main();
