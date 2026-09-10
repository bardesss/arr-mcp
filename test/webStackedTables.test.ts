import { describe, expect, it } from 'vitest';
import type { HealthCheck } from '../src/services/types.ts';
import type { LogRow } from '../src/core/logs.ts';
import { CSS, JS } from '../src/web/assets.ts';
import { dashboardPage, logTable } from '../src/web/pages.ts';

const ROWS: LogRow[] = [
    {
        id: 1,
        at: '2026-09-10T02:01:23.975Z',
        level: 30,
        levelName: 'info',
        service: null,
        msg: 'arr-mcp listening — open the config UI at http://<host>:6060',
        fields: JSON.stringify({ port: 6060 })
    },
    {
        id: 2,
        at: '2026-09-09T05:41:34.365Z',
        level: 40,
        levelName: 'warn',
        service: 'seerr',
        msg: 'source failed; degrading rather than failing',
        fields: JSON.stringify({ 'err.kind': 'UpstreamError' })
    }
];

const FAILURES: HealthCheck[] = [
    {
        service: 'sonarr',
        source: 'health',
        type: 'IndexerStatusCheck',
        message: 'Indexers unavailable due to failures for more than 6 hours'
    }
];

const dashboard = (failures: HealthCheck[]): string =>
    dashboardPage({
        csrf: 'test',
        version: '0.0.0-test',
        diagnoses: [],
        configured: [],
        bearerToken: 'x'.repeat(64),
        urlToken: false,
        writeCounts: { applied: 0, denied: 0, total: 0 },
        disks: [{ service: 'sonarr', label: '/data', freeSpace: 1, totalSpace: 2 }],
        failures,
        scans: [{ service: 'sonarr', running: false, lastCompleted: '2026-09-09T05:00:00Z' }]
    });

/**
 * Which tables stack on a phone, and which deliberately do not.
 *
 * A four-column table whose last column is prose has no readable width: at
 * 375px the three narrow headers wrap letter by letter ("Le/ve/l"). The write
 * audit already answered this by abandoning the table for cards; `.stacked` is
 * that answer applied to the two tables that still need it, and the class is
 * what the `max-width: 700px` block keys on.
 *
 * The opt-in is the point. Three short columns read fine on a phone and are
 * worse as cards, so a blanket `table` rule would be a regression for them.
 */
describe('stacked tables', () => {
    it('marks the log table, whose message column is prose', () => {
        expect(logTable(ROWS).value).toContain('<table class="stacked">');
    });

    it('marks the dashboard problems table, which has the same shape', () => {
        expect(dashboard(FAILURES)).toContain('<table class="stacked">');
    });

    // Disks and scans are three short columns each. If a later edit stacks
    // every table, this is what says that was not the deal.
    it('leaves the short tables alone', () => {
        const plain = dashboard([]);
        expect(plain).toContain('<table>');
        expect(plain).not.toContain('stacked');
    });

    /**
     * The live refresh rebuilds the same table client-side with createElement
     * (see `render` in assets.ts), so the class exists in two renderers that
     * share no code. Drift between them shows up only on a phone, only after
     * the first auto-refresh tick — which is to say, never, in review.
     */
    it('sets the class on the client-rebuilt table too', () => {
        expect(JS).toContain("table.className = 'stacked'");
    });

    it('styles the class only under the small-screen breakpoint', () => {
        const small = CSS.slice(CSS.indexOf('@media (max-width: 700px)'));
        expect(small).toContain('.stacked');
        expect(CSS.slice(0, CSS.indexOf('@media (max-width: 700px)'))).not.toContain('.stacked');
    });
});
