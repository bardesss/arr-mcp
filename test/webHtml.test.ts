import { describe, expect, it, vi } from 'vitest';
import { BEARER_CALLER, type AuditRow } from '../src/core/audit.ts';
import type { DiskSpace } from '../src/services/types.ts';
import { JS } from '../src/web/assets.ts';
import { groupDisks, humanBytes } from '../src/core/disks.ts';
import { esc, html, raw, shortTime } from '../src/web/html.ts';
import { auditPage, healthRowView, loginPage } from '../src/web/pages.ts';

describe('escaping', () => {
    it('neutralises the characters that end a tag or an attribute', () => {
        expect(esc(`<script>alert('x')</script>`)).toBe(
            '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;'
        );
        expect(esc('a"b')).toBe('a&quot;b');
        expect(esc('a&b')).toBe('a&amp;b');
    });

    it('renders null and undefined as nothing, not as the words', () => {
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
    });
});

describe('the html template', () => {
    it('escapes every interpolation by default', () => {
        const evil = '<img src=x onerror=alert(1)>';
        expect(html`<p>${evil}</p>`.value).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    });

    // The escape hatch has to be visible at the call site, or it becomes the
    // accidental default.
    it('passes SafeHtml through untouched', () => {
        expect(html`<p>${raw('<b>bold</b>')}</p>`.value).toBe('<p><b>bold</b></p>');
    });

    it('joins arrays without separators, so rendered rows drop straight in', () => {
        const rows = [html`<li>a</li>`, html`<li>b</li>`];
        expect(html`<ul>${rows}</ul>`.value).toBe('<ul><li>a</li><li>b</li></ul>');
    });

    it('escapes inside an array too', () => {
        expect(html`<ul>${['<x>', '<y>']}</ul>`.value).toBe('<ul>&lt;x&gt;&lt;y&gt;</ul>');
    });

    // A release name from a public indexer is the most attacker-controllable
    // string in the system, and it reaches the audit view and the log table.
    it('is safe for a release name that tries to break out of an attribute', () => {
        const release = `Film.2026" onload="alert(1)`;
        const out = html`<td title="${release}">x</td>`.value;
        expect(out).not.toContain('onload="alert(1)"');
        expect(out).toContain('&quot;');
    });

    it('is safe for a fenced value, whose brackets are literal text', () => {
        const fenced = '<<untrusted:radarr.title>>Alien<</>>';
        expect(html`<td>${fenced}</td>`.value).toBe(
            '<td>&lt;&lt;untrusted:radarr.title&gt;&gt;Alien&lt;&lt;/&gt;&gt;</td>'
        );
    });
});

describe('formatting helpers', () => {
    it('scales bytes to something a person reads', () => {
        expect(humanBytes(0)).toBe('0 B');
        expect(humanBytes(1024)).toBe('1.0 KiB');
        expect(humanBytes(25_900_000_000)).toBe('24.1 GiB');
    });

    it('reports unknown sizes as unknown rather than as zero', () => {
        expect(humanBytes(undefined)).toBe('n/a');
        expect(humanBytes(Number.NaN)).toBe('n/a');
    });

    it('shortens an ISO timestamp for a log table', () => {
        expect(shortTime('2026-08-06T12:11:18.123Z')).toBe('2026-08-06 12:11:18');
    });
});

/**
 * Ten rows to say "you have two disks" is the shape this collapses: a stack's
 * services are containers over the same host filesystems, so the array that
 * reaches the dashboard is mostly the same disks repeated.
 */
describe('grouping the disks a stack reports', () => {
    const disk = (service: string, freeSpace: number, totalSpace?: number): DiskSpace => ({
        service,
        label: `${service} mount`,
        freeSpace,
        ...(totalSpace === undefined ? {} : { totalSpace })
    });

    it('collapses one filesystem seen through many mounts into one row', () => {
        const groups = groupDisks([
            disk('radarr', 5_000_000_000_000, 10_800_000_000_000),
            disk('radarr', 5_000_000_000_000, 10_800_000_000_000),
            disk('sonarr', 5_000_000_000_000, 10_800_000_000_000)
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.services).toEqual(['radarr', 'sonarr']);
    });

    // Transmission reports free space without a total, so it has nothing to
    // contradict and belongs on the disk it shares rather than on a row of
    // its own.
    it('folds a total-less mount onto the disk it matches', () => {
        const groups = groupDisks([
            disk('sabnzbd', 5_000_000_000_000, 10_800_000_000_000),
            disk('transmission', 5_000_000_000_000)
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.totalSpace).toBe(10_800_000_000_000);
        expect(groups[0]?.services).toEqual(['sabnzbd', 'transmission']);
    });

    // Free bytes are the fingerprint, but a contradicting total outranks them:
    // two disks that agree on free space and disagree on size are two disks.
    it('keeps disks apart when their totals disagree', () => {
        const groups = groupDisks([
            disk('radarr', 140_000_000_000, 228_000_000_000),
            disk('jellyfin', 140_000_000_000, 500_000_000_000)
        ]);

        expect(groups).toHaveLength(2);
    });

    it('names each instance once, however many mounts it reported', () => {
        const groups = groupDisks([
            disk('radarr/4k', 100, 200),
            disk('radarr/4k', 100, 200),
            disk('radarr/4k', 100, 200)
        ]);

        expect(groups[0]?.services).toEqual(['radarr/4k']);
    });

    // The disk about to cause a failed import is the one worth reading first.
    it('puts the emptiest disk at the top', () => {
        const groups = groupDisks([disk('a', 900), disk('b', 100), disk('c', 500)]);
        expect(groups.map(g => g.freeSpace)).toEqual([100, 500, 900]);
    });

    it('has nothing to say about an empty list', () => {
        expect(groupDisks([])).toEqual([]);
    });

    /**
     * Not every service has byte precision to report.
     *
     * SABnzbd returns disk space as gigabytes in a string — `arrRatings`' sibling
     * comment in `sabnzbd.ts` records a live 5.0.4 answering `"4711.95"` — so its
     * quantum is 0.01 GB, about 10.7 MB. The *arrs return exact byte counts. The
     * same filesystem therefore arrives from the two of them several megabytes
     * apart, `humanBytes` rounds both to `4.6 TB`, and a reader sees one disk
     * listed twice with identical numbers.
     */
    it('merges one filesystem reported by a service with only 2-decimal GB precision', () => {
        const GB = 1024 ** 3;
        const arrFree = 5_061_398_528_000;
        const arrTotal = 11_878_195_200_000;
        // Exactly what SABnzbd would report for that filesystem, round-tripped
        // through its own precision rather than hand-picked to pass.
        const sabFree = Math.round(Number((arrFree / GB).toFixed(2)) * GB);
        const sabTotal = Math.round(Number((arrTotal / GB).toFixed(2)) * GB);

        expect(sabFree).not.toBe(arrFree);

        const groups = groupDisks([
            disk('radarr', arrFree, arrTotal),
            disk('sonarr', arrFree, arrTotal),
            disk('sabnzbd', sabFree, sabTotal)
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.services).toEqual(['radarr', 'sonarr', 'sabnzbd']);
    });

    it('folds a total-less mount onto a disk reported at lower precision', () => {
        const GB = 1024 ** 3;
        const arrFree = 5_061_398_528_000;
        const sabFree = Math.round(Number((arrFree / GB).toFixed(2)) * GB);

        const groups = groupDisks([disk('sabnzbd', sabFree, 11_878_195_200_000), disk('transmission', arrFree)]);
        expect(groups).toHaveLength(1);
    });

    // The tolerance must not be so generous that it swallows real differences.
    it('still separates two disks that differ by more than rounding could explain', () => {
        const groups = groupDisks([
            disk('radarr', 5_061_398_528_000, 11_878_195_200_000),
            disk('jellyfin', 4_800_000_000_000, 11_878_195_200_000)
        ]);
        expect(groups).toHaveLength(2);
    });
});

/**
 * The audit trail's arguments are stored as JSON in one column, and printing
 * that column into a cell is what made this page unreadable: an object on one
 * line, beside six other columns.
 */
describe('the write audit', () => {
    const row = (over: Partial<AuditRow> = {}): AuditRow => ({
        id: 1,
        at: '2026-08-12T14:03:11.000Z',
        tool: 'delete_media',
        service: 'radarr/4k',
        operation: 'delete',
        tier: 'destructive',
        target: '1535',
        args: '{"id":"1535","delete_files":true}',
        outcome: 'applied',
        detail: null,
        settled_at: null,
        caller: BEARER_CALLER,
        ...over
    });

    it('renders each recorded argument as its own field', () => {
        const page = auditPage({ csrf: 'test-csrf', version: '1.4.1', rows: [row()] });

        expect(page).toContain('<dt class="mono">delete_files</dt>');
        expect(page).toContain('<dd class="mono">true</dd>');
        // The blob it is stored as never reaches the page.
        expect(page).not.toContain('{&quot;id&quot;');
    });

    it('shows arguments that do not parse verbatim rather than dropping them', () => {
        const page = auditPage({ csrf: 'test-csrf', version: '1.4.1', rows: [row({ args: 'not json at all' })] });
        expect(page).toContain('not json at all');
    });

    /**
     * A bulk write names every id it touched. `set_monitoring` across the
     * artists of a 1,578-artist Lidarr carries about 11 KB of ids, and this page
     * renders 300 rows, so one such write would push the page into megabytes.
     * The row keeps the list; the cell says how long it is.
     */
    it('bounds a long id list instead of printing every id', () => {
        const ids = Array.from({ length: 1578 }, (_, i) => String(i + 1));
        const page = auditPage({
            csrf: 'test-csrf',
            version: '1.4.1',
            rows: [row({ args: JSON.stringify({ level: 'artist', artist_ids: ids }) })]
        });

        expect(page).toContain('[1578 items]');
        expect(page).not.toContain('&quot;1578&quot;');
        expect(page.length).toBeLessThan(60_000);
    });

    // A log's value is that nothing goes missing from it, so a shape nobody
    // expected is a reason to print it, not to skip the row.
    it('survives arguments that are valid JSON but not an object', () => {
        const page = auditPage({ csrf: 'test-csrf', version: '1.4.1', rows: [row({ args: '[1,2]' })] });
        expect(page).toContain('[1,2]');
        expect(page).toContain('delete_media');
    });

    /**
     * Three of the values this column holds are not a client's name, and
     * printing them as one would invent a client called "bearer".
     */
    it("names a client id, and says in words what the non-names mean", () => {
        const page = (caller: string | null) =>
            auditPage({ csrf: 'test-csrf', version: '1.4.1', rows: [row({ caller })] });

        expect(page('oauth:desktop-client')).toContain('<dd class="mono">desktop-client</dd>');
        expect(page(BEARER_CALLER)).toContain('the static bearer token (before named tokens)');
        expect(page('bearer:phone#a1b2c3d4')).toContain('<dd class="mono">phone · a1b2c3d4</dd>');
        // A client whose id is literally "bearer" is stored as `oauth:bearer`,
        // so it can never be read as the static token.
        expect(page('oauth:bearer')).not.toContain('the static bearer token');
        expect(page('oauth:bearer')).toContain('<dd class="mono">bearer</dd>');
        // A token that named no client is a bare `oauth:`, so a client actually
        // called "unknown" is a different value from it.
        expect(page('oauth:')).toContain('named no client');
        expect(page('oauth:unknown')).toContain('<dd class="mono">unknown</dd>');
        // A blank cell means one thing: the row predates the column.
        expect(page(null)).toContain('before callers were logged');
    });

    it('escapes a client id rather than trusting the token that supplied it', () => {
        const page = auditPage({
            csrf: 'test-csrf',
            version: '1.4.1',
            rows: [row({ caller: 'oauth:<script>alert(1)</script>' })]
        });
        expect(page).not.toContain('<script>alert(1)</script>');
        expect(page).toContain('&lt;script&gt;');
    });

    it('marks the outcomes worth stopping on, and leaves a preview unmarked', () => {
        const marked = auditPage({ csrf: 'test-csrf', version: '1.4.1', rows: [row({ outcome: 'failed' })] });
        expect(marked).toContain('<span class="badge failed">failed</span>');

        const plain = auditPage({ csrf: 'test-csrf', version: '1.4.1', rows: [row({ outcome: 'unconfirmed' })] });
        expect(plain).toContain('<span class="badge unconfirmed">unconfirmed</span>');
    });

    it('escapes a detail the service handed back', () => {
        const page = auditPage({
            csrf: 'test-csrf',
            version: '1.4.1',
            rows: [row({ outcome: 'failed', detail: '<img src=x onerror=alert(1)>' })]
        });
        expect(page).not.toContain('<img src=x');
        expect(page).toContain('&lt;img src=x');
    });
});

/**
 * The footer is on every page including sign-in, because the person locked out
 * is exactly the person who needs the issue tracker.
 */
describe('the footer', () => {
    it('links to the repository and the issue form, without leaking the host', () => {
        const page = loginPage({ version: '1.4.1' });

        // Both carry noreferrer: a plain-http LAN page linking out would
        // otherwise hand github.com the hostname and port this instance
        // answers on.
        expect(page).toContain('href="https://github.com/bardesss/arr-mcp" target="_blank" rel="noreferrer"');
        expect(page).toContain(
            'href="https://github.com/bardesss/arr-mcp/issues/new/choose" target="_blank" rel="noreferrer"'
        );
    });
});

/**
 * The client script is a template literal in a TypeScript file, which means a
 * backtick or a `\n` written without escaping it twice is a syntax error in the
 * *served* file and nothing at all in the source. Nothing else here parses it,
 * so a broken build of it takes out the log stream, the copy buttons and the
 * add dialog at once, silently, on a page the type checker calls fine.
 *
 * `new Function` compiles without running: enough to catch the mistake, and it
 * never touches the `document` this expects.
 */
describe('the client script', () => {
    it('is valid JavaScript once the template literal has been built', () => {
        expect(() => new Function(JS)).not.toThrow();
    });

    // The specific one that got through: a remedy is printed under its detail,
    // so the separator has to reach the browser as an escape sequence, not as
    // the line break that ends the string it lives in.
    it('emits its newline separator as an escape, not as a line break', () => {
        expect(JS).toContain(String.raw`'\n' + err.remedy`);
    });
});

/**
 * The reload a running scan asks for, run against a stand-in document: just
 * enough of one for the script's top level, with timers run by hand.
 */
describe('the scan reload', () => {
    const start = (open: { dialog?: boolean; details?: boolean } = {}) => {
        const listeners: Record<string, ((e: unknown) => void)[]> = {};
        const timers: { fn: () => void; ms: number }[] = [];
        const paused = { hidden: true };
        const state = { dialog: open.dialog === true, details: open.details === true };
        const document = {
            addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn),
            getElementById: () => null,
            // The dashboard fill-in asks for its rows at the top level. This
            // page is not the dashboard, so there are none.
            querySelectorAll: () => [],
            querySelector: (sel: string) => {
                if (sel === '[data-reload]') return { dataset: { reload: '2' } };
                if (sel === '[data-paused]') return paused;
                if (sel === 'dialog[open], details[open]') return state.dialog || state.details ? {} : null;
                return null;
            }
        };
        const location = { reload: vi.fn() };
        const setTimeout = (fn: () => void, ms: number) => timers.push({ fn, ms });
        new Function('document', 'location', 'setTimeout', JS)(document, location, setTimeout);
        const tick = () => timers.shift()?.fn();
        const fire = (type: string) => (listeners[type] ?? []).forEach(fn => fn({ target: {} }));
        return { location, timers, tick, fire, paused, state };
    };

    it('reloads after about two seconds when nothing is open or edited', () => {
        const page = start();
        expect(page.timers[0]?.ms).toBe(2000);
        page.tick();
        expect(page.location.reload).toHaveBeenCalledTimes(1);
    });

    it('waits while a dialog or a card is open, says so, and reloads once it closes', () => {
        const page = start({ dialog: true });
        page.tick();
        expect(page.location.reload).not.toHaveBeenCalled();
        expect(page.paused.hidden).toBe(false);
        page.state.dialog = false;
        page.state.details = true;
        page.tick();
        expect(page.location.reload).not.toHaveBeenCalled();
        page.state.details = false;
        page.tick();
        expect(page.location.reload).toHaveBeenCalledTimes(1);
    });

    it('never reloads once a field has been edited', () => {
        const page = start();
        page.fire('input');
        page.tick();
        page.tick();
        expect(page.location.reload).not.toHaveBeenCalled();
        expect(page.paused.hidden).toBe(false);
    });
});

/**
 * The dashboard filling itself in, run against a stand-in document: enough of
 * one for the script's top level, with the rows and the counts it reaches for.
 */
describe('the dashboard fill-in', () => {
    type Stub = {
        tagName: string;
        className: string;
        textContent: string;
        dataset: Record<string, string>;
        children: Stub[];
        gone: boolean;
        style: Record<string, string>;
        append: (...kids: Stub[]) => void;
        appendChild: (kid: Stub) => Stub;
        replaceChildren: (...kids: Stub[]) => void;
        remove: () => void;
        setAttribute: (name: string, value: string) => void;
        querySelector: (sel: string) => Stub | null;
    };

    const node = (tagName = 'div'): Stub => {
        const self: Stub = {
            tagName,
            className: '',
            textContent: '',
            dataset: {},
            children: [],
            gone: false,
            style: {},
            append: (...kids) => void self.children.push(...kids),
            appendChild: kid => {
                self.children.push(kid);
                return kid;
            },
            replaceChildren: (...kids) => void (self.children = kids),
            remove: () => void (self.gone = true),
            setAttribute: (name, value) => void (self.style[name] = value),
            querySelector: () => null
        };
        return self;
    };

    /** A pending row, with the four things the script writes into. */
    const rowStub = (id: string) => {
        const cells = { version: node('td'), latency: node('td'), pill: node('span'), label: node('span') };
        const row = node('tr');
        row.dataset.healthFor = id;
        const map: Record<string, Stub> = {
            '[data-cell="version"]': cells.version,
            '[data-cell="latency"]': cells.latency,
            '[data-cell="status"] .st': cells.pill,
            '[data-cell="status"] [data-label]': cells.label
        };
        row.querySelector = sel => map[sel] ?? null;
        return { row, cells };
    };

    const viewOf = (over: Record<string, unknown> = {}) => ({
        service: 'radarr',
        ok: true,
        status: 'Up',
        version: '5.14.0',
        latency: '48 ms',
        failures: [],
        disks: [],
        scans: [],
        ...over
    });

    const start = (answer: (id: string) => { status: number; body?: unknown; hold?: boolean }, ids = ['radarr', 'sonarr']) => {
        const rows = ids.map(rowStub);
        const boxes = { alerts: node('section'), disks: node('div'), scans: node('div') };
        const counts = {
            servicesValue: node('span'),
            servicesSub: node('span'),
            healthValue: node('span'),
            healthSub: node('span')
        };
        const empties = { alerts: node('p'), disks: node('p'), scans: node('p') };
        boxes.alerts.querySelector = sel => (sel === '[data-empty]' ? empties.alerts : null);
        boxes.disks.querySelector = sel => (sel === '[data-empty]' ? empties.disks : null);
        boxes.scans.querySelector = sel => (sel === '[data-empty]' ? empties.scans : null);

        const found: Record<string, Stub> = {
            '[data-alerts]': boxes.alerts,
            '[data-disks]': boxes.disks,
            '[data-scans]': boxes.scans,
            '[data-stat="services"] .stat-v': counts.servicesValue,
            '[data-stat="services"] .stat-s': counts.servicesSub,
            '[data-stat="health"] .stat-v': counts.healthValue,
            '[data-stat="health"] .stat-s': counts.healthSub
        };

        const asked: string[] = [];
        const document = {
            addEventListener: () => {},
            getElementById: () => null,
            createElement: (tag: string) => node(tag),
            createTextNode: (text: string) => {
                const n = node('#text');
                n.textContent = text;
                return n;
            },
            querySelector: (sel: string) => found[sel] ?? null,
            querySelectorAll: (sel: string) => (sel === '[data-health-for]' ? rows.map(r => r.row) : [])
        };
        const fetch = async (url: string) => {
            const id = decodeURIComponent(String(url).split('instance=')[1] ?? '');
            asked.push(id);
            const { status, body, hold } = answer(id);
            if (hold === true) await new Promise(() => {});
            return { ok: status >= 200 && status < 300, status, json: async () => body };
        };

        new Function('document', 'location', 'setTimeout', 'fetch', JS)(document, { reload: () => {} }, setTimeout, fetch);
        return { rows, boxes, counts, empties, asked };
    };

    it('settles each row from its own answer', async () => {
        const page = start(id => ({
            status: 200,
            body: { view: viewOf(id === 'sonarr' ? { service: 'sonarr', version: '4.0.1', latency: '12 ms' } : {}) }
        }));

        await vi.waitFor(() => expect(page.rows[1]?.cells.version.textContent).toBe('4.0.1'));
        expect(page.rows[0]?.cells.version.textContent).toBe('5.14.0');
        expect(page.rows[0]?.cells.latency.textContent).toBe('48 ms');
        expect(page.rows[0]?.cells.label.textContent).toBe('Up');
        expect(page.rows[0]?.cells.pill.className).toBe('st ok');
        expect(page.asked).toEqual(['radarr', 'sonarr']);
    });

    it('counts the services that answered, and says how many are still out', async () => {
        const page = start(id =>
            id === 'sonarr' ? { status: 200, hold: true } : { status: 200, body: { view: viewOf() } }
        );

        await vi.waitFor(() => expect(page.counts.servicesSub.textContent).toBe('1 still checking'));
        expect(page.counts.servicesValue.children.length).toBeGreaterThan(0);
    });

    it('shows a service that answered badly as what it answered, not as up', async () => {
        const page = start(() => ({
            status: 200,
            body: { view: viewOf({ ok: false, status: 'Timeout', version: '', latency: '10000 ms', alert: { label: 'Timeout', what: 'radarr', detail: 'no answer', fix: 'Check the address.' } }) }
        }));

        await vi.waitFor(() => expect(page.rows[0]?.cells.pill.className).toBe('st bad'));
        expect(page.rows[0]?.cells.label.textContent).toBe('Timeout');
        expect(page.boxes.alerts.children.length).toBeGreaterThan(0);
        expect(page.empties.alerts.gone).toBe(true);
    });

    // A service edited away between the render and the fetch. Leaving the row
    // spinning for ever would be a worse answer than saying so.
    it('marks a row whose service is gone as unknown rather than leaving it spinning', async () => {
        const page = start(() => ({ status: 404, body: { error: 'unknown instance' } }));

        await vi.waitFor(() => expect(page.rows[0]?.cells.label.textContent).toBe('Unknown'));
        expect(page.rows[0]?.cells.pill.className).toBe('st');
    });

    // Eight rows against four lanes: the four in flight have been asked, and a
    // 401 has to stop the four that have not. Every one of them would answer
    // the same way, and a signed-out dashboard should not ask eight times.
    it('stops asking once a row comes back unauthorized', async () => {
        const ids = ['radarr', 'sonarr', 'lidarr', 'bazarr', 'prowlarr', 'seerr', 'jellyfin', 'sabnzbd'];
        const page = start(() => ({ status: 401, body: { error: 'unauthorized' } }), ids);

        await vi.waitFor(() => expect(page.asked.length).toBe(4));
        expect(page.asked).toEqual(ids.slice(0, 4));
        expect(page.rows[7]?.cells.label.textContent).toBe('');
    });

    it('appends the disk and scan rows a service reports', async () => {
        const page = start(id => ({
            status: 200,
            body: {
                view: viewOf(
                    id === 'radarr'
                        ? { disks: [{ free: '500 GB free', total: 'of 1 TB', pct: 50, warn: false, services: 'radarr' }], scans: [{ badge: 'running', service: 'radarr', time: 'unknown' }] }
                        : {}
                )
            }
        }));

        await vi.waitFor(() => expect(page.boxes.disks.children.length).toBe(1));
        expect(page.boxes.scans.children.length).toBe(1);
        expect(page.empties.disks.gone).toBe(true);
        expect(page.empties.scans.gone).toBe(true);
    });
});

/**
 * One row's health as the strings it will show. Prepared on the server for the
 * same reason `logRowView` is: the table the server renders and the one app.js
 * fills in must not come to disagree about what a row says.
 */
describe('healthRowView', () => {
    const empty = { disks: [], failures: [], scans: [] };

    it('prepares what a reachable row shows', () => {
        const view = healthRowView({
            diagnosis: { ok: true, service: 'radarr', latency_ms: 48, version: '5.14.0' },
            ...empty
        });
        expect(view).toMatchObject({ service: 'radarr', ok: true, status: 'Up', version: '5.14.0', latency: '48 ms' });
        expect(view.alert).toBeUndefined();
    });

    // 'Down' would be a lie for a service that answered the wrong thing, and
    // the kind is the word the server-rendered table already uses.
    it('names the failure kind and carries the detail and the remedy', () => {
        const view = healthRowView({
            diagnosis: {
                ok: false,
                service: 'radarr',
                latency_ms: 10_000,
                error: { kind: 'Timeout', detail: 'no response from radarr', remedy: 'Check the address.' }
            },
            ...empty
        });
        expect(view.status).toBe('Timeout');
        expect(view.version).toBe('');
        expect(view.alert).toMatchObject({ label: 'Timeout', what: 'radarr', detail: 'no response from radarr', fix: 'Check the address.' });
    });

    it('works out the share of a disk that is used, and flags a full one', () => {
        const view = healthRowView({
            diagnosis: { ok: true, service: 'radarr', latency_ms: 1 },
            disks: [
                { freeSpace: 500, totalSpace: 1000, services: ['radarr', 'sonarr'], mounts: ['/data'] },
                { freeSpace: 10, totalSpace: 1000, services: ['radarr'], mounts: ['/full'] },
                { freeSpace: 42, services: ['radarr'], mounts: ['/unknown'] }
            ],
            failures: [],
            scans: []
        });
        expect(view.disks[0]).toMatchObject({ pct: 50, warn: false, services: 'radarr, sonarr' });
        expect(view.disks[1]).toMatchObject({ pct: 99, warn: true });
        expect(view.disks[2]).toMatchObject({ pct: undefined, total: '' });
    });

    it('sorts a failing health check into an error or a warning', () => {
        const view = healthRowView({
            diagnosis: { ok: true, service: 'radarr', latency_ms: 1 },
            disks: [],
            failures: [
                { service: 'radarr', source: 'ImportListStatusCheck', type: 'error', message: 'List unavailable' },
                { service: 'radarr', source: 'UpdateCheck', type: 'warning', message: 'New version' }
            ],
            scans: []
        });
        expect(view.failures[0]).toMatchObject({ sev: 'bad', label: 'Error', source: 'ImportListStatusCheck', message: 'List unavailable' });
        expect(view.failures[1]).toMatchObject({ sev: 'warn', label: 'Warn' });
    });

    it('says whether a scan is running and when it last finished', () => {
        const view = healthRowView({
            diagnosis: { ok: true, service: 'radarr', latency_ms: 1 },
            disks: [],
            failures: [],
            scans: [
                { service: 'radarr', running: true, lastCompleted: '2026-11-15T10:00:00.000Z' },
                { service: 'sonarr' }
            ]
        });
        expect(view.scans[0]).toMatchObject({ badge: 'running', service: 'radarr', time: '2026-11-15 10:00:00' });
        expect(view.scans[1]).toMatchObject({ badge: 'done', time: 'unknown' });
    });
});
