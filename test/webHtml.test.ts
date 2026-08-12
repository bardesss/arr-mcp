import { describe, expect, it } from 'vitest';
import type { DiskSpace } from '../src/services/types.ts';
import { JS } from '../src/web/assets.ts';
import { esc, html, humanBytes, raw, shortTime } from '../src/web/html.ts';
import { auditPage, groupDisks, loginPage, type AuditRow } from '../src/web/pages.ts';

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
        const fenced = '<<untrusted:radarr.title>>Alien<</untrusted>>';
        expect(html`<td>${fenced}</td>`.value).toBe(
            '<td>&lt;&lt;untrusted:radarr.title&gt;&gt;Alien&lt;&lt;/untrusted&gt;&gt;</td>'
        );
    });
});

describe('formatting helpers', () => {
    it('scales bytes to something a person reads', () => {
        expect(humanBytes(0)).toBe('0 B');
        expect(humanBytes(1024)).toBe('1.0 KB');
        expect(humanBytes(25_900_000_000)).toBe('24.1 GB');
    });

    it('reports unknown sizes as unknown rather than as zero', () => {
        expect(humanBytes(undefined)).toBe('—');
        expect(humanBytes(Number.NaN)).toBe('—');
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
        at: '2026-08-12T14:03:11.000Z',
        tool: 'delete_media',
        service: 'radarr/4k',
        operation: 'delete',
        tier: 'destructive',
        target: '1535',
        args: '{"id":"1535","delete_files":true}',
        outcome: 'applied',
        detail: null,
        ...over
    });

    it('renders each recorded argument as its own field', () => {
        const page = auditPage({ version: '1.4.1', rows: [row()] });

        expect(page).toContain('<dt class="mono">delete_files</dt>');
        expect(page).toContain('<dd class="mono">true</dd>');
        // The blob it is stored as never reaches the page.
        expect(page).not.toContain('{&quot;id&quot;');
    });

    it('shows arguments that do not parse verbatim rather than dropping them', () => {
        const page = auditPage({ version: '1.4.1', rows: [row({ args: 'not json at all' })] });
        expect(page).toContain('not json at all');
    });

    // A log's value is that nothing goes missing from it, so a shape nobody
    // expected is a reason to print it, not to skip the row.
    it('survives arguments that are valid JSON but not an object', () => {
        const page = auditPage({ version: '1.4.1', rows: [row({ args: '[1,2]' })] });
        expect(page).toContain('[1,2]');
        expect(page).toContain('delete_media');
    });

    it('marks the outcomes worth stopping on, and leaves a preview unmarked', () => {
        const marked = auditPage({ version: '1.4.1', rows: [row({ outcome: 'failed' })] });
        expect(marked).toContain('<span class="badge failed">failed</span>');

        const plain = auditPage({ version: '1.4.1', rows: [row({ outcome: 'unconfirmed' })] });
        expect(plain).toContain('<span class="badge unconfirmed">unconfirmed</span>');
    });

    it('escapes a detail the service handed back', () => {
        const page = auditPage({
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
