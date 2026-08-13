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
import * as fixture from './lib/uiFixture.ts';

const OUT = 'screenshots';
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 2;

/** Never resolved. Every request under it is answered from memory. */
const ORIGIN = 'http://arr-mcp.fixture';

const PAGES: { name: string; html: string }[] = [
    {
        name: 'dashboard',
        html: dashboardPage({
            version: fixture.VERSION,
            diagnoses: fixture.DIAGNOSES,
            configured: fixture.CONFIGURED,
            bearerToken: fixture.FIXTURE_TOKEN,
            mcpUrl: fixture.MCP_URL,
            writeCounts: fixture.WRITE_COUNTS,
            imdb: fixture.IMDB,
            disks: fixture.DISKS,
            failures: fixture.FAILURES,
            scans: fixture.SCANS
        })
    },
    {
        name: 'config',
        html: configPage({
            version: fixture.VERSION,
            config: fixture.CONFIG,
            csrf: 'fixture-csrf'
        })
    },
    {
        name: 'logs',
        html: logsPage({
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
        html: auditPage({ version: fixture.VERSION, rows: fixture.AUDIT_ROWS })
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
    } finally {
        await browser.close();
    }
}

await main();
