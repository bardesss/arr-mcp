import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WhisparrAdapter } from '../src/services/whisparr.ts';

/**
 * Whisparr reads logs, history, download traces and running commands through
 * Sonarr's helpers without a Whisparr capture. That is only allowed while the
 * two specs agree on everything those helpers read; when they stop agreeing,
 * re-capture Whisparr or unclaim the capability.
 */
type Schema = { properties?: Record<string, { type?: string; $ref?: string; items?: unknown }>; enum?: unknown[] };
type Spec = { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, Schema> } };

const load = (name: string): Spec => JSON.parse(readFileSync(new URL(`../specs/${name}.json`, import.meta.url), 'utf8')) as Spec;
const sonarr = load('sonarr');
const whisparr = load('whisparr');
/**
 * Swashbuckle documents a .NET TimeSpan as an object in Whisparr's spec and as a
 * "date-span" string in Sonarr's; it is one JSON string either way, and no
 * Sonarr helper reads `duration`.
 */
const SPEC_ARTEFACTS = new Set(['CommandResource.duration']);
const FIX = 're-capture Whisparr or unclaim the capability';

describe('Whisparr inherits Sonarr helpers only while the specs agree', () => {
    it.each([
        'LogResource',
        'LogResourcePagingResource',
        'HistoryResource',
        'HistoryResourcePagingResource',
        'CommandResource',
        // arrHistory reads `quality.quality.name`.
        'QualityModel',
        'Quality'
    ])(
        "%s matches Sonarr's, so Whisparr inherits its helper",
        name => {
            const a = sonarr.components.schemas[name]?.properties;
            const b = whisparr.components.schemas[name]?.properties;
            expect(Object.keys(a ?? {}).length, `Sonarr has no ${name}`).toBeGreaterThan(0);
            expect(b, `Whisparr has no ${name}: ${FIX}`).toBeDefined();
            if (a === undefined || b === undefined) return;
            expect(Object.keys(b).sort(), `${name} has different fields: ${FIX}`).toEqual(Object.keys(a).sort());
            for (const key of Object.keys(a).filter(k => !SPEC_ARTEFACTS.has(`${name}.${k}`))) {
                const shape = (p: (typeof a)[string]) => ({ type: p.type, $ref: p.$ref, items: p.items });
                expect(shape(b[key]!), `${name}.${key} changed: ${FIX}`).toEqual(shape(a[key]!));
            }
        }
    );

    it("EpisodeHistoryEventType has Sonarr's values", () => {
        const values = (s: Spec) => s.components.schemas['EpisodeHistoryEventType']?.enum;
        expect(values(whisparr), `event types differ: ${FIX}`).toEqual(values(sonarr));
        expect(values(sonarr)?.length).toBeGreaterThan(0);
    });

    it.each(['/api/v3/log', '/api/v3/history', '/api/v3/history/since', '/api/v3/history/series', '/api/v3/command'])(
        '%s is a GET in both specs',
        path => {
            expect(sonarr.paths[path]?.['get'], `Sonarr lost ${path}`).toBeDefined();
            expect(whisparr.paths[path]?.['get'], `Whisparr has no GET ${path}: ${FIX}`).toBeDefined();
        }
    );

    /**
     * Matching response shapes is not enough: ASP.NET drops a query parameter
     * an endpoint does not bind, so a filter Whisparr does not know comes back
     * as an unfiltered answer, not an error. Every request the inherited reads
     * make is recorded here and checked against Whisparr's own spec.
     */
    it('sends Whisparr only query parameters its spec binds, with values of the bound type', async () => {
        const sent: URL[] = [];
        const grab = { id: 2, eventType: 'grabbed', date: '2026-10-02T10:00:00Z', seriesId: 3, episodeId: 7, sourceTitle: 'New', downloadId: 'def' };
        const failed = { id: 1, eventType: 'downloadFailed', date: '2026-10-01T10:00:00Z', seriesId: 3, episodeId: 7, sourceTitle: 'Old', downloadId: 'abc' };
        const fake = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            sent.push(url);
            const routes: Record<string, unknown> = {
                '/api/v3/log': { records: [], totalRecords: 0 },
                '/api/v3/history': { records: [url.searchParams.get('downloadId') === 'abc' ? failed : grab], totalRecords: 1 },
                '/api/v3/history/series': [grab, failed],
                '/api/v3/command': []
            };
            const body = routes[url.pathname];
            return new Response(JSON.stringify(body ?? { message: 'not found' }), {
                status: body === undefined ? 404 : 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as unknown as typeof fetch;
        const w = new WhisparrAdapter(
            { url: 'http://whisparr:6969', api_key: 'k', timeout_ms: 10_000, permissions: { safe_write: false, destructive: false } },
            fake
        );

        await w.getRecentLogs();
        await w.readHistory({ want: 10 });
        await w.readHistory({ eventType: 'grabbed', want: 10 });
        await w.readHistory({ since: '2026-01-01T00:00:00Z' });
        await w.readHistory({ id: '3', want: 10 });
        await w.readHistory({ id: '3', eventType: 'failed', since: '2026-01-01T00:00:00Z' });
        expect((await w.traceDownload('abc'))?.replacement?.grabbedAt).toBe(grab.date);
        await w.listCommands();

        type Param = { name: string; in: string; schema?: { type?: string } };
        for (const url of sent) {
            const get = whisparr.paths[url.pathname]?.['get'] as { parameters?: Param[] } | undefined;
            expect(get, `Whisparr has no GET ${url.pathname}: ${FIX}`).toBeDefined();
            const bound = new Map((get?.parameters ?? []).filter(p => p.in === 'query').map(p => [p.name, p.schema?.type]));
            for (const [name, value] of url.searchParams) {
                expect(bound.has(name), `Whisparr's GET ${url.pathname} does not bind ${name}: ${FIX}`).toBe(true);
                if (bound.get(name) === 'integer') expect(value, `${url.pathname} ${name}`).toMatch(/^-?\d+$/);
            }
        }
        // The id-scoped reads were exercised, not skipped.
        expect(sent.some(u => u.pathname === '/api/v3/history/series')).toBe(true);
    });
});
